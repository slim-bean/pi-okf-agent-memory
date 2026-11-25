/** In-memory ranked search over concept sections. The corpus is small Markdown, so an
 * index rebuilt per query is fast, needs no cache invalidation and has no native dependency. */
import type { Concept } from "./store.js";

const STOP = new Set("a an and are as at be but by for from has have how i if in into is it its of on or that the their then there these this to was were what when where which who why will with not no do does did can should would our we you your".split(" "));

/** Light stemming: enough for plurals and common verb forms without a dictionary. */
export function stem(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
	else if (w.length > 4 && /(?:sses|shes|ches|xes|zes)$/.test(w)) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
	const before = w;
	if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
	else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
	if (w !== before && w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1); // running -> runn -> run
	if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
	return w;
}
export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? [])
		.flatMap(t => /[._-]/.test(t) ? [t, ...t.split(/[._-]/)] : [t])
		.filter(t => t.length > 1 && !STOP.has(t)).map(stem);
}

export interface Section { heading: string; text: string }
/** Split a body at headings so a hit can return the relevant part of a long concept. */
export function sections(body: string): Section[] {
	const out: Section[] = [];
	let heading = "", lines: string[] = [], fence = false;
	const flush = () => { const text = lines.join("\n").trim(); if (text || heading) out.push({ heading, text }); lines = []; };
	for (const line of body.split(/\r?\n/)) {
		if (/^(```|~~~)/.test(line)) fence = !fence;
		const match = !fence && /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
		if (match) { flush(); heading = match[1]!; } else lines.push(line);
	}
	flush();
	return out.length ? out : [{ heading: "", text: "" }];
}

export interface SearchResult {
	concept: string; title: string; type: string; description: string; score: number;
	matched: string[]; section?: string; snippet?: string;
}

function snippet(text: string, terms: Set<string>, max = 320): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let at = -1;
	for (const m of flat.matchAll(/[A-Za-z0-9]+/g)) if (terms.has(stem(m[0].toLowerCase()))) { at = m.index!; break; }
	const start = Math.max(0, Math.min(at < 0 ? 0 : at - 80, flat.length - max));
	return (start ? "…" : "") + flat.slice(start, start + max).trim() + (start + max < flat.length ? "…" : "");
}

/** BM25 over sections, with title/description/tags/ID counted as weighted fields of every
 * section. Results are ranked concepts; partial matches rank below fuller ones rather than vanish. */
export function search(concepts: Concept[], query: string, limit = 8): SearchResult[] {
	const terms = [...new Set(tokenize(query))];
	if (!terms.length) return [];
	interface Doc { concept: Concept; section: Section; tf: Map<string, number>; length: number }
	const docs: Doc[] = [];
	for (const concept of concepts) {
		const head = new Map<string, number>();
		const add = (text: string, weight: number) => { for (const t of tokenize(text)) head.set(t, (head.get(t) ?? 0) + weight); };
		add(concept.title, 3); add(concept.description, 2); add(concept.id.replace(/\//g, " "), 2); add(concept.tags.join(" "), 2);
		for (const section of sections(concept.body)) {
			const tf = new Map(head);
			const body = tokenize(`${section.heading} ${section.text}`);
			for (const t of body) tf.set(t, (tf.get(t) ?? 0) + 1);
			docs.push({ concept, section, tf, length: body.length + 20 });
		}
	}
	if (!docs.length) return [];
	const average = docs.reduce((n, d) => n + d.length, 0) / docs.length;
	const df = new Map(terms.map(t => [t, docs.filter(d => d.tf.has(t)).length]));
	const best = new Map<string, { doc: Doc; score: number; matched: string[] }>();
	for (const doc of docs) {
		let score = 0; const matched: string[] = [];
		for (const term of terms) {
			const tf = doc.tf.get(term);
			if (!tf) continue;
			matched.push(term);
			const idf = Math.log(1 + (docs.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5));
			score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / average));
		}
		if (!matched.length) continue;
		score *= (matched.length / terms.length) ** 2; // prefer covering the whole query
		const previous = best.get(doc.concept.id);
		if (!previous || score > previous.score) best.set(doc.concept.id, { doc, score, matched });
	}
	const termSet = new Set(terms);
	return [...best.values()].sort((a, b) => b.score - a.score || (a.doc.concept.id < b.doc.concept.id ? -1 : 1)).slice(0, limit)
		.map(({ doc, score, matched }) => ({
			concept: doc.concept.id, title: doc.concept.title, type: doc.concept.type, description: doc.concept.description,
			score: Math.round(score * 100) / 100, matched,
			...(doc.section.heading ? { section: doc.section.heading } : {}),
			...(doc.section.text ? { snippet: snippet(doc.section.text, termSet) } : {}),
		}));
}
