import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

/** Content, not mtime: independent corpus edits must re-admit health validation.
 * Stream bytes so large corpora don't need a full-model-context allocation.
 * Read failures are distinct fingerprints, allowing full recovery admission. */
export function corpusFingerprint(bundle: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { hash.update(JSON.stringify([relative(bundle, dir), (error as NodeJS.ErrnoException).code ?? "unreadable"])); return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name); const name = relative(bundle, path);
      if (entry.isSymbolicLink()) {
        try { hash.update(JSON.stringify(["symlink", name, readlinkSync(path)])); }
        catch (error) { hash.update(JSON.stringify(["symlink", name, (error as NodeJS.ErrnoException).code])); }
        continue;
      }
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith(".md") || entry.name === "log.md") continue;
      let fd: number | undefined;
      try {
        const fileHash = createHash("sha256"); fd = openSync(path, "r");
        for (let bytes; (bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0;) fileHash.update(buffer.subarray(0, bytes));
        hash.update(JSON.stringify([name, fileHash.digest("hex")]));
      } catch (error) { hash.update(JSON.stringify([name, { error: (error as NodeJS.ErrnoException).code ?? "unreadable" }])); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  };
  walk(bundle); return hash.digest("hex");
}
