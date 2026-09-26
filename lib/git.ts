import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const METADATA = ".pi-okf-memory";
const RECORDS = [`${METADATA}/state.json`, `${METADATA}/.gitignore`];
const TRANSIENT = [`${METADATA}/lock.json`, `${METADATA}/finalize-pending`, `${METADATA}/.state-*.tmp`];
// Relative to `git -C <bundle>`: include only this bundle, regardless of the
// enclosing repository. Explicit exclusions also protect against a bad ignore file.
const SCOPE = [".", ...TRANSIENT.map(path => `:(exclude,glob)${path}`)];
const isTransient = (path: string) => /^\.pi-okf-memory\/(lock\.json|finalize-pending|\.state-.*\.tmp)$/.test(path);

export function gitEnv() {
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
	// A pi launched by a Git hook/worktree must not redirect our operations to
	// its parent's index/repository. Honor normal identity, signing and hooks.
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]) delete (env as NodeJS.ProcessEnv)[key];
	return env;
}

export function git(bundle: string, args: string[], codes = [0], input?: string) {
	const res = spawnSync("git", ["-C", bundle, ...args], { env: gitEnv(), input, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
	if (res.error || res.status === null || !codes.includes(res.status)) {
		throw new Error(`git ${args[0]} failed: ${res.error?.message ?? `exit ${res.status}`}\n${res.stdout ?? ""}${res.stderr ?? ""}`);
	}
	return { code: res.status, stdout: res.stdout };
}

function repository(bundle: string) {
	const root = realpathSync(git(bundle, ["rev-parse", "--show-toplevel"]).stdout.trim());
	const path = relative(root, bundle);
	if (path === ".." || path.startsWith(`..${sep}`)) throw new Error("Knowledge bundle is outside the resolved Git worktree.");
	return { root, prefix: path ? path.split(sep).join("/") + "/" : "" };
}

/** Proof comes from HEAD, not a hash written back into the ledger (which would
 * itself need another commit). Ordinary later corpus edits don't reopen upgrades. */
export function bundleCommitStatus(bundle: string): { pending: boolean; commit: string | null; error?: string } {
	try {
		const { prefix } = repository(bundle);
		const head = git(bundle, ["rev-parse", "--verify", "HEAD"], [0, 128]);
		if (head.code !== 0) return { pending: true, commit: null };
		if (git(bundle, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", METADATA]).stdout.split("\0").some(isTransient)) {
			throw new Error("Transient upgrade files are committed in HEAD. Commit their removal from tracking before retrying finalization.");
		}
		for (const path of RECORDS) {
			const committed = git(bundle, ["show", `HEAD:${prefix}${path}`], [0, 128]);
			if (committed.code !== 0 || committed.stdout !== readFileSync(join(bundle, path), "utf8")) return { pending: true, commit: null };
		}
		return { pending: false, commit: head.stdout.trim() };
	} catch (err) {
		return { pending: true, commit: null, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Commit agent-owned bundle changes while preserving the enclosing repo's
 * unrelated index entries. No push, identity configuration, stash, reset, or
 * hook/signing bypass. Failed commits leave the agent's bundle changes staged. */
export function commitBundle(bundle: string, lastStep: string): string {
	const { root } = repository(bundle);
	if (git(root, ["ls-files", "--unmerged"]).stdout) throw new Error("Resolve the repository's unmerged index entries before finalizing the memory upgrade.");
	for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
		// `--git-path` supports linked worktrees as well as ordinary repositories.
		const path = resolve(bundle, git(bundle, ["rev-parse", "--git-path", marker]).stdout.trim());
		// Keep filesystem inspection separate from Git's status (which can be
		// clean during an in-progress operation with no conflicted paths).
		if (existsSync(path)) throw new Error(`Finish the repository's ${marker} operation before finalizing the memory upgrade.`);
	}
	const head = git(bundle, ["rev-parse", "--verify", "HEAD"], [0, 128]);
	const tracked = git(bundle, ["ls-files", "-z", "--", METADATA]).stdout;
	const committed = head.code === 0 ? git(bundle, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", METADATA]).stdout : "";
	if ((tracked + committed).split("\0").some(isTransient)) {
		throw new Error("Transient upgrade lock/temp files are tracked by Git. Remove them from tracking and commit that cleanup before retrying; they must never enter the upgrade commit.");
	}
	// Enumerate actual tracked/non-ignored files instead of passing explicit
	// ignored exclusions to `git add` (Git treats those as ignored-file errors).
	// NUL-delimited literal pathspecs handle spaces, metacharacters and deletions
	// without an argument-count limit or accidentally selecting outside files.
	const paths = [...new Set(git(bundle, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."]).stdout.split("\0").filter(path => !!path && !isTransient(path)))];
	if (RECORDS.some(path => !paths.includes(path))) throw new Error("The upgrade ledger or its ignore file is ignored/missing. Adjust Git ignore rules to track both before retrying; nothing was staged by this attempt.");
	const pathspecs = paths.map(path => `:(literal)${path}\0`).join("");
	git(bundle, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], [0], pathspecs);
	// Never force ignored metadata into Git: surface the configuration problem.
	git(bundle, ["ls-files", "--error-unmatch", "--", ...RECORDS]);
	const changed = head.code !== 0 || git(bundle, ["diff", "--cached", "--quiet", "HEAD", "--", ...SCOPE], [0, 1]).code === 1;
	if (changed) git(bundle, ["commit", "--only", "--message", `chore(memory): finalize upgrades through ${lastStep}`, "--pathspec-from-file=-", "--pathspec-file-nul"], [0], pathspecs);
	const status = bundleCommitStatus(bundle);
	if (status.pending || !status.commit) throw new Error(`The upgrade ledger and ignore file are not committed in HEAD. ${status.error ?? "Inspect Git status and retry."}`);
	if (git(bundle, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...SCOPE]).stdout) {
		throw new Error("Bundle files changed during finalization (possibly from a hook or another writer). Review them and retry; the final commit is still pending.");
	}
	return status.commit;
}
