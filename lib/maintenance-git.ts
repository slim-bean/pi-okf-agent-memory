import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { git, gitEnv } from "./git.js";
import { spawn } from "node:child_process";
import { gitIssue, MemoryMaintenanceIssue } from "./maintenance-issue.js";

/** Automatic, bundle-only commit. Preserve unrelated outer-repository staging. */
export function commitKnowledge(bundle: string, message: string): string | null {
  try { return commitKnowledgeImpl(bundle, message); }
  catch (error) { throw gitIssue(bundle, error, "commit"); }
}
function commitKnowledgeImpl(bundle: string, message: string): string | null {
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    if (existsSync(resolve(bundle, git(bundle, ["rev-parse", "--git-path", marker]).stdout.trim()))) throw new Error(`Git ${marker} in progress; maintenance deferred`);
  }
  if (git(bundle, ["ls-files", "--unmerged"]).stdout) throw new Error("Unmerged Git index; maintenance deferred");
  const paths = [...new Set(git(bundle, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."]).stdout.split("\0"))]
    .filter((p) => p && !/^\.pi-okf-memory\/(lock\.json|finalize-pending|\.state-.*\.tmp)$/.test(p));
  if (!paths.length) return null;
  const specs = paths.map((p) => `:(literal)${p}\0`).join("");
  git(bundle, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], [0], specs);
  const head = git(bundle, ["rev-parse", "--verify", "HEAD"], [0, 128]);
  const scope = [".", ":(exclude,glob).pi-okf-memory/lock.json", ":(exclude,glob).pi-okf-memory/finalize-pending", ":(exclude,glob).pi-okf-memory/.state-*.tmp"];
  if (head.code !== 0 || git(bundle, ["diff", "--cached", "--quiet", "HEAD", "--", ...scope], [0, 1]).code === 1) {
    git(bundle, ["commit", "--only", "--message", message, "--pathspec-from-file=-", "--pathspec-file-nul"], [0], specs);
  }
  if (git(bundle, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...scope]).stdout) throw new Error("Knowledge changed during commit; retry finalization");
  return git(bundle, ["rev-parse", "HEAD"]).stdout.trim();
}

/** Explicit configured upstream only. No force, auto-merge/rebase, auth prompt or new remote. */
export async function pushKnowledge(bundle: string, signal?: AbortSignal): Promise<void> {
  try { await pushKnowledgeImpl(bundle, signal); }
  catch (error) { signal?.throwIfAborted(); throw gitIssue(bundle, error, "push"); }
}
async function pushKnowledgeImpl(bundle: string, signal?: AbortSignal): Promise<void> {
  const branch = git(bundle, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]).stdout.trim();
  if (!branch) throw new MemoryMaintenanceIssue("blocked", "git-upstream", bundle, "Knowledge push requires an attached branch with a configured upstream; HEAD is detached.");
  const remote = git(bundle, ["config", "--get", `branch.${branch}.remote`], [0, 1]).stdout.trim();
  const ref = git(bundle, ["config", "--get", `branch.${branch}.merge`], [0, 1]).stdout.trim();
  if (!remote || remote === "." || remote.startsWith("-") || !ref.startsWith("refs/heads/")) throw new MemoryMaintenanceIssue("blocked", "git-upstream", bundle, "push enabled but no valid upstream remote/branch is configured");
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", bundle, "push", "--porcelain", remote, `HEAD:${ref}`], {
      env: { ...gitEnv(), GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" },
      stdio: ["ignore", "pipe", "pipe"], signal, timeout: 60_000,
    });
    let output = "";
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    let failure: Error | undefined;
    child.once("error", (error) => { failure = error; if (!child.pid) reject(error); });
    // An AbortError only requests termination. Keep ownership until Git really exits.
    child.once("close", (code, reason) => failure ? reject(failure) : code === 0 ? resolve() : reject(new Error(`Knowledge push failed (${code ?? reason}): ${output}`)));
  });
}
