/**
 * okf-memory: pi extension that wires an OKF v0.2 knowledge corpus
 * (https://github.com/okf-memory/okf-agent-memory) into pi sessions.
 *
 * Provides:
 *  - memory_search   tool: BM25 search over the corpus (wraps `okf search --json`)
 *  - memory_show     tool: full concept details (wraps `okf show --json`)
 *  - memory_validate tool: bundle conformance + drift + staleness check
 *  - /memory-context      command: inject the corpus index now
 *  - /knowledge-review    command: run the convention's post-task knowledge review
 *  - session_start injection: on new/resume/fork, the root index.md is queued
 *    into context so a fresh (or compacted) session immediately knows the
 *    project's durable state.
 *
 * Configuration (all optional):
 *  - OKF_BIN            path to the okf binary (default: <this dir>/bin/okf, then PATH)
 *  - OKF_KNOWLEDGE_DIR  path to the OKF bundle (default: <cwd>/knowledge, then /workspace/knowledge)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

/** Locate the okf binary: $OKF_BIN, sibling bin/okf, then PATH. */
function resolveOkfBin(): string | null {
	if (process.env.OKF_BIN && existsSync(process.env.OKF_BIN)) return process.env.OKF_BIN;
	const sibling = join(EXT_DIR, "bin", "okf");
	if (existsSync(sibling)) return sibling;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, "okf");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Locate the knowledge bundle: $OKF_KNOWLEDGE_DIR, <cwd>/knowledge, and for
 * /workspace-rooted sessions (e.g. yono sandboxes) the shared /workspace/knowledge. */
function resolveKnowledgeDir(cwd: string): string | null {
	const candidates = [
		process.env.OKF_KNOWLEDGE_DIR,
		join(cwd, "knowledge"),
		...(cwd === "/workspace" || cwd.startsWith("/workspace/") ? ["/workspace/knowledge"] : []),
	].filter((p): p is string => Boolean(p));
	for (const dir of candidates) {
		if (existsSync(join(dir, "index.md"))) return dir;
	}
	return null;
}

/** Run okf and return stdout; throws with a readable message on failure. */
function runOkf(okfBin: string, args: string[]): string {
	try {
		return execFileSync(okfBin, args, {
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`okf ${args.join(" ")} failed: ${detail}`);
	}
}

/** Truncate tool output to pi's built-in limits, noting the overflow. */
function fit(text: string): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return t.truncated
		? `${t.content}\n\n[Truncated to ${t.outputLines} of ${t.totalLines} lines.]`
		: t.content;
}

const REVIEW_PROMPT = `Perform a knowledge review of this session per the OKF Agent Memory Convention (see the okf-memory skill):

1. What did I learn? What changed? Did I make a decision, discover something non-obvious, or invalidate an existing assumption?
2. For each candidate: apply the re-derivation test — would a future agent benefit, or could they re-derive it in ~2 minutes? Would git/runbooks/workflow logs already record it? If yes to the latter, do NOT store it.
3. Search before write: use memory_search to check for an existing concept; update rather than duplicate.
4. Make any warranted writes with the okf CLI (create/update/relate), keep the root index.md listings in sync, then run memory_validate and report the result.
5. Most reviews end with "nothing worth storing" — that is a valid outcome. Report it honestly rather than manufacturing entries.`;

