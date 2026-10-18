import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { supportsCurrentContract } from "./okf.js";

const versions = new Map<string, { fingerprint: string; version: Promise<string> }>();
/** Share unchanged executable checks, but invalidate on replacement/in-place edits. */
export async function requireCurrentContractAsync(binary: string): Promise<string> {
  const s = await stat(binary);
  const fingerprint = [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
  let entry = versions.get(binary);
  if (!entry || entry.fingerprint !== fingerprint) {
    const version = new Promise<string>((resolve, reject) => {
      execFile(binary, ["--version"], { encoding: "utf8", timeout: 15_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
        if (error) { reject(error); return; }
        const match = stdout.match(/^okf version (v?\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s|$)/m);
        if (!match) reject(new Error("Cannot identify OKF version"));
        else resolve(match[1]);
      });
    });
    if (versions.size >= 16) versions.delete(versions.keys().next().value!);
    entry = { fingerprint, version }; versions.set(binary, entry);
    void version.catch(() => { if (versions.get(binary) === entry) versions.delete(binary); });
  }
  const version = await entry.version;
  if (!supportsCurrentContract(version)) throw new Error(`OKF ${version} is outside the tested range >=0.4.3 <0.5.0. Use the bundled binary or correct OKF_BIN, then run /memory-upgrade.`);
  return version;
}
