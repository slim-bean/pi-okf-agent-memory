/** High-level memory operations shared by tools, setup, upgrades and maintenance. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLog, moveConceptFile, validateConcepts, writeConceptFile, type Concept, type Finding, type Validation, type WriteRequest } from "./store.js";
import { refreshView, render, viewFindings, type Refresh } from "./view.js";
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
