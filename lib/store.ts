/** Native knowledge-bundle store: Markdown concepts with frontmatter, no external binary.
 * The on-disk format stays compatible with existing OKF v0.2 bundles. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";

export const STATE_DIR = ".pi-okf-memory";
/** Generated or bookkeeping Markdown that is never a concept. */
const NON_CONCEPT = new Set(["index.md", "log.md"]);
const ROOT_GENERATED = new Set(["catalog.md"]);
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

export function resolveKnowledgeDir(cwd: string): string | null {
	const override = process.env.OKF_KNOWLEDGE_DIR;
	const candidates = override
		? [isAbsolute(override) ? override : resolve(cwd, override)]
		: [join(cwd, "knowledge"), ...(cwd === "/workspace" || cwd.startsWith("/workspace/") ? ["/workspace/knowledge"] : [])];
	for (const dir of candidates) {
		if (existsSync(join(dir, "index.md"))) return realpathSync(dir);
	}
	return null;
}

export function assertId(id: string): string {
	const base = id.split("/").at(-1)!;
	if (!ID_PATTERN.test(id) || base === "index" || base === "log" || id === "catalog") {
		throw new Error(`Invalid concept ID ${JSON.stringify(id)}: use lowercase letters, digits and hyphens in slash-separated segments (e.g. decisions/storage-choice).`);
	}
	return id;
}

// ---------------------------------------------------------------- frontmatter

export interface Field { key: string; raw: string }
export interface Parsed { fields: Field[]; body: string }

/** Minimal frontmatter reader. Unknown or structured values are kept verbatim so
 * rewriting one field never reformats or drops another. */
export function parseDocument(text: string): Parsed | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!match) return null;
	const fields: Field[] = [];
	for (const line of match[1]!.split(/\r?\n/)) {
		const top = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
		if (top) fields.push({ key: top[1]!, raw: top[2]!.trim() });
		else if (fields.length && line.trim()) fields.at(-1)!.raw += `\n${line}`;
		else if (line.trim()) return null;
	}
	return { fields, body: text.slice(match[0].length) };
}

export function decodeScalar(raw: string): string {
	const value = raw.trim();
	if (value.startsWith('"')) { try { const parsed = JSON.parse(value); if (typeof parsed === "string") return parsed; } catch { /* fall through */ } }
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
	return value;
}

export function encodeScalar(value: string): string {
	const text = value.replace(/\s*[\r\n]+\s*/g, " ").trim();
	const plain = /^[A-Za-z0-9(][^:#"'{}\[\]|>`\\]*$/.test(text) && !/^(?:true|false|null|yes|no|~|[-+.\d][\d._eE+-]*)$/i.test(text) && !/\s$/.test(text);
	return plain ? text : JSON.stringify(text);
}

function decodeList(raw: string): string[] {
	const value = raw.trim();
	if (!value) return [];
	if (value.startsWith("[")) return value.replace(/^\[|\]$/g, "").split(",").map(decodeScalar).filter(Boolean);
	return value.split(/\r?\n/).map(line => decodeScalar(line.replace(/^\s*-\s*/, ""))).filter(Boolean);
}

export function serialize(doc: Parsed): string {
	const head = doc.fields.map(f => f.raw.startsWith("\n") ? `${f.key}:${f.raw}` : `${f.key}: ${f.raw}`.trimEnd()).join("\n");
	return `---\n${head}\n---\n${doc.body}`;
}

const field = (doc: Parsed, key: string) => doc.fields.find(f => f.key === key);
function setField(doc: Parsed, key: string, raw: string | undefined) {
	const existing = field(doc, key);
	if (raw === undefined) { if (existing) doc.fields.splice(doc.fields.indexOf(existing), 1); return; }
	if (existing) existing.raw = raw; else doc.fields.push({ key, raw });
}

// -------------------------------------------------------------------- concepts

export interface Concept {
	id: string; file: string; type: string; title: string; description: string;
	status?: string; tags: string[]; pinned: boolean; verified: boolean;
	created?: string; updated?: string; staleAfter?: string; body: string;
}
export interface Finding { code: "invalid-concept" | "broken-link" | "symlink" | "index-stale" | "stale" | "navigation-pending"; file: string; message: string; target?: string }

/** Every Markdown file except generated navigation and the log is a concept.
 * Symlinks are never followed: an agent-owned bundle must contain its own files. */
export function conceptFiles(bundle: string): { files: string[]; symlinks: string[] } {
	const files: string[] = [], symlinks: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
			if (entry.name.startsWith(".")) continue;
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) { symlinks.push(path); continue; }
			if (entry.isDirectory()) walk(join(dir, entry.name), path);
			else if (entry.name.endsWith(".md") && !NON_CONCEPT.has(entry.name) && !(prefix === "" && ROOT_GENERATED.has(entry.name))) files.push(path);
		}
	};
	walk(bundle, "");
	return { files, symlinks };
}

