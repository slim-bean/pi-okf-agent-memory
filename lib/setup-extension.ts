import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { idleBlocker } from "./managed-upgrades.js";
import { inspectSetup, requireSetup, setupBundle, type SetupStatus } from "./setup.js";
import { configuredOwnership } from "./ownership.js";

export const SETUP_HOST = { ready: "okf:setup:ready", request: "okf:setup:request", response: "okf:setup:response" } as const;
export type SetupHostRequest = { protocol: 1; id: string } & (
	{ action: "status" } |
	{ action: "run"; session: string; packageVersion: string; bundle: string; planId: string; runtimeId: string }
);
export interface SetupHostResponse {
	protocol: 1;
	id: string;
	session: string | null;
	packageVersion: string;
	phase: "status" | "completed" | "blocked";
	terminal: true;
	status?: SetupStatus;
	code?: string;
	message?: string;
	runtimeId?: string;
}
interface Options {
	packageVersion: string;
	getBinary(): string;
	busy(): boolean;
	onReady?(ctx: ExtensionContext): void;
}
const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Setup is deterministic and synchronous (bounded CLI calls), not an agent
 * job. Busy requests fail explicitly; hosts choose when/backoff to retry. */
export function registerSetup(pi: ExtensionAPI, options: Options) {
	let ctx: ExtensionContext | undefined, session: string | null = null;
	let active = false;
	let unsubscribe: (() => void) | undefined;
	const prompted = new Set<string>();
	const history = new Map<string, { fingerprint: string; response: SetupHostResponse }>();
	const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 4000);
	const busy = (context: ExtensionContext) => idleBlocker(context) ?? (options.busy() ? "memory_maintenance_active" : undefined);
	function refresh(context: ExtensionContext, notify = false) {
		const status = inspectSetup(context.cwd);
		const message = status.phase === "ready" ? "" : `Memory setup ${status.phase}: ${status.bundle}. ${status.error ?? "A Git-backed knowledge bundle is required."} Run /memory-setup.`;
		if (context.hasUI) {
			context.ui.setStatus("okf-setup", message ? "memory setup required — /memory-setup" : undefined);
			if (notify && message) context.ui.notify(message, "warning");
		}
		return status;
	}
	function report(context: ExtensionContext, message: string, warning = false) {
		if (context.hasUI) context.ui.notify(message, warning ? "warning" : "info");
		else pi.sendMessage({ customType: "okf-setup", content: message, display: true }, { deliverAs: "nextTurn" });
	}
	async function interactive(context: ExtensionContext) {
		if (active || busy(context)) throw new Error("Memory setup requires idle with no other memory maintenance. Retry /memory-setup when idle.");
		const plan = refresh(context);
		const full = configuredOwnership(context.cwd) === "full";
		if (plan.phase === "blocked") throw new Error(plan.error);
		if (plan.phase === "ready") { report(context, `Memory setup ready: ${plan.bundle} (Git worktree ${plan.repository}). ${full ? "Full-ownership maintenance handles pending upgrades without human approval." : "Upgrades remain a separate /memory-upgrade approval."}`); return; }
		if (!full && !context.hasUI) throw new Error("No interactive UI. Use the explicit okf:setup host protocol or provision the bundle before launching pi.");
		const binding = session;
		active = true;
		try {
			const approved = full || await context.ui.confirm("Set up Git-backed memory?", [
				`Bundle: ${plan.bundle}`,
				plan.createBundle ? "Create an empty OKF knowledge bundle." : "Preserve all existing knowledge files.",
				plan.initGit ? `Initialize Git inside ${plan.bundle} only; do not turn the parent project into a repository.` : `Use existing Git worktree: ${plan.repository}. No nested repository will be created.`,
				"No commit, author identity changes, remote, push, model turn, or upgrade approval. Existing Git configuration/templates are honored. Proceed?",
			].join("\n\n"));
			if (!approved) return;
			if (binding !== session || busy(context)) throw new Error("Session or activity changed during setup approval. Retry /memory-setup.");
			const status = setupBundle(context.cwd, options.getBinary(), plan);
			options.onReady?.(context);
			report(context, `Memory setup complete: ${status.bundle} (Git worktree ${status.repository}). ${full ? "Full-ownership maintenance will review and commit the baseline automatically; setup itself made no commit." : "Run /memory-upgrade to review and commit the baseline; setup did not approve upgrades or make a commit."}`);
		} finally { if (binding === session) { active = false; refresh(context); } }
	}
	function receive(raw: unknown) {
		const r = raw as Partial<SetupHostRequest> | null;
		if (!r || !text(r.id, 128)) return;
		const reply = (phase: SetupHostResponse["phase"], extra: Partial<SetupHostResponse> = {}) => {
			const response: SetupHostResponse = { protocol: 1, id: r.id!, session, packageVersion: options.packageVersion, phase, terminal: true, ...extra };
			pi.events.emit(SETUP_HOST.response, structuredClone(response));
			return response;
		};
		const fail = (code: string, message: string) => reply("blocked", { code, message });
		if (r.protocol !== 1) { fail("unsupported_protocol", "Expected protocol 1."); return; }
		if (!ctx || !session) { fail("not_ready", "Wait for okf:setup:ready then request status."); return; }
		if (r.action === "status") { reply("status", { status: inspectSetup(ctx.cwd) }); return; }
		if (r.action !== "run" || !text(r.runtimeId) || !text(r.bundle, 4096) || !text(r.planId, 128)) { fail("invalid_request", "Expected status or a fully bound run request."); return; }
		if (r.session !== session || r.packageVersion !== options.packageVersion) { fail("binding_mismatch", "Request fresh setup status for this runtime and installed package."); return; }
		const fingerprint = JSON.stringify([r.session, r.packageVersion, r.bundle, r.planId, r.runtimeId]);
		const previous = history.get(r.id);
		if (previous) {
			if (previous.fingerprint !== fingerprint) fail("id_conflict", "Use a new request ID when changing fields.");
			else pi.events.emit(SETUP_HOST.response, structuredClone(previous.response));
			return;
		}
		const plan = inspectSetup(ctx.cwd);
		if (r.bundle !== plan.bundle || r.planId !== plan.planId) { fail("binding_mismatch", "Setup path/plan changed. Request fresh status and approval."); return; }
		if (active || busy(ctx)) { fail("maintenance_busy", "Setup requires idle, no pending messages/unresolved tools, and no active or queued memory maintenance. Retry with a new ID after that work ends."); return; }
		active = true;
		let response: SetupHostResponse;
		try {
			const status = setupBundle(ctx.cwd, options.getBinary(), plan);
			response = { protocol: 1, id: r.id, session, packageVersion: options.packageVersion, phase: "completed", terminal: true, status, runtimeId: r.runtimeId };
		} catch (err) {
			response = { protocol: 1, id: r.id, session, packageVersion: options.packageVersion, phase: "blocked", terminal: true, code: "setup_failed", message: messageOf(err), status: inspectSetup(ctx.cwd), runtimeId: r.runtimeId };
		} finally { active = false; refresh(ctx); }
		if (response.phase === "completed") options.onReady?.(ctx);
		history.set(r.id, { fingerprint, response });
		while (history.size > 128) history.delete(history.keys().next().value!);
		try { pi.appendEntry("okf-setup-host", { ...response, bundle: r.bundle }); }
		catch (err) { console.warn(`[okf-setup] Could not record cooperative setup trace: ${messageOf(err)}`); }
		pi.events.emit(SETUP_HOST.response, structuredClone(response));
	}
	function attach() { if (!unsubscribe) unsubscribe = pi.events.on(SETUP_HOST.request, receive); }
	attach();
	pi.registerCommand("memory-setup", {
		description: "Create/repair Git-backed memory setup with confirmation; status is read-only",
		handler: async (args, context) => {
			try {
				if (args.trim() === "status") { report(context, JSON.stringify(refresh(context), null, 2)); return; }
				if (args.trim()) throw new Error("Usage: /memory-setup [status]");
				await interactive(context);
			} catch (err) { report(context, messageOf(err), true); }
		},
	});
	pi.on("session_start", async (_event, context) => {
		ctx = context; session = randomUUID(); active = false; history.clear(); attach();
		pi.events.emit(SETUP_HOST.ready, { protocol: 1, session, packageVersion: options.packageVersion });
		const status = refresh(context, true);
		// RPC has UI but may have no operator; never open unsolicited RPC dialogs.
		// manual also supports provisioned TUI sessions with no attached operator.
		const mode = process.env.OKF_SETUP_MODE ?? "prompt";
		if (!["prompt", "manual"].includes(mode)) { report(context, "Invalid OKF_SETUP_MODE; use prompt or manual. Startup setup was not attempted.", true); return; }
		if (configuredOwnership(context.cwd) === "full" || mode === "manual" || context.mode !== "tui" || !context.hasUI || status.phase !== "needed" || prompted.has(status.bundle) || busy(context)) return;
		prompted.add(status.bundle);
		try { await interactive(context); }
		catch (err) { report(context, messageOf(err), true); }
	});
	pi.on("before_agent_start", (_event, context) => {
		const status = refresh(context);
		if (status.phase !== "ready") return { message: { customType: "okf-setup-status", display: false,
			content: configuredOwnership(context.cwd) === "full"
				? `Memory setup ${status.phase} at ${status.bundle}: ${status.error ?? "Git-backed bundle required"}. Full agent ownership is configured. The session-maintenance coordinator owns automatic setup/recovery at safe idle; no human approval or console answer is expected. Do not race another memory writer.`
				: `Memory setup ${status.phase} at ${status.bundle}: ${status.error ?? "Git-backed bundle required"}. Ask for /memory-setup or explicit host setup. Do not initialize memory or Git autonomously. No setup/upgrade consent is inferred from this notice.` } };
	});
	pi.on("session_shutdown", () => { session = null; ctx = undefined; active = false; history.clear(); unsubscribe?.(); unsubscribe = undefined; });
	return { get active() { return active; }, requireReady: requireSetup };
}
