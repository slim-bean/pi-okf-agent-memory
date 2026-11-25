/** Native project-memory tools, a usage-ranked session index, and an ordered upgrade workflow. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBundle, moveConcept, resolveKnowledgeDir, writeConcept } from "./lib/memory.js";
import { ID_PATTERN, loadConcepts, readConcept } from "./lib/store.js";
import { search, sections } from "./lib/search.js";
import { idleSessions, readUsage, recordUsage } from "./lib/usage.js";
import { isPinned, parseActive, refreshView, viewConfig } from "./lib/view.js";
import { registerUpgrades } from "./lib/upgrade-extension.js";
import type { UpgradeStep } from "./lib/upgrades.js";
import { registerSetup } from "./lib/setup-extension.js";
import { registerMemoryMaintenance } from "./lib/maintenance.js";
import { formatDiagnostics, memoryDiagnostics } from "./lib/diagnostics.js";
import { CONSOLIDATE_GUIDE, CONSOLIDATE_SECTIONS, consolidationCandidate } from "./lib/maintenance-consolidate.js";

const EXT_FILE = fileURLToPath(import.meta.url);
const EXT_DIR = dirname(EXT_FILE);
const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(EXT_DIR, "package.json"), "utf8")).version;
// Package installs keep skills beside index.ts; install.sh places them in .pi/skills.
const SKILLS_DIR = existsSync(join(EXT_DIR, "skills")) ? join(EXT_DIR, "skills") : join(EXT_DIR, "..", "..", "skills");

function fit(text: string): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return t.truncated ? `${t.content}\n\n[Truncated to ${t.outputLines} of ${t.totalLines} lines. Pass section to memory_show to read one part.]` : t.content;
}

const REVIEW_PROMPT = `Perform a knowledge review of this session using the okf-memory skill:
1. Did we learn durable rationale, make a decision, or invalidate an assumption?
2. Apply the re-derivation test. Do not store what git, runbooks, or workflow logs already record, or what a future agent can re-derive in about two minutes.
3. Search before writing; update rather than duplicate.
4. Use memory_write for warranted writes, then run memory_validate. Do not claim successful persistence unless its ok field is true.
5. Most reviews end with "nothing worth storing". Do not manufacture entries.
Pending package upgrades are a separate /memory-upgrade workflow; do not perform them during this review.`;

/** `steps` replaces the upgrade registry; hosts and tests can exercise a model-reviewed step. */
export function createMemoryExtension(config: { steps?: readonly UpgradeStep[] } = {}) {
	return (pi: ExtensionAPI) => memoryExtension(pi, config);
}
export default function okfMemoryExtension(pi: ExtensionAPI) { memoryExtension(pi, {}); }

