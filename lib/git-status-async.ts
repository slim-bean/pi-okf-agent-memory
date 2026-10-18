import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { gitEnv } from "./git.js";

/** Read-only status subprocesses must not freeze foreground terminal input. */
export async function bundleCommitStatusAsync(bundle: string): Promise<{ pending: boolean; commit: string | null; error?: string }> {
  const git = (args: string[], codes = [0]) => new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    execFile("git", ["-C", bundle, ...args], { env: gitEnv(), encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        if (!codes.includes(code)) reject(new Error(`git ${args[0]} failed: ${error?.message ?? stderr}`));
        else resolve({ code, stdout });
      });
  });
  try {
    const root = await realpath((await git(["rev-parse", "--show-toplevel"])).stdout.trim());
    const path = relative(root, bundle);
    if (path === ".." || path.startsWith(".." + sep)) throw new Error("Knowledge bundle is outside the resolved Git worktree.");
    const prefix = path ? path.split(sep).join("/") + "/" : "";
    const head = await git(["rev-parse", "--verify", "HEAD"], [0, 128]);
    if (head.code !== 0) return { pending: true, commit: null };
    const tracked = (await git(["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ".pi-okf-memory"])).stdout.split("\0");
    if (tracked.some(p => /^\.pi-okf-memory\/(lock\.json|finalize-pending|\.state-.*\.tmp)$/.test(p))) {
      throw new Error("Transient upgrade files are committed in HEAD. Commit their removal from tracking before retrying finalization.");
    }
    for (const path of [".pi-okf-memory/state.json", ".pi-okf-memory/.gitignore"]) {
      const committed = await git(["show", "HEAD:" + prefix + path], [0, 128]);
      if (committed.code !== 0 || committed.stdout !== await readFile(bundle + "/" + path, "utf8")) return { pending: true, commit: null };
    }
    // Do not certify a commit if HEAD moved while its individual records were read.
    if ((await git(["rev-parse", "--verify", "HEAD"])).stdout.trim() !== head.stdout.trim()) return { pending: true, commit: null };
    return { pending: false, commit: head.stdout.trim() };
  } catch (error) {
    return { pending: true, commit: null, error: error instanceof Error ? error.message : String(error) };
  }
}
