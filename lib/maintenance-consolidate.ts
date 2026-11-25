/** Rewrite a concept that has accumulated stacked session addenda into one coherent body.
 * Full-ownership maintenance only: this replaces text, with Git history as the record of
 * the earlier wording. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConcepts, localLinks, type Concept } from "./store.js";

/** Evidence sections appended by unattended review; this many triggers a rewrite. */
export const CONSOLIDATE_SECTIONS = 4;
const EVIDENCE = /^## (?:Session|Upgrade) evidence\b/gm;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export const CONSOLIDATE_GUIDE = "Rewrite this one concept into a single coherent record. It has accumulated separate session addenda that repeat, qualify and correct each other. " +
	"Keep every durable decision, rationale, constraint, date and stated uncertainty; where a later addendum corrects an earlier one, state the current position and say briefly what it replaced. " +
	"Remove repetition, per-session narration and attribution boilerplate. Do not add facts, do not upgrade a proposal to a decision, and do not claim human verification. " +
	"Preserve existing relative Markdown links exactly. End with a '## Sources' section listing each distinct source session file once, with its date if known.";
export const CONSOLIDATE_FORMAT = "Return ONLY the rewritten Markdown body: no frontmatter, no code fence, no commentary. Organise it with '## ' topic headings. It must be shorter than the original.";

export interface Candidate { id: string; sections: number; chars: number; done(): void; fail(reason: string): void }

/** The concept with the most stacked evidence that has not already failed twice at this content. */
export function consolidationCandidate(bundle: string, workDir: string, concepts: Concept[] = loadConcepts(bundle).concepts): Candidate | null {
	const ranked = concepts.filter(c => !c.verified).map(c => ({ c, sections: (c.body.match(EVIDENCE) ?? []).length }))
		.filter(x => x.sections >= CONSOLIDATE_SECTIONS).sort((a, b) => b.sections - a.sections || (a.c.id < b.c.id ? -1 : 1));
	for (const { c, sections } of ranked) {
		const marker = join(workDir, "consolidation", hash([bundle, c.id]) + ".json");
		const content = hash(c.body);
		let state: { content?: string; attempts?: number } = {};
		try { state = JSON.parse(readFileSync(marker, "utf8")); } catch { /* first attempt */ }
		if (state.content === content && (state.attempts ?? 0) >= 2) continue;
		const save = (next: object) => { mkdirSync(dirname(marker), { recursive: true, mode: 0o700 }); writeFileSync(marker, JSON.stringify(next, null, 2), { mode: 0o600 }); };
		return { id: c.id, sections, chars: c.body.length,
			done: () => save({ concept: c.id, consolidatedAt: new Date().toISOString(), fromSections: sections, fromChars: c.body.length }),
			fail: reason => save({ concept: c.id, content, attempts: (state.content === content ? state.attempts ?? 0 : 0) + 1, reason, at: new Date().toISOString() }) };
	}
	return null;
}

/** Accept a model's rewrite only if it is a real, smaller body that keeps the concept's links. */
export function consolidatedBody(candidate: Candidate, response: string, original?: Concept): string {
	const body = response.trim().replace(/^```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "").trim();
	if (body.startsWith("---")) throw new Error("Consolidation returned frontmatter instead of a body");
	if (body.length < 200) throw new Error("Consolidation returned an implausibly short body");
	if (body.length >= candidate.chars) throw new Error("Consolidation did not shorten the concept");
	if (/^## (?:Session|Upgrade) evidence\b/m.test(body)) throw new Error("Consolidation kept per-session evidence headings");
	if (original) {
		const kept = new Set(localLinks(original.file, body).map(l => l.target));
		const lost = localLinks(original.file, original.body).map(l => l.target).filter(t => !kept.has(t));
		if (lost.length) throw new Error(`Consolidation dropped links to ${[...new Set(lost)].join(", ")}`);
	}
	const stamp = new Date().toISOString().slice(0, 10);
	return `${body}\n\n_Consolidated from ${candidate.sections} session-evidence sections on ${stamp} by unattended maintenance; not human verification. Earlier wording is in Git history._`;
}
