/** Local usage ledger. It decides which concepts earn a place in the injected index.
 * Machine-local and Git-ignored: reads must never create commits. */
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./store.js";

export type UsageKind = "session" | "open" | "hit" | "write" | "demote" | "seen";
interface Event { k: UsageKind | "snap"; id?: string; t?: string; sessions?: number; concepts?: Record<string, ConceptUsage> }
export interface ConceptUsage {
	/** Explicit reads (memory_show or a direct file read). */ opens: number;
	/** Appearances in the top three results of a search. */ hits: number;
	writes: number;
	/** Session counter value at the last open/write, the last use of any kind, and first sighting. */
	lastStrong?: number; lastAny?: number; first: number;
}
export interface UsageStats { sessions: number; concepts: Record<string, ConceptUsage>; available: boolean }

const LEDGER = "usage.jsonl";
const COMPACT_BYTES = 512 * 1024;
export const ledgerPath = (bundle: string) => join(bundle, STATE_DIR, LEDGER);

/** Only write once the bundle's ignore file excludes the ledger; otherwise a read
 * would dirty a tracked file and reopen a finished upgrade. */
function writable(bundle: string): boolean {
	try { return readFileSync(join(bundle, STATE_DIR, ".gitignore"), "utf8").split(/\r?\n/).includes(LEDGER); }
	catch { return false; }
}

function fold(stats: UsageStats, event: Event) {
	if (event.k === "snap") { stats.sessions = event.sessions ?? 0; stats.concepts = structuredClone(event.concepts ?? {}); return; }
	if (event.k === "session") { stats.sessions++; return; }
	if (!event.id) return;
	const usage = stats.concepts[event.id] ??= { opens: 0, hits: 0, writes: 0, first: stats.sessions };
	usage.lastAny = stats.sessions;
	if (event.k === "open") { usage.opens++; usage.lastStrong = stats.sessions; }
	else if (event.k === "write") { usage.writes++; usage.lastStrong = stats.sessions; }
	// A manual demotion sticks until the concept is opened or written again.
	else if (event.k === "demote") usage.lastStrong = undefined;
	// First sighting of a file that arrived outside the tools: starts its idle clock, earns no index place.
	else if (event.k === "hit") usage.hits++;
}

export function readUsage(bundle: string): UsageStats {
	const stats: UsageStats = { sessions: 0, concepts: {}, available: false };
	let text: string;
	try { text = readFileSync(ledgerPath(bundle), "utf8"); } catch { return stats; }
	stats.available = true;
	for (const line of text.split("\n")) {
		if (!line) continue;
		try { fold(stats, JSON.parse(line)); } catch { /* a torn trailing line is not worth failing a session */ }
	}
	return stats;
}

export function recordUsage(bundle: string, kind: UsageKind, ids: string[] = []) {
	if (!writable(bundle)) return;
	const t = new Date().toISOString();
	const lines = kind === "session" ? [JSON.stringify({ k: kind, t })] : ids.map(id => JSON.stringify({ k: kind, id, t }));
	if (!lines.length) return;
	try {
		const path = ledgerPath(bundle);
		appendFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
		if (statSync(path).size > COMPACT_BYTES) {
			const stats = readUsage(bundle);
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, JSON.stringify({ k: "snap", sessions: stats.sessions, concepts: stats.concepts }) + "\n", { mode: 0o600 });
			renameSync(temporary, path);
		}
	} catch { /* usage is advisory; never fail a read because the ledger is unwritable */ }
}

/** Sessions since a concept was last used (or first seen). Unknown concepts count from the ledger start. */
export function idleSessions(stats: UsageStats, id: string): number {
	const usage = stats.concepts[id];
	return stats.sessions - (usage ? usage.lastAny ?? usage.first : 0);
}

/** Rename usage history with a concept so a move does not look like a brand-new idea. */
export function renameUsage(bundle: string, from: string, to: string) {
	if (!writable(bundle) || !existsSync(ledgerPath(bundle))) return;
	const stats = readUsage(bundle);
	if (!stats.concepts[from]) return;
	stats.concepts[to] = stats.concepts[from]!; delete stats.concepts[from];
	const path = ledgerPath(bundle), temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ k: "snap", sessions: stats.sessions, concepts: stats.concepts }) + "\n", { mode: 0o600 });
	renameSync(temporary, path);
}

/** One-time seed from pi session logs so a converted bundle starts with real history
 * instead of treating every concept as unused. Best effort; any failure seeds nothing. */
export function backfillUsage(bundle: string, sessionDirs: string[], known: Map<string, string | undefined>): number {
	if (!writable(bundle) || existsSync(ledgerPath(bundle))) return 0;
	const events: { t: string; line: string }[] = [];
	const push = (t: string, event: object) => events.push({ t, line: JSON.stringify({ ...event, t }) });
	let sessions = 0;
	for (const dir of sessionDirs) {
		let names: string[];
		try { names = readdirSync(dir).filter(n => n.endsWith(".jsonl")).sort(); } catch { continue; }
		for (const name of names) {
			let text: string;
			try { text = readFileSync(join(dir, name), "utf8"); } catch { continue; }
			let started = false;
			for (const line of text.split("\n")) {
				if (!line.includes("okf-memory") && !line.includes("memory_s") && !line.includes("knowledge/")) continue;
				let entry: any;
				try { entry = JSON.parse(line); } catch { continue; }
				const t = typeof entry.timestamp === "string" ? entry.timestamp : "";
				if (!t) continue;
				if (entry.type === "custom_message" && entry.customType === "okf-memory" && !started) { started = true; sessions++; push(t, { k: "session" }); continue; }
				const message = entry.message;
				if (entry.type !== "message" || !message || !Array.isArray(message.content)) continue;
				if (message.role === "assistant") for (const block of message.content) {
					if (block?.type !== "toolCall") continue;
					const args = block.arguments ?? {};
					const id = block.name === "memory_show" ? String(args.concept ?? "").replace(/\.md$/, "")
						: block.name === "read" ? /knowledge\/(.+?)\.md$/.exec(String(args.path ?? ""))?.[1] : undefined;
					if (id && known.has(id)) push(t, { k: "open", id });
				} else if (message.role === "toolResult" && message.toolName === "memory_search" && !message.isError) {
					try {
						const results = JSON.parse(message.content.map((b: any) => b?.text ?? "").join(""));
						for (const result of (Array.isArray(results) ? results : []).slice(0, 3)) {
							const id = result?.concept_id ?? result?.concept;
							if (typeof id === "string" && known.has(id)) push(t, { k: "hit", id });
						}
					} catch { /* older or truncated result */ }
				}
			}
		}
	}
	if (!sessions) return 0;
	// Creation starts a concept's idle clock, so recent additions are not mistaken for unused ones.
	for (const [id, created] of known) if (created) push(new Date(created).toISOString(), { k: "write", id });
	events.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
	writeFileSync(ledgerPath(bundle), events.map(e => e.line).join("\n") + "\n", { mode: 0o600 });
	return events.length;
}
