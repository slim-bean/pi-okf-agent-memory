/** What an unattended reviewer sees of existing memory: the catalog of every concept
 * plus the text most related to the source, sized to the model instead of the corpus. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConcepts, type Concept } from "./store.js";
import { search, sections } from "./search.js";

export interface ReviewContext { catalog: string[]; concepts: Record<string, string>; omitted: number }
const EXCERPT_HEAD = 1500, EXCERPT_SECTION = 4000;

export function reviewContext(bundle: string, query: string, budgetChars: number, concepts: Concept[] = loadConcepts(bundle).concepts): ReviewContext {
	const catalog = concepts.map(c => `${c.id} | ${c.title} | ${c.description}`);
	let remaining = budgetChars - catalog.join("\n").length;
	const selected: Record<string, string> = {};
	const ranked = search(concepts, query.slice(0, 20_000), 12);
	let omitted = 0;
	for (const hit of ranked) {
		const text = readFileSync(join(bundle, `${hit.concept}.md`), "utf8");
		if (text.length <= remaining) { selected[hit.concept] = text; remaining -= text.length; continue; }
		// A long concept still contributes its summary and the section that matched.
		const concept = concepts.find(c => c.id === hit.concept)!;
		const matched = sections(concept.body).find(s => s.heading === hit.section);
		const excerpt = `${text.slice(0, EXCERPT_HEAD)}\n\n[... excerpt: ${text.length} characters in total; append an addendum rather than restating it ...]\n\n` +
			(matched ? `## ${matched.heading}\n\n${matched.text.slice(0, EXCERPT_SECTION)}` : "");
		if (excerpt.length <= remaining) { selected[hit.concept] = excerpt; remaining -= excerpt.length; } else omitted++;
	}
	return { catalog, concepts: selected, omitted };
}
