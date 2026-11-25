import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveKnowledgeDir } from "./store.js";
import { configuredOwnership } from "./ownership.js";

export interface MemoryDiagnostics {
  extensionFile: string; packageDir: string; packageVersion: string; cwd: string; node: string;
  bundle: string | null; knowledgeDirOverride?: string; ownership: string;
  settings: { file: string; status: string; matches: string[] }[];
}
const expand = (path: string, cwd: string) => resolve(cwd, path.replace(/^~(?=\/|$)/, homedir()));
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
export function memoryDiagnostics(extensionFile: string, packageVersion: string, cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")): MemoryDiagnostics {
  const packageDir = dirname(extensionFile);
  let bundle: string | null = null, ownership = "limited";
  try { bundle = resolveKnowledgeDir(cwd); } catch { /* reported as unresolved */ }
  try { ownership = configuredOwnership(cwd); } catch (error) { ownership = `invalid (${(error as Error).message})`; }
  return { extensionFile, packageDir, packageVersion, cwd, node: process.version, bundle,
    knowledgeDirOverride: process.env.OKF_KNOWLEDGE_DIR, ownership,
    settings: [join(expand(agentDir, cwd), "settings.json"), join(cwd, ".pi", "settings.json")].map(file => declarations(file, extensionFile, packageDir)),
  };
}
export function formatDiagnostics(d: MemoryDiagnostics): string {
  return [`Loaded extension: ${d.extensionFile}`, `Package: ${d.packageDir} (${d.packageVersion})`, `Workspace: ${d.cwd}`, `Node: ${d.node}`,
    `Knowledge bundle: ${d.bundle ?? "(none found)"}`, `OKF_KNOWLEDGE_DIR: ${d.knowledgeDirOverride ?? "(unset)"}`, `Memory ownership: ${d.ownership}`,
    "Memory is stored and searched natively; no external binary is used.",
    "Resource declaration files (CLI/discovery can also load an extension):",
    ...d.settings.flatMap(s => [`  ${s.file} — ${s.status}`, ...s.matches.map(m => `    ${m}`)]),
  ].join("\n");
}
