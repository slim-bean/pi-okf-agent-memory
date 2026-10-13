import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryOwnership = "limited" | "full";
/** Explicit standing policy, not authentication or a sandbox boundary. No host autodetection. */
export function configuredOwnership(cwd: string, explicit?: string): MemoryOwnership {
  let value = explicit;
  if (value === undefined) {
    const file = join(cwd, ".pi", "maintenance.json");
    if (existsSync(file)) value = JSON.parse(readFileSync(file, "utf8")).memoryOwnership;
    value ??= process.env.PI_MEMORY_OWNERSHIP ?? "limited";
  }
  if (value !== "limited" && value !== "full") throw new Error("memoryOwnership / PI_MEMORY_OWNERSHIP must be limited or full");
  return value;
}
