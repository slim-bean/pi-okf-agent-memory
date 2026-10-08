/** Local OKF memory tools plus an explicit, ordered upgrade-review workflow. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryVersion, requireCurrentContract, resolveKnowledgeDir, resolveOkfBin as locateBinary, runOkf, supportsCurrentContract, validateBundle } from "./lib/okf.js";
import { registerUpgrades } from "./lib/upgrade-extension.js";
import { registerSetup } from "./lib/setup-extension.js";
import { registerMemoryMaintenance } from "./lib/maintenance.js";
import { binaryDiagnostics, formatBinaryDiagnostics, requireOkfBin } from "./lib/diagnostics.js";

const EXT_FILE = fileURLToPath(import.meta.url);
const EXT_DIR = dirname(EXT_FILE);
const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(EXT_DIR, "package.json"), "utf8")).version;
// Package installs keep skills beside index.ts; install.sh places them in .pi/skills.
const SKILLS_DIR = existsSync(join(EXT_DIR, "skills")) ? join(EXT_DIR, "skills") : join(EXT_DIR, "..", "..", "skills");
export function resolveOkfBin(): string | null { return locateBinary(EXT_DIR); }

function fit(text: string): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return t.truncated ? `${t.content}\n\n[Truncated to ${t.outputLines} of ${t.totalLines} lines.]` : t.content;
}

const REVIEW_PROMPT = `Perform a knowledge review of this session using the okf-memory skill:
1. Did we learn durable rationale, make a decision, or invalidate an assumption?
2. Apply the re-derivation test. Do not store what git, runbooks, or workflow logs already record, or what a future agent can re-derive in about two minutes.
3. Search before writing; update rather than duplicate.
4. Use the resolved OKF executable for warranted writes. Preserve parent index listings and root navigation, then run memory_validate. Do not claim successful persistence unless its ok field is true.
5. Most reviews end with "nothing worth storing". Do not manufacture entries.
Pending package upgrades are a separate, user-approved /memory-upgrade workflow; do not silently perform them during this review.`;

export default function okfMemoryExtension(pi: ExtensionAPI) {
	let workspace = process.cwd();
	pi.on("session_start", (_event, ctx) => { workspace = ctx.cwd; });
	pi.registerCommand("memory-diagnostics", {
		description: "Show loaded package, binary lookup and resource settings paths (read-only)",
		handler: async (_args, ctx) => {
			const text = formatBinaryDiagnostics(binaryDiagnostics(EXT_FILE, ctx.cwd));
			ctx.ui.notify(text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""), "info");
		},
	});
	function requireKnowledge(cwd: string): string {
		const dir = resolveKnowledgeDir(cwd);
		if (!dir) throw new Error(`No OKF knowledge bundle found. Run /memory-setup or request explicit host setup for ${join(cwd, "knowledge")}; OKF_KNOWLEDGE_DIR can select another bundle.`);
		return dir;
	}
	function requireBin(cwd = workspace): string { return requireOkfBin(EXT_FILE, cwd); }

	let upgrades: ReturnType<typeof registerUpgrades> | undefined;
	const setup = registerSetup(pi, { packageVersion: PACKAGE_VERSION, getBinary: requireBin,
		busy: () => upgrades?.busy ?? false, onReady: ctx => { upgrades?.refresh(ctx); } });
	upgrades = registerUpgrades(pi, { skillsDir: SKILLS_DIR, packageVersion: PACKAGE_VERSION, getBinary: requireBin, getBundle: resolveKnowledgeDir,
		setupBusy: () => setup.active, requireSetup: setup.requireReady });
	const maintenance = registerMemoryMaintenance(pi, { packageVersion: PACKAGE_VERSION, skillsDir: SKILLS_DIR,
		getBinary: requireBin, busy: () => setup.active || (upgrades?.busy ?? false) });
	pi.on("session_shutdown", async () => { await maintenance.stop(); });

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Search persistent project memory by text, or use for_path to discover decisions governing a source path via code_refs. Path results rank hold before constraint before context. Search before substantial work and before writing new memory.",
		promptSnippet: "Search persistent project knowledge and code-path constraints",
		promptGuidelines: ["Use memory_search before substantial tasks and before writing memory. Before editing a subsystem, use for_path to discover applicable constraints and holds."],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Free-text query; optional when for_path is supplied" })),
			for_path: Type.Optional(Type.String({ description: "Project-relative source path, e.g. src/auth/session.ts" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const binary = requireBin(ctx.cwd);
			const query = params.query?.trim();
			const path = params.for_path?.trim();
			if (!query && !path) throw new Error("Supply query or for_path.");
			// Upstream parses leading '-' as flags and the exact word 'help' as a
			// help request even in query position. Never pass tool input as options.
			if (query && (query.startsWith("-") || query === "help")) throw new Error("This OKF CLI cannot search a query starting with '-' or the exact word 'help'; use more specific search terms.");
			if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) throw new Error("limit must be an integer from 1 to 100.");
			if (path) requireCurrentContract(binary);
			const args = ["search", ...(query ? [query] : []), dir, "--json", `--limit=${params.limit ?? 10}`, ...(path ? [`--for-path=${path}`] : [])];
			return { content: [{ type: "text", text: fit(runOkf(binary, args).stdout) }], details: { query, for_path: path } };
		},
	});

	pi.registerTool({
		name: "memory_show",
		label: "Memory Show",
		description: "Show a concept's full body, provenance, lifecycle, governance and code_refs after memory_search identifies it.",
		parameters: Type.Object({ concept: Type.String({ description: "Concept ID without .md, e.g. decisions/storage" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const concept = params.concept.replace(/\.md$/, "");
			if (!concept || concept.startsWith("-") || concept === "help") throw new Error("Supply a concept ID, not a CLI flag/help request.");
			return { content: [{ type: "text", text: fit(runOkf(requireBin(ctx.cwd), ["show", concept, dir, "--json"]).stdout) }], details: { concept } };
		},
	});

	pi.registerTool({
		name: "memory_validate",
		label: "Memory Validate",
		description: "Validate conformance, trust, index/code-reference drift and staleness. ok:true requires a supported binary and zero blocking findings. Isolated concepts are advisory by default; orphanPolicy:strict requires semantic relationships. Never invent links to pass validation. Failed checks and advisories remain inspectable.",
		parameters: Type.Object({ orphanPolicy: Type.Optional(Type.Union([Type.Literal("advisory"), Type.Literal("strict")])) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const binary = requireBin(ctx.cwd);
			const version = binaryVersion(binary);
			const compatible = supportsCurrentContract(version);
			const result = validateBundle(binary, dir, params.orphanPolicy);
			const details = { ...result, ok: compatible && result.ok, compatible, version, dir };
			return { content: [{ type: "text", text: fit(JSON.stringify(details, null, 2)) }], details };
		},
	});

	pi.registerCommand("memory-context", {
		description: "Inject the OKF knowledge index into context",
		handler: async (_args, ctx) => {
			const dir = requireKnowledge(ctx.cwd);
			pi.sendMessage({ customType: "okf-memory", content: `Persistent project knowledge index (${dir}):\n\n${fit(readFileSync(join(dir, "index.md"), "utf8"))}`, display: true }, { deliverAs: "nextTurn" });
			if (ctx.hasUI) ctx.ui.notify("Knowledge index queued for next turn", "info");
		},
	});
	pi.registerCommand("knowledge-review", {
		description: "Review durable lessons from this session (not package upgrades)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Wait until the agent is idle before starting a knowledge review.", "warning");
				return;
			}
			pi.sendUserMessage(`${REVIEW_PROMPT}\nResolved OKF executable: ${JSON.stringify(requireBin(ctx.cwd))}. Bundle: ${JSON.stringify(requireKnowledge(ctx.cwd))}. Use these exact paths, shell-quoted.`);
		},
	});

	pi.on("session_start", (event, ctx) => {
		// The independent upgrade hook checks EVERY start, including reload.
		if (event.reason === "reload") return;
		try {
			const dir = resolveKnowledgeDir(ctx.cwd);
			if (!dir) {
				if (event.reason !== "startup" && ctx.hasUI) ctx.ui.notify("No knowledge bundle found. Run /memory-setup or request explicit host setup.", "info");
				return;
			}
			const binary = resolveOkfBin();
			let count: number | undefined;
			try { if (binary) count = validateBundle(binary, dir).validation.concept_count; }
			catch { /* Do not label an unreadable or unindexed corpus empty. */ }
			const discipline = "Knowledge records only WHY; git records what and runbooks record how. Search before writing, apply the two-minute re-derivation test, and run memory_validate after warranted changes. Most reviews need no writes.";
			const content = count === 0
				? `[okf-memory] A knowledge corpus exists at ${dir} but has no concepts yet. That is fine: do not seed it merely to fill it. Record project purpose/constraints only when learned and durable. ${discipline}`
				: `[okf-memory] Persistent project knowledge at ${dir}${count === undefined ? "" : ` (${count} concepts)`}. Consult memory_search / memory_show for prior decisions, constraints and lessons. ${discipline}\nIndex (nested concepts may live in directory indexes):\n\n${fit(readFileSync(join(dir, "index.md"), "utf8"))}`;
			pi.sendMessage({ customType: "okf-memory", content: `${content}\n\nResolved OKF executable: ${JSON.stringify(binary)}. Use this exact path, shell-quoted; it may not be on PATH.`, display: true }, { deliverAs: "nextTurn" });
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`Memory context unavailable: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	});
}
