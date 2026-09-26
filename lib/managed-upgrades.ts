import { randomUUID } from "node:crypto";
import { buildContextEntries, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UpgradeRunner } from "./upgrades.js";

export const UPGRADE_HOST = {
	request: "okf:upgrade:request",
	response: "okf:upgrade:response",
	ready: "okf:upgrade:ready",
	maintenance: "okf:upgrade:maintenance",
} as const;

export interface UpgradeSnapshot {
	packageVersion: string;
	binary: string | null;
	version: string | null;
	notice: string;
	status: ReturnType<UpgradeRunner["status"]> | null;
	lock: ReturnType<UpgradeRunner["lockInfo"]>;
}
export interface HostBinding {
	session: string;
	bundle: string;
	packageVersion: string;
}
export type UpgradeHostRequest = { protocol: 1; id: string } & (
	{ action: "status" } |
	(HostBinding & (
		{ action: "run"; runtimeId: string } |
		{ action: "cancel"; runId: string } |
		{ action: "hold"; key: string; held: boolean } |
		{ action: "recover"; lockToken: string; stoppedRuntimeId: string; previousRuntimeStopped: true }
	))
);
export type HostPhase = "status" | "queued" | "running" | "finishing" | "stopping" | "completed" | "blocked" | "cancelled" | "held" | "recovered" | "cancel_requested";
export interface UpgradeHostResponse {
	protocol: 1;
	id: string;
	session: string | null;
	packageVersion: string;
	phase: HostPhase;
	terminal: boolean;
	code?: string;
	message?: string;
	result?: unknown;
	target?: HostBinding;
	runtimeId?: string;
	snapshot?: UpgradeSnapshot;
	maintenance: { active: boolean; runId: string | null; holds: string[] };
}
interface Run {
	request: Extract<UpgradeHostRequest, { action: "run" }>;
	deadline: number;
	dispatchedAt?: number;
	reviewDispatched?: boolean;
	prompt?: string;
	started: boolean;
	settled: boolean;
	outcome?: { phase: "completed" | "blocked" | "cancelled"; code?: string; message?: string; result?: unknown };
}
export interface ManagedHooks {
	packageVersion: string;
	snapshot(ctx: ExtensionContext): UpgradeSnapshot;
	interactiveActive(): boolean;
	start(ctx: ExtensionContext, request: Extract<UpgradeHostRequest, { action: "run" }>): boolean;
	release(): void;
	recover(ctx: ExtensionContext, token: string, runtimeId: string): void;
	/** Test seams, not a persona/operator policy surface. */
	timing?: { pollMs?: number; timeoutMs?: number; dispatchMs?: number };
}

/** Inspect the active, compaction-aware branch, not abandoned history. A result
 * cannot resolve a later reused ID. Aborted/error assistant calls never execute. */
export function idleBlocker(ctx: ExtensionContext): string | undefined {
	try {
		if (!ctx.isIdle()) return "agent_busy";
		if (ctx.hasPendingMessages()) return "pending_messages";
		const entries = buildContextEntries(ctx.sessionManager.getBranch());
		const outstanding = new Map<string, number>();
		const normalize = (id: string) => id.split("|")[0];
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
				for (const block of message.content) if (block.type === "toolCall") {
					const id = normalize(block.id);
					outstanding.set(id, (outstanding.get(id) ?? 0) + 1);
				}
			} else if (message.role === "toolResult") {
				const id = normalize(message.toolCallId);
				outstanding.set(id, Math.max(0, (outstanding.get(id) ?? 0) - 1));
			}
		}
		if ([...outstanding.values()].some(count => count > 0)) return "unresolved_tools";
	} catch { return "idle_state_unavailable"; }
}

const fingerprint = (r: Extract<UpgradeHostRequest, { action: "run" }>) => JSON.stringify([r.protocol, r.id, r.action, r.session, r.bundle, r.packageVersion, r.runtimeId]);
const terminal = (phase: HostPhase) => !["queued", "running", "finishing", "stopping"].includes(phase);
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 4000);

