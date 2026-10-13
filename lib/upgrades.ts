import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { requireCurrentContract, validateBundle } from "./okf.js";
import { bundleCommitStatus, commitBundle } from "./git.js";

export interface UpgradeStep {
	id: string;
	title: string;
	instructions: string;
	verify: (binary: string, bundle: string) => void;
}

/** Append only. IDs and their meaning are stable across package releases.
 * Keep old instructions/verifiers runnable with the currently shipped binary. */
export const UPGRADE_STEPS: readonly UpgradeStep[] = [{
	id: "001-validation-contract",
	title: "Review the OKF 0.4 validation and governance contract",
	instructions: "001-validation-contract.md",
	verify(binary, bundle) {
		requireCurrentContract(binary);
		const result = validateBundle(binary, bundle);
		if (!result.ok) throw new Error(`Upgrade verification failed; progress was not advanced. Resolve findings with user approval, then retry.\n${JSON.stringify(result, null, 2)}`);
	},
}];

interface Completion {
	id: string;
	at: string;
	packageVersion: string;
	okfVersion: string;
}
interface State {
	schema: 1;
	completed: Completion[];
	/** Release adoption when a package changes without adding a migration step. */
	application?: { packageVersion: string; okfVersion: string };
}
interface Lock {
	token: string;
	host: string;
	pid: number;
	startedAt: string;
	/** Host-supplied runtime correlation, not an authentication credential. */
	runtimeId?: string;
}

function errorCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException)?.code;
}

/** Bundle-scoped, not session/global: aliases and shared workspaces agree on
 * completion. Startup/status only read. A lock covers the full approved review,
 * not just the final JSON write. It is advisory, not a filesystem sandbox. */
export class UpgradeRunner {
	readonly bundle: string;
	readonly stateDir: string;
	readonly statePath: string;
	readonly lockPath: string;
	readonly finalizePath: string;
	private token?: string;
	private delivered?: string;

	constructor(
		bundle: string,
		readonly skillsDir: string,
		readonly packageVersion: string,
		readonly steps: readonly UpgradeStep[] = UPGRADE_STEPS,
	) {
		this.bundle = realpathSync(bundle);
		this.stateDir = join(this.bundle, ".pi-okf-memory");
		this.statePath = join(this.stateDir, "state.json");
		this.lockPath = join(this.stateDir, "lock.json");
		this.finalizePath = join(this.stateDir, "finalize-pending");
		if (new Set(steps.map(s => s.id)).size !== steps.length || steps.some(s => !/^\d{3}-[a-z0-9-]+$/.test(s.id))) {
			throw new Error("Invalid upgrade registry: IDs must be unique and ordered explicitly.");
		}
	}

	private checkPaths() {
		for (const path of [this.stateDir, this.statePath, this.lockPath, this.finalizePath, join(this.stateDir, ".gitignore")]) {
			try {
				const stat = lstatSync(path);
				if (stat.isSymbolicLink() || (path === this.stateDir ? !stat.isDirectory() : !stat.isFile())) {
					throw new Error(`Unsafe upgrade state path: ${path}`);
				}
			} catch (err) {
				if (errorCode(err) !== "ENOENT") throw err;
			}
		}
	}

