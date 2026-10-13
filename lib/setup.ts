import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { git, gitEnv } from "./git.js";
import { requireCurrentContract, resolveKnowledgeDir, runOkf, validateBundle } from "./okf.js";

export interface SetupStatus {
	bundle: string;
	phase: "ready" | "needed" | "blocked";
	createBundle: boolean;
	initGit: boolean;
	repository: string | null;
	planId: string;
	error?: string;
}

function stat(path: string) {
	try { return lstatSync(path); }
	catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
}

/** Canonicalize existing ancestors too, so a missing bundle has a stable binding.
 * A dangling symlink is an error, not permission to create a replacement. */
function canonical(path: string): string {
	if (stat(path)) return realpathSync(path);
	return join(canonical(dirname(path)), basename(path));
}

function target(cwd: string): string {
	const override = process.env.OKF_KNOWLEDGE_DIR;
	return canonical(override ? (isAbsolute(override) ? override : resolve(cwd, override)) : resolveKnowledgeDir(cwd) ?? join(cwd, "knowledge"));
}

/** Never turn a failed worktree lookup into unconditional git init. Broken
 * .git files/directories, bare repos, unsafe ownership, and Git failures block. */
function repository(path: string): string | null {
	let existing = path;
	while (!stat(existing)) existing = dirname(existing);
	if (!lstatSync(existing).isDirectory()) throw new Error(`Not a directory: ${existing}`);
	const result = spawnSync("git", ["-C", existing, "rev-parse", "--show-toplevel"], { env: { ...gitEnv(), LC_ALL: "C" }, encoding: "utf8", timeout: 15_000 });
	if (!result.error && result.status === 0) {
		const root = realpathSync(result.stdout.trim());
		for (let dir = existing; dir !== root; dir = dirname(dir)) {
			if (stat(join(dir, ".git")) || (stat(join(dir, "HEAD")) && stat(join(dir, "objects")))) throw new Error(`Unresolved nested Git metadata at ${dir}; restore it before setup.`);
			if (dirname(dir) === dir) throw new Error(`Resolved Git worktree ${root} does not enclose ${existing}.`);
		}
		return root;
	}
	for (let dir = existing;; dir = dirname(dir)) {
		if (stat(join(dir, ".git")) || (stat(join(dir, "HEAD")) && stat(join(dir, "objects")))) {
			throw new Error(`Git metadata exists at ${dir}, but its worktree cannot be resolved. Restore the repository/mount; setup will not replace it.\n${result.stderr ?? ""}`);
		}
		if (dirname(dir) === dir) break;
	}
	if (result.error || result.status !== 128 || !result.stderr.includes("not a git repository")) {
		throw new Error(`Cannot inspect Git at ${existing}: ${result.error?.message ?? result.stderr}`);
	}
	return null;
}

export function inspectSetup(cwd: string, ownedUpgradeToken?: string): SetupStatus {
	let bundle = resolve(cwd, process.env.OKF_KNOWLEDGE_DIR || "knowledge");
	let createBundle = false, initGit = false, root: string | null = null;
	let error: string | undefined;
	try {
		bundle = target(cwd);
		if (stat(bundle) && !lstatSync(bundle).isDirectory()) throw new Error(`Knowledge path is not a directory: ${bundle}`);
		createBundle = !stat(join(bundle, "index.md"));
		if (!createBundle && !lstatSync(join(bundle, "index.md")).isFile()) throw new Error("Knowledge index.md must be a regular file (not a symlink).");
		if (createBundle && existsSync(bundle) && readdirSync(bundle).some(name => name !== ".git")) {
			throw new Error("Knowledge directory is nonempty but has no index.md. Inspect/restore it before setup; no files will be overwritten.");
		}
		root = repository(bundle);
		initGit = root === null;
		const upgradeLock = join(bundle, ".pi-okf-memory", "lock.json");
		if ((createBundle || initGit) && stat(upgradeLock)) {
			const owns = ownedUpgradeToken && !lstatSync(upgradeLock).isSymbolicLink() && JSON.parse(readFileSync(upgradeLock, "utf8")).token === ownedUpgradeToken;
			if (!owns) throw new Error("An upgrade lock exists. Stop/recover that review before setup; do not initialize Git under a running writer.");
		}
	} catch (err) { error = err instanceof Error ? err.message : String(err); }
	const phase = error ? "blocked" : createBundle || initGit ? "needed" : "ready";
	const planId = createHash("sha256").update(JSON.stringify([bundle, phase, createBundle, initGit, root, error])).digest("hex");
	return { bundle, phase, createBundle, initGit, repository: root, planId, ...(error ? { error } : {}) };
}

export function requireSetup(cwd: string, ownedUpgradeToken?: string): SetupStatus {
	const status = inspectSetup(cwd, ownedUpgradeToken);
	if (status.phase !== "ready") throw new Error(`Memory setup ${status.phase} for ${status.bundle}. ${status.error ?? "A Git-backed knowledge bundle is required."} Run /memory-setup or request host setup before upgrading.`);
	return status;
}

/** Explicit caller consent only. No commits, identity/config edits, remotes,
 * pushes, adoption receipts, or content changes to an existing bundle. */
export function setupBundle(cwd: string, binary: string, approved: SetupStatus, ownedUpgradeToken?: string): SetupStatus {
	const check = () => {
		const current = inspectSetup(cwd, ownedUpgradeToken);
		if (current.bundle !== approved.bundle || current.planId !== approved.planId) throw new Error("Setup plan changed; inspect again and obtain fresh approval.");
		if (current.phase === "blocked") throw new Error(current.error);
		return current;
	};
	const plan = check();
	if (plan.phase === "ready") return plan;
	requireCurrentContract(binary);
	// Sibling lock works before the bundle exists and doesn't enter Git. A crash
	// leaves it for explicit operator recovery, never automatic lock stealing.
	mkdirSync(dirname(plan.bundle), { recursive: true });
	const lock = join(dirname(plan.bundle), `.${basename(plan.bundle)}.pi-okf-setup.lock`);
	try { mkdirSync(lock); }
	catch (err) { throw new Error(`Cannot acquire setup lock ${lock}. Another setup may be running; after confirming all setup writers stopped, remove only this empty lock directory. ${String(err)}`); }
	try {
		check();
		if (plan.createBundle) {
			runOkf(binary, ["init", plan.bundle]);
			if (!validateBundle(binary, plan.bundle).ok) throw new Error("New bundle validation failed; inspect its files before retrying. No rollback was performed.");
		}
		// Recheck Git after creating the files, refusing broken/replaced metadata.
		const root = repository(plan.bundle);
		if (root !== plan.repository) throw new Error("Git layout changed during setup. Inspect and retry; no Git repository was initialized by this attempt.");
		if (plan.initGit) git(plan.bundle, ["init", "--quiet"]);
		return requireSetup(cwd, ownedUpgradeToken);
	} finally { rmdirSync(lock); }
}
