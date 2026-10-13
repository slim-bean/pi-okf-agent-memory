import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryMaintenanceIssue } from "./maintenance-issue.js";

/** Metadata-only recovery of agent-owned files, before a content checkpoint can
 * be read. Never follows symlinks, changes other users' rights, or steals locks. */
export function restoreOwnedAccess(bundle: string, workDir: string, guard: () => void, onEvent?: (type: string, detail: unknown) => void) {
  if (!existsSync(bundle) || !process.getuid) return;
  const uid = process.getuid();
  const dir = join(workDir, "permissions");
  const walk = (path: string) => {
    guard();
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return;
    const required = stat.isDirectory() ? 0o700 : 0o600;
    if (stat.uid === uid && (stat.mode & required) !== required) {
      const before = stat.mode & 0o7777, after = before | required;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const checkpoint = join(dir, `${randomUUID()}.json`);
      writeFileSync(checkpoint, JSON.stringify({ path, uid, before, after, metadataOnly: true }, null, 2), { mode: 0o600 });
      chmodSync(path, after);
      onEvent?.("recovery", { action: "Restored owner-only access without changing content or other users' rights", path, checkpoint });
    }
    if (stat.isDirectory()) for (const entry of readdirSync(path)) {
      if (entry === ".git") continue; // immutable Git objects and hook modes are not ordinary memory content
      walk(join(path, entry));
    }
  };
  try { walk(bundle); }
  catch (error) {
    if (["EROFS", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new MemoryMaintenanceIssue("blocked", "memory-external", bundle,
      "The agent cannot restore access to this memory storage; provision a writable mount/ownership through the host.", { ownership: "full", external: { code: "permission", reason: String(error) } });
    throw error;
  }
}