/** Trusted in-process host bridge, NOT a model tool, RPC server, or permission
 * boundary. A run request is explicit consent for all installed pending steps
 * and the final local commit. No config, allowlist, network fetch or auto-retry. */
export function registerManagedUpgrades(pi: ExtensionAPI, hooks: ManagedHooks) {
	let ctx: ExtensionContext | undefined;
	let session: string | null = null;
	let run: Run | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe: (() => void) | undefined;
	const holds = new Set<string>();
	const history = new Map<string, { request: string; response: UpgradeHostResponse }>();
	const pollMs = hooks.timing?.pollMs ?? 1000;
	const timeoutMs = hooks.timing?.timeoutMs ?? 30 * 60_000;
	const dispatchMs = hooks.timing?.dispatchMs ?? 30_000;
	const maintenance = () => ({ active: run?.dispatchedAt !== undefined, runId: run?.request.id ?? null, holds: [...holds] });

	function publish(id: string, phase: HostPhase, extra: Partial<UpgradeHostResponse> = {}, remember = false) {
		let snapshot: UpgradeSnapshot | undefined;
		try { if (ctx) snapshot = hooks.snapshot(ctx); } catch { /* error is reported by the requesting operation */ }
		const target = run?.request.id === id ? { session: run.request.session, bundle: run.request.bundle, packageVersion: run.request.packageVersion } : undefined;
		const response: UpgradeHostResponse = { protocol: 1, id, session, packageVersion: hooks.packageVersion, phase, terminal: terminal(phase), snapshot, target, runtimeId: target ? run?.request.runtimeId : undefined, ...extra, maintenance: maintenance() };
		if (remember && run) history.set(id, { request: fingerprint(run.request), response });
		while (history.size > 128) history.delete(history.keys().next().value!);
		pi.events.emit(UPGRADE_HOST.response, structuredClone(response));
		return response;
	}
	function activity() {
		pi.events.emit(UPGRADE_HOST.maintenance, { protocol: 1, session, packageVersion: hooks.packageVersion, ...maintenance() });
	}
	function audit(event: string, detail?: unknown) {
		try {
			pi.appendEntry("okf-upgrade-host", { event, id: run?.request.id, runtimeId: run?.request.runtimeId, bundle: run?.request.bundle, packageVersion: hooks.packageVersion, session, detail });
		} catch (err) { console.warn(`[okf-upgrade] Could not record cooperative host trace: ${messageOf(err)}`); }
	}
	function clearTimer() { if (timer) clearTimeout(timer); timer = undefined; }
	function wake(delay = 0) {
		if (!run) return;
		clearTimer();
		timer = setTimeout(tick, delay);
		timer.unref?.();
	}
	function end() {
		if (!run?.outcome) return;
		const ending = run;
		clearTimer();
		if (ending.dispatchedAt !== undefined) {
			try { hooks.release(); }
			catch (err) { ending.outcome = { phase: "blocked", code: "release_failed", message: messageOf(err) }; }
		}
		audit(ending.outcome!.phase, ending.outcome);
		// Keep the request around only while constructing its final receipt.
		run = undefined;
		const response = publish(ending.request.id, ending.outcome!.phase, { ...ending.outcome, target: { session: ending.request.session, bundle: ending.request.bundle, packageVersion: ending.request.packageVersion }, runtimeId: ending.request.runtimeId });
		history.set(ending.request.id, { request: fingerprint(ending.request), response });
		activity();
	}
	function stop(phase: "blocked" | "cancelled", code: string, message: string) {
		if (!run) return;
		run.outcome = { phase, code, message };
		if (run.dispatchedAt === undefined) { end(); return; }
		publish(run.request.id, "stopping", { code, message }, true);
		wake(); // Never release a running agent's lock merely because a timer expired.
	}
	function defer(reason: string) {
		if (!run) return;
		const last = history.get(run.request.id)?.response;
		if (last?.phase !== "queued" || last.code !== reason) publish(run.request.id, "queued", { code: reason }, true);
		wake(pollMs);
	}
	function tick() {
		timer = undefined;
		if (!run || !ctx) return;
		const now = Date.now();
		if (run.dispatchedAt !== undefined) {
			if (!run.outcome && now >= run.deadline) stop("blocked", "deadline_exceeded", "Managed upgrade exceeded its deadline. Host must stop/reset a stuck runtime if it does not settle; no lock was stolen and no process was killed.");
			if (!run) return;
			if (!run.started && !run.outcome && now - run.dispatchedAt >= dispatchMs) stop("blocked", "dispatch_not_started", "The upgrade agent turn did not start.");
			if (!run) return;
			if (run.settled && !run.outcome) stop("blocked", "review_incomplete", "Agent settled without verified upgrade completion. Inspect the transcript/status before retrying.");
			if (run?.outcome && !idleBlocker(ctx) && (run.settled || !run.reviewDispatched)) end();
			else wake(pollMs);
			return;
		}
		if (now >= run.deadline) { stop("blocked", "idle_deadline_exceeded", "No safe idle maintenance window before the deadline."); return; }
		try {
			const snapshot = hooks.snapshot(ctx);
			if (snapshot.status?.bundle !== run.request.bundle || run.request.session !== session) { stop("blocked", "scope_changed", "Session or knowledge bundle changed; request a fresh status and run."); return; }
			const blocker = idleBlocker(ctx) ?? (hooks.interactiveActive() ? "interactive_review_active" : holds.size ? "host_hold" : undefined);
			if (blocker) { defer(blocker); return; }
			run.dispatchedAt = now;
			activity(); // A host can defer its own future maintenance before dispatch.
			// Event listeners can enqueue ordinary input; recheck after notifying.
			if (idleBlocker(ctx) || holds.size) { run.dispatchedAt = undefined; activity(); defer("activity_changed"); return; }
			audit("started");
			const launching = run;
			publish(run.request.id, "running", {}, true);
			if (run !== launching || launching.outcome) { wake(); return; }
			if (idleBlocker(ctx)) { run.dispatchedAt = undefined; activity(); defer("activity_changed"); return; }
			run.reviewDispatched = hooks.start(ctx, run.request);
			wake(run.outcome ? 0 : pollMs);
		} catch (err) { stop("blocked", "start_failed", messageOf(err)); }
	}

	function receive(raw: unknown) {
		const data = raw as Partial<UpgradeHostRequest> | null;
		if (!data || !text(data.id, 128)) return;
		const fail = (code: string, message: string) => publish(data.id!, "blocked", { code, message });
		if (data.protocol !== 1) { fail("unsupported_protocol", "Expected protocol 1."); return; }
		if (!ctx || !session) { fail("not_ready", "Wait for okf:upgrade:ready, then request status."); return; }
		try {
			const snapshot = hooks.snapshot(ctx);
			if (data.action === "status") { publish(data.id, "status"); return; }
			if (!snapshot.status) { fail("no_bundle", "No knowledge bundle is resolved in this session."); return; }
			if (!("session" in data) || !text(data.bundle, 4096) || data.session !== session || data.packageVersion !== hooks.packageVersion || data.bundle !== snapshot.status.bundle) {
				fail("binding_mismatch", "Use the current session, canonical bundle and installed packageVersion from status. Old runtime requests cannot authorize a new runtime."); return;
			}
			if (data.action === "hold" && text(data.key) && typeof data.held === "boolean") {
				if (data.held && run?.dispatchedAt !== undefined) { fail("maintenance_busy", "An upgrade already owns the maintenance slot; defer the other maintenance."); return; }
				if (data.held) holds.add(data.key); else holds.delete(data.key);
				publish(data.id, "held"); activity(); wake(); return;
			}
			if (data.action === "recover" && text(data.lockToken) && text(data.stoppedRuntimeId) && data.previousRuntimeStopped === true) {
				if (run || hooks.interactiveActive() || idleBlocker(ctx)) { fail("maintenance_busy", "Recovery requires an idle runtime with no active/queued review."); return; }
				try { hooks.recover(ctx, data.lockToken, data.stoppedRuntimeId); }
				catch (err) { fail("recovery_refused", messageOf(err)); return; }
				audit("host_recovery", { id: data.id, bundle: data.bundle, stoppedRuntimeId: data.stoppedRuntimeId });
				publish(data.id, "recovered"); return;
			}
			if (data.action === "cancel" && text(data.runId)) {
				if (run?.request.id !== data.runId) { fail("run_not_active", "The specified managed run is not active."); return; }
				stop("cancelled", "host_cancelled", "Host cancelled the managed upgrade. Edits/staging/commits are not rolled back.");
				publish(data.id, "cancel_requested"); return;
			}
			if (data.action !== "run" || !text(data.runtimeId)) { fail("invalid_request", "Expected status, run, hold, cancel, or recover with its documented fields."); return; }
			const request = data as Extract<UpgradeHostRequest, { action: "run" }>;
			const previous = history.get(request.id);
			if (previous) {
				if (previous.request !== fingerprint(request)) fail("id_conflict", "Use a fresh request ID when changing request fields.");
				else pi.events.emit(UPGRADE_HOST.response, structuredClone(previous.response));
				return;
			}
			if (run) { fail("run_active", "Another managed request already owns or awaits this runtime's upgrade slot."); return; }
			run = { request: structuredClone(request), started: false, settled: false, deadline: Date.now() + timeoutMs };
			audit("requested");
			publish(request.id, "queued", {}, true);
			wake(); // Outside session_start/agent_settled dispatch and after other startup handlers.
		} catch (err) { fail("inspection_failed", messageOf(err)); }
	}

	function attach() { if (!unsubscribe) unsubscribe = pi.events.on(UPGRADE_HOST.request, receive); }
	attach();
	pi.on("session_start", (_event, nextCtx) => {
		if (run) { run.outcome = { phase: "cancelled", code: "session_changed", message: "Session changed; request fresh status before resuming." }; end(); }
		ctx = nextCtx; session = randomUUID(); holds.clear(); history.clear(); attach();
		pi.events.emit(UPGRADE_HOST.ready, { protocol: 1, session, packageVersion: hooks.packageVersion });
	});
	// Input acceptance precedes potentially slow auth/model preflight. A quiet
	// isIdle() alone cannot prove an issued prompt will never execute later.
	pi.on("input", (event, nextCtx) => {
		ctx = nextCtx;
		if (run?.prompt && event.source === "extension" && event.text.includes(run.prompt)) run.started = true;
	});
	pi.on("agent_start", (_event, nextCtx) => { ctx = nextCtx; if (run?.dispatchedAt !== undefined) run.started = true; });
	pi.on("agent_settled", (_event, nextCtx) => { ctx = nextCtx; if (run?.dispatchedAt !== undefined) run.settled = true; wake(); });
	pi.on("session_shutdown", () => {
		if (run) { run.outcome = { phase: "cancelled", code: "runtime_shutdown", message: "Runtime shut down; durable progress is preserved." }; end(); }
		clearTimer(); unsubscribe?.(); unsubscribe = undefined; ctx = undefined; session = null; holds.clear(); history.clear();
	});

	return {
		get held() { return holds.size > 0; },
		get running() { return run?.dispatchedAt !== undefined; },
		get stopping() { return !!run?.outcome; },
		get requestId() { return run?.request.id; },
		expectPrompt(prompt: string) {
			if (!run) throw new Error("No managed request owns this prompt.");
			run.prompt = prompt; run.reviewDispatched = true;
		},
		complete(result: { finished: boolean; commit: string }) {
			if (!run || !result.finished || !/^[a-f0-9]{40,64}$/.test(result.commit)) throw new Error("Managed completion requires a verified Git commit.");
			run.outcome = { phase: "completed", result };
			publish(run.request.id, "finishing", { result }, true); wake();
		},
		progress() { if (run) publish(run.request.id, "running", {}, true); },
		block(reason: string) { stop("blocked", "needs_attention", reason.slice(0, 4000)); },
		cancel() { stop("cancelled", "operator_cancelled", "Operator cancelled the managed upgrade; no rollback was performed."); },
	};
}