function memoryExtension(pi: ExtensionAPI, config: { steps?: readonly UpgradeStep[] }) {
	pi.registerCommand("memory-diagnostics", {
		description: "Show the loaded package, resolved knowledge bundle and resource settings paths (read-only)",
		handler: async (_args, ctx) => {
			const text = formatDiagnostics(memoryDiagnostics(EXT_FILE, PACKAGE_VERSION, ctx.cwd));
			ctx.ui.notify(text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""), "info");
		},
	});
	function requireKnowledge(cwd: string): string {
		const dir = resolveKnowledgeDir(cwd);
		if (!dir) throw new Error(`No knowledge bundle found. Run /memory-setup or request explicit host setup for ${join(cwd, "knowledge")}; OKF_KNOWLEDGE_DIR can select another bundle.`);
		return dir;
	}
	const text = (value: string, details?: unknown) => ({ content: [{ type: "text" as const, text: fit(value) }], details });
	/** A read keeps a concept in the injected index. Never before the bundle adopts the generated layout. */
	function used(dir: string, id: string) {
		recordUsage(dir, "open", [id]);
		try {
			const active = parseActive(readFileSync(join(dir, "index.md"), "utf8"));
			if (active && !active.includes(id)) refreshView(dir, { promote: [id] });
		} catch { /* navigation is repaired by the next write or validation */ }
	}

	let upgrades: ReturnType<typeof registerUpgrades> | undefined;
	const setup = registerSetup(pi, { packageVersion: PACKAGE_VERSION,
		busy: () => upgrades?.busy ?? false, onReady: ctx => { upgrades?.refresh(ctx); } });
	upgrades = registerUpgrades(pi, { skillsDir: SKILLS_DIR, packageVersion: PACKAGE_VERSION, getBundle: resolveKnowledgeDir, steps: config.steps,
		setupBusy: () => setup.active, requireSetup: setup.requireReady });
	const maintenance = registerMemoryMaintenance(pi, { packageVersion: PACKAGE_VERSION, skillsDir: SKILLS_DIR, steps: config.steps,
		busy: () => setup.active || (upgrades?.busy ?? false) });
	pi.on("session_shutdown", async () => { await maintenance.stop(); });

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Search persistent project memory. Returns ranked concepts with the best-matching section and a snippet; partial matches rank lower instead of disappearing. Most concepts are NOT in the session index, so search before substantial work and before writing new memory.",
		promptSnippet: "Search persistent project knowledge (decisions, constraints, lessons)",
		promptGuidelines: ["Use memory_search before substantial tasks and before writing memory; the session index shows only standing rules and recently used concepts."],
		parameters: Type.Object({
			query: Type.String({ description: "Free-text query; a few specific terms work best" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 8 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const query = params.query?.trim();
			if (!query) throw new Error("Supply a query.");
			if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 50)) throw new Error("limit must be an integer from 1 to 50.");
			const results = search(loadConcepts(dir).concepts, query, params.limit ?? 8);
			recordUsage(dir, "hit", results.slice(0, 3).map(r => r.concept));
			return text(JSON.stringify(results, null, 2), { query, results: results.length });
		},
	});

	pi.registerTool({
		name: "memory_show",
		label: "Memory Show",
		description: "Read a concept by ID (from memory_search, the session index or catalog.md). Pass section to read one heading of a long concept.",
		parameters: Type.Object({
			concept: Type.String({ description: "Concept ID without .md, e.g. decisions/storage" }),
			section: Type.Optional(Type.String({ description: "Heading text (or part of it) to return only that section" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const concept = readConcept(dir, params.concept.trim());
			used(dir, concept.id);
			const parts = sections(concept.body);
			const header = [`# ${concept.title}`, `id: ${concept.id} · type: ${concept.type}${concept.status ? ` · status: ${concept.status}` : ""}${concept.tags.length ? ` · tags: ${concept.tags.join(", ")}` : ""}${concept.updated ? ` · updated: ${concept.updated.slice(0, 10)}` : ""}${concept.staleAfter ? ` · stale_after: ${concept.staleAfter}` : ""}${concept.verified ? " · human-verified" : ""}`, "", concept.description, ""];
			if (params.section?.trim()) {
				const wanted = params.section.trim().toLowerCase();
				const match = parts.filter(p => p.heading.toLowerCase().includes(wanted));
				if (!match.length) throw new Error(`No section matching ${JSON.stringify(params.section)}. Sections: ${parts.map(p => p.heading).filter(Boolean).join(" | ") || "(none)"}`);
				return text([...header, ...match.map(p => `## ${p.heading}\n\n${p.text}`)].join("\n"), { concept: concept.id, section: params.section });
			}
			const outline = concept.body.length > 20_000 ? [`Sections: ${parts.map(p => p.heading).filter(Boolean).join(" | ")}`, ""] : [];
			return text([...header, ...outline, concept.body.trim()].join("\n"), { concept: concept.id });
		},
	});

	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: "Create or update a concept: durable WHY only (rationale, decisions, constraints, lessons). New concepts need title and description. For an existing concept pass append to add a dated section, or body to replace the whole body after reading it. The index, catalog and log are maintained automatically. Search first; update rather than duplicate.",
		parameters: Type.Object({
			concept: Type.String({ description: "Concept ID: lowercase letters, digits and hyphens in slash-separated segments, e.g. decisions/storage-choice. convention/ IDs are standing rules shown in every session." }),
			title: Type.Optional(Type.String({ maxLength: 200 })),
			description: Type.Optional(Type.String({ maxLength: 600, description: "One or two sentences; this is what the index and search results show" })),
			type: Type.Optional(Type.String({ maxLength: 80, description: "Open label such as Decision, Constraint, Lesson, Fact (default Fact)" })),
			append: Type.Optional(Type.String({ description: "Markdown section appended to the existing body" })),
			body: Type.Optional(Type.String({ description: "Markdown that replaces the whole body (required content for a new concept)" })),
			tags: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 12 })),
			status: Type.Optional(Type.String({ maxLength: 40, description: "e.g. stable, draft, deprecated (deprecated concepts leave the index)" })),
			pinned: Type.Optional(Type.Boolean({ description: "Always show in the session index. Use sparingly: reserved for rules that apply to every session." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			if (params.body !== undefined && params.append !== undefined) throw new Error("Pass body (replace) or append, not both.");
			const { created, concept, view } = writeConcept(dir, { id: params.concept.trim(), title: params.title, description: params.description, type: params.type,
				body: params.body, append: params.append, tags: params.tags, status: params.status, pinned: params.pinned, actor: "agent" });
			return text(`${created ? "Created" : "Updated"} ${concept.id} (${concept.file}). ${view.active.includes(concept.id) || isPinned(concept) ? "It is in the session index." : "It is in the catalog only (index budget is full or the concept is deprecated)."}${view.demoted.length ? ` Left the index to make room: ${view.demoted.join(", ")}.` : ""} Run memory_validate before claiming it is persisted.`, { concept: concept.id, created, view });
		},
	});

	pi.registerTool({
		name: "memory_move",
		label: "Memory Move",
		description: "Rename or reorganise a concept (for example into archive/). Relative links to and from it are rewritten and its usage history follows it.",
		parameters: Type.Object({ from: Type.String({ description: "Existing concept ID" }), to: Type.String({ description: "New concept ID" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const result = moveConcept(dir, params.from.trim(), params.to.trim());
			return text(`Moved ${params.from} to ${params.to}.${result.relinked.length ? ` Rewrote links in: ${result.relinked.join(", ")}.` : ""}`, result);
		},
	});

	pi.registerTool({
		name: "memory_validate",
		label: "Memory Validate",
		description: "Regenerate the index and catalog from concept files, then check that every concept has readable frontmatter with title and description and that every local link resolves. ok:true means zero blocking findings. Expired stale_after dates are advisories. While a memory upgrade is pending it only checks concept files and changes nothing.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const dir = requireKnowledge(ctx.cwd);
			const details = { ...checkBundle(dir), dir };
			return text(JSON.stringify(details, null, 2), details);
		},
	});

	// Reading a concept file directly is use too; without this, popular concepts would look idle.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "read") return;
		try {
			const dir = resolveKnowledgeDir(ctx.cwd);
			const input = (event.input as { path?: unknown }).path;
			if (!dir || typeof input !== "string" || !input.endsWith(".md")) return;
			const path = isAbsolute(input) ? input : resolve(ctx.cwd, input);
			if (!existsSync(path)) return;
			const inside = relative(dir, realpathSync(path));
			if (!inside || inside.startsWith("..") || isAbsolute(inside)) return;
			const id = inside.split(sep).join("/").slice(0, -3);
			if (ID_PATTERN.test(id) && !/(?:^|\/)(?:index|log)$/.test(id) && id !== "catalog") used(dir, id);
		} catch { /* usage tracking never blocks a read */ }
	});

	pi.registerCommand("memory-context", {
		description: "Inject the knowledge index into context",
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
			pi.sendUserMessage(`${REVIEW_PROMPT}\nBundle: ${JSON.stringify(requireKnowledge(ctx.cwd))}.`);
		},
	});

	const say = (ctx: ExtensionContext, message: string, level: "info" | "warning" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else pi.sendMessage({ customType: "okf-memory", content: message, display: true }, { deliverAs: "nextTurn" });
	};
	const conceptIds = (cwd: string, prefix: string) => {
		try {
			const dir = resolveKnowledgeDir(cwd);
			const items = dir ? loadConcepts(dir).concepts.filter(c => c.id.includes(prefix.trim())).slice(0, 30).map(c => ({ value: c.id, label: c.id, description: c.title })) : [];
			return items.length ? items : null;
		} catch { return null; }
	};
	let commandCwd = process.cwd();
	pi.on("session_start", (_event, ctx) => { commandCwd = ctx.cwd; });

	pi.registerCommand("memory-stats", {
		description: "Show which concepts are in the session index and how much each is used",
		handler: async (_args, ctx) => {
			const dir = requireKnowledge(ctx.cwd);
			const { concepts } = loadConcepts(dir);
			const stats = readUsage(dir), config = viewConfig(dir);
			const index = readFileSync(join(dir, "index.md"), "utf8");
			const active = new Set(parseActive(index) ?? []);
			const tier = (c: typeof concepts[number]) => isPinned(c) ? "pinned" : active.has(c.id) ? "active" : c.status === "deprecated" ? "deprecated" : "catalog";
			const rows = concepts.map(c => ({ c, u: stats.concepts[c.id], idle: idleSessions(stats, c.id) }))
				.sort((a, b) => a.idle - b.idle || (b.u?.opens ?? 0) - (a.u?.opens ?? 0) || (a.c.id < b.c.id ? -1 : 1));
			const lines = [
				`Knowledge bundle: ${dir}`,
				`${concepts.length} concepts; index.md is ${index.length} chars (Active budget ${config.indexBudget} chars, demotion after ${config.demoteIdleSessions} idle sessions).`,
				stats.available ? `Usage ledger: ${stats.sessions} sessions recorded on this machine.` : "Usage ledger: none yet on this machine (it starts once /memory-upgrade has adopted this package); tiers follow the committed index.",
				"", "tier       idle opens hits writes  concept",
				...rows.map(({ c, u, idle }) => `${tier(c).padEnd(10)} ${String(stats.available ? idle : "-").padStart(4)} ${String(u?.opens ?? 0).padStart(5)} ${String(u?.hits ?? 0).padStart(4)} ${String(u?.writes ?? 0).padStart(6)}  ${c.id}`),
				"", "idle = sessions since last use. /memory-demote <id> removes a concept from the index now; /memory-pin <id> keeps one in it.",
			];
			pi.sendMessage({ customType: "okf-memory-stats", content: lines.join("\n"), display: true }, { deliverAs: "nextTurn" });
			if (ctx.hasUI) ctx.ui.notify("Memory usage report queued for the next turn", "info");
		},
	});
	pi.registerCommand("memory-demote", {
		description: "Remove a concept from the session index now (it stays searchable); 'idle' demotes everything past the idle limit",
		getArgumentCompletions: (prefix: string) => conceptIds(commandCwd, prefix),
		handler: async (args, ctx) => {
			try {
				const dir = requireKnowledge(ctx.cwd);
				const id = args.trim().replace(/\.md$/, "");
				if (!id) throw new Error("Usage: /memory-demote <concept-id> | idle");
				if (id === "idle") {
					const view = refreshView(dir, { rebalance: true });
					say(ctx, view.demoted.length || view.promoted.length ? `Index rebalanced. Demoted: ${view.demoted.join(", ") || "none"}. Promoted: ${view.promoted.join(", ") || "none"}.` : "Index already matches usage; nothing changed.");
					return;
				}
				const concept = readConcept(dir, id);
				if (isPinned(concept)) throw new Error(`${id} is pinned${id.startsWith("convention/") ? " (convention/ concepts are standing rules)" : ""}. Use /memory-pin ${id} off, or move it out of convention/.`);
				recordUsage(dir, "demote", [id]);
				const view = refreshView(dir, { demote: [id] });
				say(ctx, view.demoted.includes(id) ? `${id} left the session index. It returns when it is next opened or written.` : `${id} was not in the session index.`);
			} catch (err) { say(ctx, err instanceof Error ? err.message : String(err), "warning"); }
		},
	});
	pi.registerCommand("memory-pin", {
		description: "Always show a concept in the session index: /memory-pin <id> [off]",
		getArgumentCompletions: (prefix: string) => conceptIds(commandCwd, prefix),
		handler: async (args, ctx) => {
			try {
				const dir = requireKnowledge(ctx.cwd);
				const [id, flag] = args.trim().split(/\s+/);
				if (!id) throw new Error("Usage: /memory-pin <concept-id> [off]");
				const { concept } = writeConcept(dir, { id: id.replace(/\.md$/, ""), pinned: flag !== "off", actor: "user" });
				say(ctx, `${concept.id} is ${isPinned(concept) ? "pinned: shown in every session" : "no longer pinned"}.`);
			} catch (err) { say(ctx, err instanceof Error ? err.message : String(err), "warning"); }
		},
	});
	pi.registerCommand("memory-consolidate", {
		description: "Ask the agent to rewrite a concept's stacked session addenda into one body, with your approval: /memory-consolidate [id]",
		getArgumentCompletions: (prefix: string) => conceptIds(commandCwd, prefix),
		handler: async (args, ctx) => {
			try {
				const dir = requireKnowledge(ctx.cwd);
				if (!ctx.isIdle()) throw new Error("Wait until the agent is idle before consolidating memory.");
				const id = args.trim().replace(/\.md$/, "") || consolidationCandidate(dir, join(dir, ".pi-okf-memory"))?.id;
				if (!id) { say(ctx, `No concept has ${CONSOLIDATE_SECTIONS} or more stacked session-evidence sections.`); return; }
				readConcept(dir, id);
				pi.sendUserMessage(`Consolidate the memory concept ${JSON.stringify(id)}.\n1. Read it in full with memory_show.\n2. ${CONSOLIDATE_GUIDE}\n3. Show me a short summary of what you merged, corrected or dropped, and the size before and after. Wait for my approval.\n4. After I approve, call memory_write with concept=${JSON.stringify(id)} and body set to the rewritten Markdown, then memory_validate. Git history keeps the earlier wording.`);
			} catch (err) { say(ctx, err instanceof Error ? err.message : String(err), "warning"); }
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
			let count: number | undefined;
			try { count = loadConcepts(dir).concepts.length; }
			catch { /* Do not label an unreadable corpus empty. */ }
			recordUsage(dir, "session");
			const discipline = "Knowledge records only WHY; git records what and runbooks record how. Search before writing, apply the two-minute re-derivation test, write with memory_write and run memory_validate after warranted changes. Most reviews need no writes.";
			const content = count === 0
				? `[okf-memory] A knowledge corpus exists at ${dir} but has no concepts yet. That is fine: do not seed it merely to fill it. Record project purpose/constraints only when learned and durable. ${discipline}`
				: `[okf-memory] Persistent project knowledge at ${dir}${count === undefined ? "" : ` (${count} concepts)`}. The index below lists standing rules and recently used concepts only; use memory_search for everything else and memory_show to read a concept. ${discipline}\n\n${fit(readFileSync(join(dir, "index.md"), "utf8"))}`;
			pi.sendMessage({ customType: "okf-memory", content, display: true }, { deliverAs: "nextTurn" });
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`Memory context unavailable: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	});
}
