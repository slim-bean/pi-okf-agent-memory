import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { binaryVersion, requireCurrentContract, supportsCurrentContract } from "./okf.js";
import { UpgradeRunner, type UpgradeStep } from "./upgrades.js";
import { configuredOwnership } from "./ownership.js";
import { registerManagedUpgrades, type ManagedHooks, type UpgradeSnapshot } from "./managed-upgrades.js";

interface Options {
	skillsDir: string;
	packageVersion: string;
	getBinary: () => string;
	getBundle: (cwd: string) => string | null;
	steps?: readonly UpgradeStep[];
	hostTiming?: ManagedHooks["timing"];
	setupBusy?: () => boolean;
	requireSetup?: (cwd: string) => unknown;
}

export function registerUpgrades(pi: ExtensionAPI, options: Options) {
	let active: UpgradeRunner | undefined;
	let activeMode: "interactive" | "host" | undefined;
	let fullAuthority = false;
	let managed: ReturnType<typeof registerManagedUpgrades> | undefined;
	let approvalGeneration = 0;
	let interactiveApprovals = 0;
	let modelTurn = 0;
	let delivered: { step: string; turn: number } | undefined;
	const runnerFor = (cwd: string) => {
		const bundle = options.getBundle(cwd);
		return bundle ? new UpgradeRunner(bundle, options.skillsDir, options.packageVersion, options.steps) : null;
	};
	const result = (text: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text }], details });
	const report = (ctx: ExtensionContext, text: string, warning = false) => {
		if (ctx.hasUI) ctx.ui.notify(text, warning ? "warning" : "info");
		else pi.sendMessage({ customType: "okf-upgrade", content: text, display: true }, { deliverAs: "nextTurn" });
	};

	async function confirm(ctx: ExtensionContext, title: string, message: string) {
		const generation = approvalGeneration;
		interactiveApprovals++;
		try { return await ctx.ui.confirm(title, message); }
		finally { if (generation === approvalGeneration) interactiveApprovals--; }
	}

	function inspect(cwd: string) {
		const runner = runnerFor(cwd);
		if (!runner) return { runner, status: null, notice: "", binary: null, version: null };
		const status = runner.status();
		const binary = options.getBinary();
		const version = binaryVersion(binary);
		const compatibility = supportsCurrentContract(version) ? "" : `OKF ${version} is outside the tested range >=0.4.3 <0.5.0. Correct OKF_BIN or use the bundled binary. `;
		const notice = compatibility + (status.pending.length
			? `pi-okf-agent-memory ${options.packageVersion}: ${status.pending.length} bundle upgrade step(s) pending${status.baseline === "unassessed" ? " (baseline not yet assessed)" : ""}. Run /memory-upgrade to review them in order.${status.locked ? " A review currently holds the bundle lock." : ""}`
			: status.versionPending
				? `pi-okf-agent-memory ${options.packageVersion} has not been adopted by this bundle (last ${status.appliedPackageVersion ?? "unassessed"}). Run /memory-upgrade to verify and commit the installed version.`
				: status.finalization.pending
				? `pi-okf-agent-memory: upgrade checks are recorded, but the required final commit is pending. Run /memory-upgrade to finalize.${status.finalization.error ? ` ${status.finalization.error}` : ""}`
				: compatibility ? "Run /memory-upgrade status." : "");
		let setupNotice = "";
		try { options.requireSetup?.(cwd); } catch (err) { setupNotice = err instanceof Error ? err.message : String(err); }
		return { runner, status, notice: setupNotice || notice, binary, version };
	}

	function snapshot(ctx: ExtensionContext): UpgradeSnapshot {
		const { runner, ...data } = inspect(ctx.cwd);
		return { packageVersion: options.packageVersion, ...data, lock: runner?.lockInfo() ?? null };
	}

	function refresh(ctx: ExtensionContext, notify = false) {
		let notice: string;
		try { notice = inspect(ctx.cwd).notice; }
		catch (err) { notice = `Memory upgrade check failed: ${err instanceof Error ? err.message : String(err)} Run /memory-upgrade status.`; }
		if (ctx.hasUI) {
			ctx.ui.setStatus("okf-upgrade", notice ? "memory upgrade pending — /memory-upgrade" : undefined);
			// Keep the extra banner in the TUI; RPC clients receive status/notifications.
			if (ctx.mode === "tui") ctx.ui.setWidget("okf-upgrade", notice ? [notice] : undefined);
			if (notify && notice) ctx.ui.notify(notice, "warning");
		}
		return notice;
	}

	function release() {
		try { active?.release(); }
		finally { active = undefined; activeMode = undefined; fullAuthority = false; delivered = undefined; }
	}

	function requireActive(ctx: ExtensionContext) {
		const bundle = options.getBundle(ctx.cwd);
		if (activeMode === "host" && managed?.stopping) throw new Error("The managed upgrade is finishing or stopping; do not perform further upgrade work.");
		if (!active || active.bundle !== bundle) throw new Error("No user-approved or host-approved upgrade review for this bundle. Ask the user to run /memory-upgrade or wait for the host; do not edit upgrade state manually.");
		return active;
	}

	function instructions(runner: UpgradeRunner): string {
		const next = runner.nextInstructions();
		if (!next) return "All upgrade step checks are recorded, but the final Git commit is required before success. Review any Git blockers, then call memory_upgrade(action=\"finalize\"). The approved workflow includes a local commit of all non-ignored bundle changes, not a push. Do not claim completion until the runner returns a commit hash.";
		const step = runner.status().pending[0].id;
		if (delivered?.step !== step) delivered = { step, turn: modelTurn };
		const consent = fullAuthority
			? "FULL AGENT MEMORY OWNERSHIP: this approved review has standing authority for scoped corpus/schema/governance/lifecycle repairs and the required local commit. No human will answer. Human approval clauses below are superseded: document evidence/checkpoints and proceed. Qualify or archive unsupported memory rather than blocking for facts or policy decisions. Preserve provenance; do not fabricate human verification or review dates. Do not change external project files, credentials, instructions or upgrade receipts, and do not push. Report a block only for a genuinely unavailable external resource/permission.\n"
			: activeMode === "host"
			? `HOST-MANAGED REVIEW (request ${managed?.requestId}): the host approved all pending upgrades for this installed package, including necessary upgrade-related repairs within this agent-owned bundle and the required local commit. No interactive user is waiting. For repair-plan approval clauses below, document the plan/checkpoint in the transcript and proceed within this scope; do not wait for a console answer. Do not change external project files, grant new governance authority, fabricate verification or review dates, push, sync, or replace instructions. If a step needs a policy decision or a fact you cannot establish, call memory_upgrade(action="block", reason="...") and report the blocker instead of inventing an answer.\n`
			: "The user approved an upgrade review AND the required final local commit of the agent-owned knowledge bundle, not arbitrary corpus rewrites or a push.\n";
		return consent + `Follow the package instructions below.\n` +
			`Resolved OKF executable: ${JSON.stringify(options.getBinary())} (use this exact path, shell-quoted; do not assume okf is on PATH).\n` +
			`When the current step is satisfied, call memory_upgrade(action="complete", step="${step}"). Do not batch multiple step completions in one model turn. ` +
			`The extension verifies it before advancing. Call memory_upgrade(action="next") to recover the current instructions after compaction.\n\n${next}`;
	}

	function finish(ctx: ExtensionContext, runner: UpgradeRunner) {
		try {
			const status = runner.finalize(options.getBinary());
			const hosted = activeMode === "host";
			if (hosted) managed!.complete(status); // retain the lease until the agent settles
			else release();
			refresh(ctx);
			return result(`Memory upgrade complete: all checks passed and the knowledge bundle was committed in ${status.commit}. Ledger: ${status.statePath}. No push was made.${hosted ? " Report this result and stop upgrade work; the host maintenance lease is released after this run settles." : ""}`, { ...status, locked: hosted });
		} catch (err) {
			refresh(ctx);
			throw err;
		}
	}

	/** Shared execution path: only its caller's consent source differs. */
	function begin(ctx: ExtensionContext, mode: "interactive" | "host", runtimeId?: string): boolean {
		if (active) throw new Error("An upgrade review already owns this session.");
		if (options.setupBusy?.()) throw new Error("Memory setup is awaiting approval/running; finish it before upgrading.");
		options.requireSetup?.(ctx.cwd);
		requireCurrentContract(options.getBinary());
		const runner = runnerFor(ctx.cwd);
		if (!runner) throw new Error("No knowledge bundle is resolved.");
		let status = runner.status();
		if (!status.finished) {
			runner.acquire(runtimeId);
			active = runner; activeMode = mode; fullAuthority = configuredOwnership(ctx.cwd) === "full";
			status = runner.status();
		}
		if (status.finished) {
			release();
			if (mode === "host") managed!.complete({ ...status, commit: status.finalization.commit! });
			else report(ctx, "Another review already completed and committed the pending upgrades; no agent turn was started.");
			refresh(ctx);
			return false;
		}
		if (!status.pending.length) {
			const finished = finish(ctx, runner);
			if (mode === "interactive") report(ctx, finished.content[0].text);
			return false;
		}
		try {
			if (mode === "host" && !pi.getActiveTools().includes("memory_upgrade")) throw new Error("memory_upgrade is not an active tool; enable it before requesting a managed review.");
			const prompt = instructions(runner);
			if (mode === "host") managed!.expectPrompt(prompt);
			pi.sendUserMessage(prompt);
		}
		catch (err) { if (mode !== "host") release(); throw err; }
		refresh(ctx);
		return true;
	}

	pi.registerTool({
		name: "memory_upgrade",
		label: "Memory Upgrade",
		description: "Inspect upgrade status, recover approved instructions, verify a step, or retry required Git finalization. The last step automatically commits the agent-owned bundle after verification; success requires that commit. A review requires interactive confirmation or an explicit host request; the model cannot start one itself. Use block to report decisions requiring attention during an unattended review. Never edit its ledger manually or skip steps.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("next"), Type.Literal("complete"), Type.Literal("finalize"), Type.Literal("block")]),
			reason: Type.Optional(Type.String({ maxLength: 4000, description: "Why an approved review cannot safely proceed (block action)" })),
			step: Type.Optional(Type.String({ description: "Exact current step ID; required for complete" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.action === "status") {
				const { status, binary, version, notice } = inspect(ctx.cwd);
				const data = { packageVersion: options.packageVersion, binary, version, notice, status };
				return result(JSON.stringify(data, null, 2), data);
			}
			const runner = requireActive(ctx);
			if (params.action === "block") {
				if (!params.reason?.trim()) throw new Error("Explain the blocker in reason.");
				if (activeMode === "host") managed!.block(params.reason);
				else release();
				refresh(ctx);
				return result(`Upgrade blocked: ${params.reason}. Do not continue upgrade work; report this to the operator/host. No rollback was made.`);
			}
			if (params.action === "next") return result(instructions(runner));
			if (params.action === "finalize") return finish(ctx, runner);
			if (!params.step) throw new Error("step is required for completion.");
			// Sibling tools may run concurrently. A completion result delivering
			// the NEXT guide is not permission to complete it in that same batch:
			// the model must get another request with those instructions first.
			if (delivered?.step === params.step && modelTurn <= delivered.turn) {
				throw new Error("Read the current step instructions in a subsequent model turn before completing it. Do not batch upgrade completions.");
			}
			const status = runner.complete(params.step, options.getBinary());
			if (status.pending.length) {
				if (activeMode === "host") managed!.progress();
				if (activeMode === "host" && managed?.stopping) return result("Managed upgrade is stopping. Do not proceed to another step.");
				refresh(ctx);
				return result(`Verified ${params.step}.\n\n${instructions(runner)}`, status);
			}
			return finish(ctx, runner);
		},
	});

	pi.registerCommand("memory-upgrade", {
		description: "Review pending memory upgrades in order; subcommands: status, cancel, unlock",
		handler: async (args, ctx) => {
			const action = args.trim() || "review";
			try {
				if (!["review", "status", "cancel", "unlock"].includes(action)) {
					report(ctx, "Usage: /memory-upgrade [status|cancel|unlock]", true);
					return;
				}
				if (action === "cancel") {
					if (!ctx.isIdle()) throw new Error("Stop the agent before cancelling its upgrade review.");
					approvalGeneration++; interactiveApprovals = 0;
					if (managed?.requestId) managed.cancel();
					else release();
					refresh(ctx);
					report(ctx, "Upgrade review cancelled. Completed steps remain recorded; unfinished steps remain pending. Corpus edits, staging, and commits were not rolled back.");
					return;
				}
				const full = configuredOwnership(ctx.cwd) === "full";
				if (full && action === "review") {
					const request: { protocol: 1; operation: string; result?: Promise<any> } = { protocol: 1, operation: "run" };
					pi.events.emit("pi-session-maintenance:control:v1", request);
					if (!request.result) throw new Error("Full ownership uses the autonomous maintenance coordinator. Load pi-session-maintenance or use the trusted okf:maintenance:v1 host adapter; no interactive approval is requested.");
					const status = await request.result; report(ctx, status.admission ?? "Autonomous memory maintenance requested; inspect /maintenance status."); return;
				}
				// Recovery must work even when the binary or ledger is broken.
				const runner = runnerFor(ctx.cwd);
				if (!runner) throw new Error("No OKF bundle found. Run /memory-setup or request explicit host setup first.");
				if (action === "unlock") {
					const expected = runner.recoverableLock();
					if (!expected) { report(ctx, "No upgrade lock exists."); return; }
					if (!full && !ctx.hasUI) throw new Error("Lock recovery requires interactive confirmation; nothing was changed.");
					const generation = approvalGeneration;
					if (full || await confirm(ctx, "Recover interrupted memory upgrade?",  "The local lock owner has stopped. Remove only its lock? Completed steps and corpus files will be preserved.")) {
						if (generation !== approvalGeneration || options.getBundle(ctx.cwd) !== runner.bundle) throw new Error("Session or bundle changed while awaiting recovery approval; retry.");
						runner.unlock(expected);
					}
					refresh(ctx);
					return;
				}
				const { status, version, notice } = inspect(ctx.cwd);
				if (!status) throw new Error("Knowledge bundle disappeared during inspection; retry.");
				if (action === "status") {
					pi.sendMessage({ customType: "okf-upgrade", content: JSON.stringify({ version, notice, ...status }, null, 2), display: true }, { deliverAs: "nextTurn" });
					return;
				}
				if (options.setupBusy?.()) throw new Error("Memory setup is awaiting approval/running; finish it before upgrading.");
				options.requireSetup?.(ctx.cwd);
				if (!version || !supportsCurrentContract(version)) throw new Error(notice);
				if (managed?.requestId) { report(ctx, `Managed request ${managed.requestId} is queued/running. Use /memory-upgrade status or cancel; do not start a second review.`); return; }
				if (status?.finished) {
					if (active?.bundle === runner.bundle) release();
					refresh(ctx);
					report(ctx, `All applicable memory upgrades are complete and recorded in Git (${status.finalization.commit}).`);
					return;
				}
				if (!ctx.isIdle()) throw new Error("Wait for the agent to finish, or stop it, before starting an upgrade review.");
				if (!ctx.hasUI) throw new Error("Upgrade review requires user confirmation in an interactive/RPC UI. Use memory_upgrade(action=\"status\") for unattended inspection; no automatic migration was started.");
				if (active) {
					if (active.bundle !== runner.bundle) throw new Error("Cancel the existing bundle's review before starting another.");
					if (!status?.pending.length) report(ctx, finish(ctx, active).content[0].text);
					else pi.sendUserMessage(instructions(active));
					return;
				}
				if (status.locked) throw new Error("Another review holds the bundle lock. Finish/cancel it there; after a crash use /memory-upgrade unlock.");
				const plan = status.pending.map(s => `${s.id}: ${s.title}`).join("\n") || "Step checks are already recorded. Re-verify and make the required final commit.";
				const generation = approvalGeneration;
				const approved = await confirm(ctx, "Review memory upgrades?", `${plan}\n\nBundle: ${runner.bundle}\nApprove review and the REQUIRED final local Git commit? The commit includes all non-ignored agent-owned bundle changes, including existing knowledge edits and upgrade records, but not unrelated files outside this bundle. No push, identity changes, or hook bypass. Corpus repairs or policy changes still require a separately approved plan. Success requires validation AND the commit.`);
				if (!approved) return;
				if (generation !== approvalGeneration || options.getBundle(ctx.cwd) !== runner.bundle || !ctx.isIdle()) {
					throw new Error("Session, bundle, or activity changed while awaiting approval. Run /memory-upgrade again.");
				}
				begin(ctx, "interactive");
			} catch (err) {
				report(ctx, err instanceof Error ? err.message : String(err), true);
			}
		},
	});

	pi.on("turn_start", () => { modelTurn++; });
	pi.on("session_start", (_event, ctx) => {
		// Approval is session-scoped; completion is bundle-scoped. Reconfirm after
		// switching/forking/reloading, even if old instructions remain in context.
		approvalGeneration++; interactiveApprovals = 0;
		try { release(); }
		catch (err) { report(ctx, `Could not release the previous upgrade lock: ${String(err)}`, true); }
		refresh(ctx, true);
	});
	pi.on("session_shutdown", () => { approvalGeneration++; interactiveApprovals = 0; release(); });
	pi.on("before_agent_start", (_event, ctx) => {
		const notice = refresh(ctx);
		if (!notice) return;
		const guidance = managed?.requestId
			? managed.stopping
				? "The host-managed upgrade is finishing/stopping. Do not perform further upgrade work. Report the result or blocker and let the run settle."
				: managed.running
					? "A host-managed upgrade is approved; use memory_upgrade(action=\"next\") if its current instructions are missing. No console confirmation is needed."
					: "The host has queued an upgrade for a safe idle window. Continue the current task; do not invoke the upgrade command yourself or ask for a console confirmation."
			: active && active.bundle === options.getBundle(ctx.cwd)
				? "An upgrade review is approved in this session; use memory_upgrade(action=\"next\") if its current instructions are missing."
				: configuredOwnership(ctx.cwd) === "full"
					? "Full agent memory ownership is configured. The session-maintenance coordinator owns automatic upgrades and repair at safe idle. Continue the current task without asking for human approval; never race its bundle lock or edit upgrade receipts yourself."
					: "Do not begin upgrades or edit their ledger autonomously. Normal read-only memory tools remain available; ask the user to run /memory-upgrade when convenient.";
		return { message: {
			customType: "okf-upgrade-status", display: false,
			content: `${notice}\n${guidance}`,
		} };
	});

	managed = registerManagedUpgrades(pi, {
		packageVersion: options.packageVersion,
		snapshot,
		interactiveActive: () => activeMode === "interactive" || interactiveApprovals > 0 || !!options.setupBusy?.(),
		start: (ctx, request) => begin(ctx, "host", request.runtimeId),
		release: () => { if (activeMode === "host") release(); },
		recover: (ctx, token, runtimeId) => {
			const runner = runnerFor(ctx.cwd);
			if (!runner) throw new Error("No knowledge bundle is resolved.");
			runner.recoverForHost(token, runtimeId);
		},
		timing: options.hostTiming,
	});
	return { refresh, get busy() { return !!active || interactiveApprovals > 0 || !!managed?.requestId || !!managed?.held; } };
}