	readState(): State {
		this.checkPaths();
		let text: string;
		try { text = readFileSync(this.statePath, "utf8"); }
		catch (err) {
			if (errorCode(err) === "ENOENT") return { schema: 1, completed: [] };
			throw err;
		}
		let state: State;
		try { state = JSON.parse(text); }
		catch { throw new Error(`Invalid upgrade state JSON at ${this.statePath}; inspect/restore it, do not reset progress blindly.`); }
		if (!state || state.schema !== 1 || (state.application !== undefined && (!state.application || typeof state.application.packageVersion !== "string" || typeof state.application.okfVersion !== "string")) || !Array.isArray(state.completed) || state.completed.length > this.steps.length ||
			state.completed.some((item, i) => !item || item.id !== this.steps[i].id ||
				typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at)) ||
				typeof item.packageVersion !== "string" || typeof item.okfVersion !== "string")) {
			throw new Error(`Unsupported or out-of-order upgrade state at ${this.statePath}. This may be a package downgrade; use the matching newer package. No state was changed.`);
		}
		const recordedVersion = state.application?.packageVersion ?? state.completed.at(-1)?.packageVersion;
		const versionParts = (value: string) => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
		const recorded = recordedVersion && versionParts(recordedVersion), current = versionParts(this.packageVersion);
		if (recorded && current) {
			const firstDifferent = recorded.findIndex((part, i) => part !== current[i]);
			if (firstDifferent >= 0 && recorded[firstDifferent] > current[firstDifferent]) throw new Error(`Package downgrade refused: bundle adopted ${recordedVersion}, runtime is ${this.packageVersion}. Load the newer package.`);
		}
		return state;
	}

	status() {
		const state = this.readState();
		const pending = this.steps.slice(state.completed.length).map(({ id, title }) => ({ id, title }));
		const appliedPackageVersion = state.application?.packageVersion ?? state.completed.at(-1)?.packageVersion ?? null;
		const versionPending = appliedPackageVersion !== this.packageVersion;
		const finalization = state.completed.length > 0 && pending.length === 0
			? bundleCommitStatus(this.bundle)
			: { pending: false, commit: null };
		// A local intent marker survives crashes and post-commit hook edits. It
		// is deliberately excluded from Git; the committed ledger is portable.
		if (existsSync(this.finalizePath) || (versionPending && pending.length === 0)) finalization.pending = true;
		return {
			bundle: this.bundle,
			statePath: this.statePath,
			baseline: existsSync(this.statePath) ? "recorded" : "unassessed",
			packageVersion: this.packageVersion,
			appliedPackageVersion,
			versionPending,
			completed: state.completed,
			pending,
			finalization,
			finished: pending.length === 0 && !finalization.pending,
			locked: existsSync(this.lockPath),
		};
	}

	acquire(runtimeId?: string, recoverState?: (error: unknown) => void) {
		if (this.token) { this.assertOwnership(); return; }
		mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
		this.checkPaths();
		const token = randomUUID();
		let fd: number;
		try { fd = openSync(this.lockPath, "wx", 0o600); }
		catch (err) {
			if (errorCode(err) === "EEXIST") throw new Error("Another upgrade review holds this bundle's lock. Finish/cancel it there, or use /memory-upgrade unlock after a crash.");
			throw err;
		}
		try {
			writeFileSync(fd, JSON.stringify({ token, host: hostname(), pid: process.pid, startedAt: new Date().toISOString(), ...(runtimeId ? { runtimeId } : {}) } satisfies Lock));
			fsyncSync(fd);
		} catch (err) {
			unlinkSync(this.lockPath);
			throw err;
		} finally { closeSync(fd); }
		this.token = token;
		try {
			try { this.readState(); } catch (error) {
				if (!recoverState) throw error;
				recoverState(error); this.readState();
			}
			// Keep the portable completion ledger, not process-local locks, in Git.
			const ignore = join(this.stateDir, ".gitignore");
			const previous = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
			const missing = ["lock.json", ".state-*.tmp", "finalize-pending"].filter(line => !previous.split(/\r?\n/).includes(line));
			if (missing.length) writeFileSync(ignore, previous + (previous && !previous.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
		} catch (err) { this.release(); throw err; }
	}

	private assertOwnership() {
		this.checkPaths();
		if (!this.token || !existsSync(this.lockPath) || JSON.parse(readFileSync(this.lockPath, "utf8")).token !== this.token) {
			throw new Error("No approved upgrade review owns this bundle. Run /memory-upgrade first.");
		}
	}

	/** Return full package-owned instructions, never depend on skill routing. */
	nextInstructions(): string | null {
		this.assertOwnership();
		const state = this.readState();
		const step = this.steps[state.completed.length];
		if (!step) return null;
		const skillRoot = join(this.skillsDir, "okf-memory-upgrade");
		const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
		const guide = readFileSync(join(skillRoot, "steps", step.instructions), "utf8");
		if (Buffer.byteLength(skill + guide, "utf8") > 40_000) throw new Error("Upgrade instructions exceed the delivery budget; shorten this step instead of silently truncating it.");
		this.delivered = step.id;
		return `Upgrade ${state.completed.length + 1}/${this.steps.length}: ${step.id} — ${step.title}\n` +
			`Bundle: ${JSON.stringify(this.bundle)}\nInstruction base directory: ${JSON.stringify(skillRoot)}\n\n${skill}\n\n${guide}`;
	}

	complete(id: string, binary: string) {
		this.assertOwnership();
		const state = this.readState();
		const step = this.steps[state.completed.length];
		if (!step || id !== step.id || this.delivered !== id) {
			throw new Error("Cannot skip upgrade steps or complete an undelivered step. Request the next step and finish it in order.");
		}
		const version = requireCurrentContract(binary);
		step.verify(binary, this.bundle);
		this.assertOwnership();
		state.completed.push({ id, at: new Date().toISOString(), packageVersion: this.packageVersion, okfVersion: version });
		this.writeState(state);
		this.delivered = undefined;
		return this.status();
	}

	private writeState(state: State) {
		const temporary = join(this.stateDir, `.state-${randomUUID()}.tmp`);
		try {
			const fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, JSON.stringify(state, null, 2) + "\n"); fsyncSync(fd); }
			finally { closeSync(fd); }
			renameSync(temporary, this.statePath);
		} finally { if (existsSync(temporary)) unlinkSync(temporary); }
	}

	/** Final success means validated AND committed. Retrying a failed commit
	 * does not rewrite step timestamps or require the agent to repeat the review. */
	finalize(binary: string) {
		this.assertOwnership();
		const state = this.readState();
		if (!state.completed.length || state.completed.length !== this.steps.length) throw new Error("Complete every upgrade step before finalizing its commit.");
		writeFileSync(this.finalizePath, "Final commit pending; resume with /memory-upgrade.\n", { mode: 0o600 });
		try {
			const version = requireCurrentContract(binary);
			for (const step of this.steps) step.verify(binary, this.bundle);
			this.assertOwnership();
			if ((state.application?.packageVersion ?? state.completed.at(-1)?.packageVersion) !== this.packageVersion) {
				state.application = { packageVersion: this.packageVersion, okfVersion: version };
				this.writeState(state);
			}
			const commit = commitBundle(this.bundle, state.completed.at(-1)!.id);
			// Hooks can change content as well as reject a commit. A clean Git
			// worktree alone is not proof that the resulting bundle still passes.
			for (const step of this.steps) step.verify(binary, this.bundle);
			this.assertOwnership();
			unlinkSync(this.finalizePath);
			return { ...this.status(), commit };
		} catch (err) {
			throw new Error(`Upgrade checks are recorded, but finalization is incomplete. The final Git commit is required; fix the blocker and retry memory_upgrade(action="finalize") or /memory-upgrade. No push was attempted.\n${err instanceof Error ? err.message : String(err)}`);
		}
	}

	release() {
		if (!this.token) return;
		try {
			this.assertOwnership();
			unlinkSync(this.lockPath);
		} finally { this.token = undefined; this.delivered = undefined; }
	}

	lockInfo(): Lock | null {
		this.checkPaths();
		if (!existsSync(this.lockPath)) return null;
		const lock = JSON.parse(readFileSync(this.lockPath, "utf8"));
		if (!lock || typeof lock.token !== "string" || typeof lock.host !== "string" || !Number.isInteger(lock.pid) || lock.pid <= 0 || typeof lock.startedAt !== "string") throw new Error("Malformed upgrade lock; inspect it manually.");
		return lock;
	}

	/** An in-process host may attest that an old runtime has terminated. The
	 * host owns that infrastructure check; tokens/runtime IDs are correlation,
	 * not proof. Never displace a demonstrably live local process. */
	recoverForHost(token: string, runtimeId: string) {
		const lock = this.lockInfo();
		if (!lock || lock.token !== token || !runtimeId || lock.runtimeId !== runtimeId || this.token) throw new Error("Lock identity changed or does not match the stopped host runtime; recovery refused.");
		if (lock.host === hostname()) {
			try { process.kill(lock.pid, 0); }
			catch (err) {
				if (errorCode(err) !== "ESRCH") throw new Error("Cannot establish whether the local lock owner stopped.");
				unlinkSync(this.lockPath);
				return;
			}
			throw new Error("Local lock owner is still running; recovery refused.");
		}
		unlinkSync(this.lockPath);
	}

	/** Explicit user-confirmed recovery only; never auto-steal a live/remote lock.
	 * Return lock bytes so the confirmation can be tied to the inspected lock. */
	recoverableLock(): string | null {
		this.checkPaths();
		if (!existsSync(this.lockPath)) return null;
		const text = readFileSync(this.lockPath, "utf8");
		let lock: Lock;
		try { lock = JSON.parse(text); }
		catch { throw new Error(`Malformed lock at ${this.lockPath}; inspect it manually before removing it.`); }
		if (!lock || lock.host !== hostname() || !Number.isInteger(lock.pid) || lock.pid <= 0) {
			throw new Error(`Cannot safely recover a foreign/unknown lock at ${this.lockPath}. Confirm its owner has stopped and remove it manually.`);
		}
		try { process.kill(lock.pid, 0); }
		catch (err) {
			if (errorCode(err) === "ESRCH") return text;
			throw new Error("Cannot establish whether the lock owner is stopped; refusing to unlock.");
		}
		throw new Error("The lock owner is still running. Use /memory-upgrade cancel in that session.");
	}

	unlock(expected: string) {
		if (this.recoverableLock() !== expected) throw new Error("Lock changed while awaiting confirmation; retry inspection.");
		unlinkSync(this.lockPath);
	}
}
