import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveOkfBin } from "./okf.js";

export interface BinaryCandidate { path: string; source: string; status: string }
export interface BinaryDiagnostics {
  extensionFile: string; packageDir: string; cwd: string; platform: string; arch: string;
  override?: string; selected: string | null; candidates: BinaryCandidate[];
  settings: { file: string; status: string; matches: string[] }[];
  configuration: string;
}
const expand = (path: string, cwd: string) => resolve(cwd, path.replace(/^~(?=\/|$)/, homedir()));
function probe(path: string, source: string): BinaryCandidate {
  try {
    if (!statSync(path).isFile()) return { path, source, status: "not a regular file" };
    try { accessSync(path, constants.X_OK); } catch { return { path, source, status: "not executable" }; }
    return { path, source, status: "usable" };
  } catch (error) { return { path, source, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `inaccessible (${(error as NodeJS.ErrnoException).code ?? "unknown"})` }; }
}
/** Read only resource declarations, never auth.json or credential fields. File matches
 * are evidence of declarations, not invented loader provenance (CLI -e is possible). */
function declarations(file: string, extensionFile: string, packageDir: string) {
  if (!existsSync(file)) return { file, status: "absent", matches: [] as string[] };
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const matches: string[] = [];
    for (const kind of ["packages", "extensions"]) {
      for (const value of Array.isArray(data[kind]) ? data[kind] : []) {
        const source = typeof value === "string" ? value : value?.source;
        if (typeof source !== "string" || /^(?:npm:|git:|https?:|builtin:|[!\-])/.test(source) || /[*?{}]/.test(source)) continue;
        const path = expand(source.replace(/^\+/, ""), dirname(file));
        if (path === packageDir || path === extensionFile) matches.push(`${kind}: ${path}`);
      }
    }
    return { file, status: "present", matches };
  } catch (error) { return { file, status: `unreadable/invalid (${(error as Error).name})`, matches: [] as string[] }; }
}
export function binaryDiagnostics(extensionFile: string, cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")): BinaryDiagnostics {
  const packageDir = dirname(extensionFile);
  const override = process.env.OKF_BIN;
  const candidates: BinaryCandidate[] = [];
  if (override) candidates.push(probe(expand(override, cwd), "OKF_BIN environment override; fallbacks disabled"));
  else {
    const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
    if (arch && ["darwin", "linux"].includes(process.platform)) candidates.push(probe(join(packageDir, "bin", `okf-${process.platform}-${arch}`), "host-matched bundled binary"));
    candidates.push(probe(join(packageDir, "bin", "okf"), "legacy bundled binary"));
    for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir) candidates.push(probe(resolve(cwd, dir, "okf"), "PATH"));
  }
  return { extensionFile, packageDir, cwd, platform: process.platform, arch: process.arch, override,
    selected: resolveOkfBin(packageDir, cwd), candidates,
    settings: [join(expand(agentDir, cwd), "settings.json"), join(cwd, ".pi", "settings.json")].map(file => declarations(file, extensionFile, packageDir)),
    configuration: "OKF binary configuration comes from OKF_BIN, this loaded package's bin/ directory, then PATH; no separate OKF config file is read.",
  };
}
export function formatBinaryDiagnostics(d: BinaryDiagnostics): string {
  return [`Loaded extension: ${d.extensionFile}`, `Package directory: ${d.packageDir}`, `Workspace: ${d.cwd}`,
    `Host: ${d.platform}/${d.arch}`, `OKF_BIN: ${d.override ?? "(unset)"}`, `Selected binary: ${d.selected ?? "(none)"}`,
    d.configuration, "Binary lookup candidates (in order):", ...d.candidates.map(c => `  ${c.path} — ${c.status} [${c.source}]`),
    "Resource declaration files (CLI/discovery can also load an extension):",
    ...d.settings.flatMap(s => [`  ${s.file} — ${s.status}`, ...s.matches.map(m => `    ${m}`)]),
  ].join("\n");
}
export class BinaryResolutionError extends Error {
  readonly maintenanceIssue = 1;
  readonly kind = "blocked";
  readonly code = "okf-binary";
  readonly resource: string;
  readonly detail: BinaryDiagnostics;
  constructor(d: BinaryDiagnostics) {
    const selected = d.candidates.find(c => c.path === d.selected);
    super(`${d.selected ? `okf binary is unusable (${selected?.status ?? "unavailable"}).` : "okf binary not found."}\n${formatBinaryDiagnostics(d)}\nRestore the bundled binary or correct OKF_BIN. /memory-diagnostics shows this lookup without running a model.`);
    this.name = "BinaryResolutionError"; this.resource = d.selected ?? d.packageDir; this.detail = d;
  }
}
export function requireOkfBin(extensionFile: string, cwd: string): string {
  // Fast healthy path: don't read settings or enumerate PATH on every model/tool call.
  const selected = resolveOkfBin(dirname(extensionFile), cwd);
  if (selected && probe(selected, "selected").status === "usable") return selected;
  throw new BinaryResolutionError(binaryDiagnostics(extensionFile, cwd));
}