function timestamp(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const at = /\bat:\s*"?([^",}\s]+)"?/.exec(raw)?.[1] ?? decodeScalar(raw);
	return Number.isFinite(Date.parse(at)) ? at : undefined;
}

export function parseConcept(file: string, text: string): Concept | string {
	const doc = parseDocument(text);
	if (!doc) return "no readable frontmatter block";
	const get = (key: string) => { const f = field(doc, key); return f ? decodeScalar(f.raw) : ""; };
	const title = get("title"), description = get("description");
	if (!title) return "frontmatter has no title";
	if (!description) return "frontmatter has no description";
	const updated = timestamp(field(doc, "generated")?.raw);
	return {
		id: file.slice(0, -3), file, type: get("type") || "Fact", title, description,
		status: get("status") || undefined, tags: decodeList(field(doc, "tags")?.raw ?? ""),
		pinned: /^true$/i.test(get("pinned")), verified: !!field(doc, "verified"),
		created: timestamp(field(doc, "created")?.raw) ?? updated, updated,
		staleAfter: get("stale_after") || undefined, body: doc.body,
	};
}

export function loadConcepts(bundle: string): { concepts: Concept[]; findings: Finding[] } {
	const { files, symlinks } = conceptFiles(bundle);
	const concepts: Concept[] = [];
	const findings: Finding[] = symlinks.map(file => ({ code: "symlink" as const, file, message: `${file}: symlinks are not followed; store the file inside the bundle.` }));
	for (const file of files) {
		const parsed = ID_PATTERN.test(file.slice(0, -3)) ? parseConcept(file, readFileSync(join(bundle, file), "utf8")) : "file name is not a valid concept ID (lowercase letters, digits, hyphens)";
		if (typeof parsed === "string") findings.push({ code: "invalid-concept", file, message: `${file}: ${parsed}.` });
		else concepts.push(parsed);
	}
	return { concepts, findings };
}

export function readConcept(bundle: string, id: string): Concept {
	const file = `${assertId(id.replace(/\.md$/, ""))}.md`;
	const path = join(bundle, file);
	if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error(`Concept ${JSON.stringify(id)} not found. Use memory_search, or see catalog.md for every concept ID.`);
	const parsed = parseConcept(file, readFileSync(path, "utf8"));
	if (typeof parsed === "string") throw new Error(`${file}: ${parsed}.`);
	return parsed;
}

// ----------------------------------------------------------------------- links