export default function okfMemoryExtension(pi: ExtensionAPI) {
	const okfBin = resolveOkfBin();

	// Resolve the bundle lazily per call: cwd may change between sessions.
	function requireKnowledge(cwd: string): string {
		const dir = resolveKnowledgeDir(cwd);
		if (!dir) {
			throw new Error(
				`No OKF knowledge bundle found (looked at $OKF_KNOWLEDGE_DIR, ${join(cwd, "knowledge")}, /workspace/knowledge). ` +
					`Initialize one with: okf init <dir>`,
			);
		}
		return dir;
	}

	function requireBin(): string {
		if (!okfBin) {
			throw new Error(
				"okf binary not found. Set OKF_BIN, place it at bin/okf next to this extension, or put it on PATH. " +
					"Build: git clone https://github.com/okf-memory/okf-agent-memory && make build",
			);
		}
		return okfBin;
	}

	// ---------------------------------------------------------------- tools

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search the project's persistent OKF knowledge corpus (knowledge/) with in-memory BM25. " +
			"Returns matching concept ids, titles, types, descriptions and scores. Use BEFORE writing new memory, " +
			"and at the start of substantial tasks to check for prior decisions, constraints and incident lessons.",
		promptSnippet: "Search the persistent project knowledge corpus",
		promptGuidelines: [
			"Use memory_search at the start of substantial tasks to check persistent knowledge for relevant decisions, constraints and prior lessons, and always before adding new knowledge.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Free-text query, e.g. 'ingress timeout decision'" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const out = runOkf(requireBin(), ["search", params.query, dir, "--json"]);
			return { content: [{ type: "text", text: fit(out) }], details: { query: params.query } };
		},
	});

	pi.registerTool({
		name: "memory_show",
		label: "Memory Show",
		description:
			"Show a single concept from the persistent knowledge corpus: full body, frontmatter (type, sources, " +
			"generated/verified trust, status, stale_after) and links. Use after memory_search narrows down a concept id.",
		parameters: Type.Object({
			concept: Type.String({ description: "Concept id (file path without .md), e.g. 'decisions/pi-integration'" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const out = runOkf(requireBin(), ["show", params.concept.replace(/\.md$/, ""), dir, "--json"]);
			return { content: [{ type: "text", text: fit(out) }], details: { concept: params.concept } };
		},
	});

	pi.registerTool({
		name: "memory_validate",
		label: "Memory Validate",
		description:
			"Validate the OKF knowledge bundle: v0.2 conformance, graph connectivity (orphans/broken links), " +
			"index description drift, and expired stale_after dates. Run after any change to knowledge/; " +
			"never claim knowledge was persisted unless this passes.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const out = runOkf(requireBin(), ["validate", dir, "--strict", "--drift", "--stale"]);
			const ok = out.includes("Conformant") && !/error\(s\): [1-9]/.test(out);
			return {
				content: [{ type: "text", text: fit(out) }],
				details: { ok, dir },
			};
		},
	});

	// ------------------------------------------------------------- commands

	pi.registerCommand("memory-context", {
		description: "Inject the OKF knowledge index into context",
		handler: async (_args, ctx) => {
			const dir = resolveKnowledgeDir(ctx.cwd);
			if (!dir) {
				ctx.ui.notify?.("No OKF knowledge bundle found", "warning");
				return;
			}
			const index = readFileSync(join(dir, "index.md"), "utf8");
			pi.sendMessage(
				{
					customType: "okf-memory",
					content: `Persistent project knowledge index (${dir}):\n\n${index}`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify?.("Knowledge index queued for next turn", "info");
		},
	});

	pi.registerCommand("knowledge-review", {
		description: "Run the OKF knowledge review for this session",
		handler: async (_args, _ctx) => {
			pi.sendUserMessage(REVIEW_PROMPT);
		},
	});

	// -------------------------------------------------------- session hooks

	// On new/resume/fork (not startup/reload: AGENTS.md and the skill already
	// cover those), queue the corpus index so an amnesiac session immediately
	// sees the durable state. nextTurn = no turn is triggered; it rides along
	// with the user's next prompt.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload") return;
		const dir = resolveKnowledgeDir(ctx.cwd);
		if (!dir) return;
		try {
			const index = readFileSync(join(dir, "index.md"), "utf8");
			pi.sendMessage(
				{
					customType: "okf-memory",
					content:
						`[okf-memory] Persistent project knowledge corpus at ${dir} — consult it for prior decisions, ` +
						`constraints and lessons before substantive work (memory_search / memory_show). Index:\n\n${index}`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		} catch {
			// Non-fatal: knowledge injection is best-effort.
		}
	});
}
