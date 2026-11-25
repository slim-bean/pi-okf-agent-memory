/** High-level memory operations shared by tools, setup, upgrades and maintenance. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLog, moveConceptFile, validateConcepts, writeConceptFile, type Concept, type Finding, type Validation, type WriteRequest } from "./store.js";
import { parseActive, refreshView, render, viewFindings, type Refresh } from "./view.js";
import { recordUsage, renameUsage } from "./usage.js";

export type { Validation, Finding, Concept };
export { resolveKnowledgeDir } from "./store.js";

/** Create an empty bundle. Never overwrites existing files. */
export function initBundle(bundle: string) {
	mkdirSync(bundle, { recursive: true });
	const empty = render([], []);
	for (const [name, text] of [["index.md", empty.index], ["catalog.md", empty.catalog], ["log.md", ""]] as const) {
		if (!existsSync(join(bundle, name))) writeFileSync(join(bundle, name), text);
	}
}

/** Read-only. `ok` means every concept parses, no local link is broken and the
 * generated navigation matches the concepts. Expired `stale_after` dates are advisory. */
export function validateBundle(bundle: string): Validation {
	const { concepts, ...result } = validateConcepts(bundle);
	const findings = [...result.findings, ...viewFindings(bundle, concepts)];
	return { ok: findings.length === 0, conceptCount: result.conceptCount, findings, advisories: result.advisories };
}

/** Has this bundle adopted the generated index/catalog layout (upgrade step 002)?
 * catalog.md never existed in the earlier layout, so it marks adoption even when
 * someone has since damaged index.md by hand. */
export function hasGeneratedNavigation(bundle: string): boolean {
	if (existsSync(join(bundle, "catalog.md"))) return true;
	try { return parseActive(readFileSync(join(bundle, "index.md"), "utf8")) !== null; } catch { return false; }
}

/** What an agent-facing check may do. Before a bundle adopts the generated layout the
 * check is read-only: converting navigation is the pending upgrade's job, and doing it
 * here would leave uncommitted changes in a bundle the agent only asked to inspect. */
export function checkBundle(bundle: string): Validation & { regenerated: string[] } {
	if (hasGeneratedNavigation(bundle)) { const { view, ...result } = repairAndValidate(bundle); return { ...result, regenerated: view.changed }; }
	const { concepts: _concepts, ...result } = validateConcepts(bundle);
	return { ...result, ok: result.findings.length === 0, regenerated: [],
		advisories: [...result.advisories, { code: "navigation-pending", file: "index.md", message: "index.md and catalog.md will be generated when the pending memory upgrade runs; concept files were checked." }] };
}

/** Regenerate navigation, then validate. Used wherever a caller is allowed to write. */
export function repairAndValidate(bundle: string, options: { rebalance?: boolean } = {}): Validation & { view: Refresh } {
	const view = refreshView(bundle, options);
	return { ...validateBundle(bundle), view };
}

export function writeConcept(bundle: string, request: WriteRequest & { log?: boolean }): { created: boolean; concept: Concept; view: Refresh } {
	const { created, concept } = writeConceptFile(bundle, request);
	if (request.log !== false) appendLog(bundle, created
		? `* **Creation**: Documented concept \`${concept.file}\` (${concept.title}).`
		: `* **Update**: Updated concept \`${concept.file}\`.`, request.now);
	recordUsage(bundle, "write", [concept.id]);
	// A fresh write is the strongest signal that a concept is in use.
	return { created, concept, view: refreshView(bundle, { promote: [concept.id] }) };
}

export function moveConcept(bundle: string, from: string, to: string): { relinked: string[]; view: Refresh } {
	const source = from.replace(/\.md$/, ""), target = to.replace(/\.md$/, "");
	const relinked = moveConceptFile(bundle, source, target);
	appendLog(bundle, `* **Move**: Moved concept \`${source}.md\` to \`${target}.md\`.`);
	renameUsage(bundle, source, target);
	return { relinked, view: refreshView(bundle) };
}