const stripCode = (text: string) => text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const isLocalMarkdown = (href: string) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href) && /\.md(?:#.*)?$/i.test(href);
const resolveLink = (from: string, href: string) => posix.normalize(posix.join(posix.dirname(from), href.replace(/#.*$/, "")));

export function localLinks(file: string, body: string): { href: string; target: string }[] {
	return [...stripCode(body).matchAll(LINK)].map(m => m[1]!).filter(isLocalMarkdown).map(href => ({ href, target: resolveLink(file, href) }));
}

function brokenLinks(bundle: string, concepts: Concept[]): Finding[] {
	const findings: Finding[] = [];
	for (const concept of concepts) for (const { href, target } of localLinks(concept.file, concept.body)) {
		if (target.startsWith("../") || !existsSync(join(bundle, target))) {
			findings.push({ code: "broken-link", file: concept.file, target: href, message: `${concept.file}: link target ${href} does not exist in the bundle.` });
		}
	}
	return findings;
}

/** Rewrite relative Markdown links after files move. `moves` maps old to new bundle paths. */
export function rewriteLinks(bundle: string, moves: Record<string, string>): string[] {
	const changed: string[] = [];
	const moved = new Set(Object.values(moves));
	for (const file of conceptFiles(bundle).files) {
		const path = join(bundle, file);
		const text = readFileSync(path, "utf8");
		const head = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[0] ?? "";
		// A moved file's own relative links were written from its old location.
		const origin = moved.has(file) ? Object.keys(moves).find(k => moves[k] === file)! : file;
		const body = text.slice(head.length).replace(LINK, (whole, href: string) => {
			if (!isLocalMarkdown(href)) return whole;
			const target = resolveLink(origin, href);
			const next = moves[target] ?? target;
			if (next === target && origin === file) return whole;
			const relative = posix.relative(posix.dirname(file), next) || posix.basename(next);
			return whole.replace(href, relative + (/#.*$/.exec(href)?.[0] ?? ""));
		});
		if (head + body !== text) { writeFileSync(path, head + body); changed.push(file); }
	}
	return changed;
}

// ------------------------------------------------------------------ validation

export interface Validation { ok: boolean; conceptCount: number; findings: Finding[]; advisories: Finding[] }

/** Read-only structural check. Generated navigation is checked by the caller
 * (see view.ts) so this module has no dependency on how the index is rendered. */
export function validateConcepts(bundle: string, now = new Date()): Validation & { concepts: Concept[] } {
	const { concepts, findings } = loadConcepts(bundle);
	findings.push(...brokenLinks(bundle, concepts));
	const today = now.toISOString().slice(0, 10);
	const advisories: Finding[] = concepts.filter(c => c.staleAfter && c.staleAfter < today)
		.map(c => ({ code: "stale" as const, file: c.file, message: `${c.file}: stale_after ${c.staleAfter} has passed; review the facts before relying on it.` }));
	return { ok: findings.length === 0, conceptCount: concepts.length, findings, advisories, concepts };
}

// ---------------------------------------------------------------------- writes

export interface WriteRequest {
	id: string; title?: string; description?: string; type?: string; status?: string;
	tags?: string[]; pinned?: boolean;
	/** Replace the whole body. */ body?: string;
	/** Append a section to the existing body. */ append?: string;
	actor?: string; now?: Date;
}

function atomicWrite(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text);
	renameSync(temporary, path);
}

function refuseSymlinks(bundle: string, file: string) {
	for (let dir = dirname(join(bundle, file)); dir.length >= bundle.length; dir = dirname(dir)) {
		if (existsSync(dir) && lstatSync(dir).isSymbolicLink() && dir !== bundle) throw new Error("Symlinked concept directory refused.");
		if (dir === bundle) break;
	}
	const path = join(bundle, file);
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Symlinked concept file refused.");
}

/** Create or update one concept file. Navigation and the log are the caller's job (memory.ts). */
export function writeConceptFile(bundle: string, request: WriteRequest): { created: boolean; concept: Concept } {
	const id = assertId(request.id.replace(/\.md$/, ""));
	const file = `${id}.md`, path = join(bundle, file);
	refuseSymlinks(bundle, file);
	const at = (request.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
	const stamp = `{ by: ${request.actor ?? "agent"}, at: "${at}" }`;
	const clean = (text: string) => { if (/^---\s*$/m.test(text.split("\n")[0] ?? "")) throw new Error("Body must not start with a frontmatter block; pass metadata as fields."); return text.replace(/\s+$/, ""); };
	const created = !existsSync(path);
	let doc: Parsed;
	if (created) {
		if (!request.title?.trim() || !request.description?.trim()) throw new Error(`Creating ${id} requires title and description.`);
		doc = { fields: [{ key: "type", raw: encodeScalar(request.type?.trim() || "Fact") }, { key: "title", raw: "" }, { key: "description", raw: "" }], body: "" };
		setField(doc, "created", `"${at}"`);
	} else {
		const parsed = parseDocument(readFileSync(path, "utf8"));
		if (!parsed) throw new Error(`${file} has no readable frontmatter; repair the file before updating it.`);
		doc = parsed;
		// Older files only carried the last-write stamp; keep it as the best-known creation time.
		if (!field(doc, "created")) { const prior = timestamp(field(doc, "generated")?.raw); if (prior) setField(doc, "created", `"${prior}"`); }
		if (request.type?.trim()) setField(doc, "type", encodeScalar(request.type));
	}
	if (request.title?.trim()) setField(doc, "title", encodeScalar(request.title));
	if (request.description?.trim()) setField(doc, "description", encodeScalar(request.description));
	if (request.status !== undefined) setField(doc, "status", request.status.trim() ? encodeScalar(request.status) : undefined);
	if (request.tags !== undefined) setField(doc, "tags", request.tags.length ? `[${request.tags.map(t => encodeScalar(t.trim())).filter(Boolean).join(", ")}]` : undefined);
	if (request.pinned !== undefined) setField(doc, "pinned", request.pinned ? "true" : undefined);
	setField(doc, "generated", stamp);
	if (request.body !== undefined) doc.body = `\n${clean(request.body)}\n`;
	if (request.append !== undefined) doc.body = `${doc.body.replace(/\s+$/, "")}\n\n${clean(request.append)}\n`.replace(/^\n*/, "\n");
	const text = serialize(doc);
	const concept = parseConcept(file, text);
	if (typeof concept === "string") throw new Error(`Refusing to write ${file}: ${concept}.`);
	atomicWrite(path, text);
	return { created, concept };
}

/** Move a concept and keep every relative link in the bundle pointing at it. */
export function moveConceptFile(bundle: string, from: string, to: string): string[] {
	const source = `${assertId(from.replace(/\.md$/, ""))}.md`, target = `${assertId(to.replace(/\.md$/, ""))}.md`;
	if (!existsSync(join(bundle, source))) throw new Error(`Concept ${JSON.stringify(from)} not found.`);
	if (existsSync(join(bundle, target))) throw new Error(`Concept ${JSON.stringify(to)} already exists.`);
	refuseSymlinks(bundle, source); refuseSymlinks(bundle, target);
	mkdirSync(dirname(join(bundle, target)), { recursive: true });
	renameSync(join(bundle, source), join(bundle, target));
	const changed = rewriteLinks(bundle, { [source]: target });
	for (let dir = dirname(join(bundle, source)); dir !== bundle && dir.startsWith(bundle); dir = dirname(dir)) {
		try { rmdirSync(dir); } catch { break; } // only empty directories disappear
	}
	return changed;
}

export function appendLog(bundle: string, line: string, now = new Date()) {
	const path = join(bundle, "log.md");
	const heading = `## ${now.toISOString().slice(0, 10)}`;
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	if (!existing) { appendFileSync(path, `${heading}\n${line}\n`); return; }
	// Newest day first, newest entry first within a day (the existing bundle convention).
	const next = existing.startsWith(heading) ? `${heading}\n${line}\n${existing.slice(heading.length).replace(/^\r?\n/, "")}` : `${heading}\n${line}\n\n${existing}`;
	atomicWrite(path, next);
}
