import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export function resolveOkfBin(extensionDir: string): string | null {
	// An explicit override must not silently fall back to a different executable.
	if (process.env.OKF_BIN) return resolve(process.env.OKF_BIN);
	const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
	if (arch && (process.platform === "linux" || process.platform === "darwin")) {
		const matched = join(extensionDir, "bin", `okf-${process.platform}-${arch}`);
		if (existsSync(matched)) return matched;
	}
	const sibling = join(extensionDir, "bin", "okf");
	if (existsSync(sibling)) return sibling;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir && existsSync(join(dir, "okf"))) return resolve(dir, "okf");
	}
	return null;
}

export function resolveKnowledgeDir(cwd: string): string | null {
	const override = process.env.OKF_KNOWLEDGE_DIR;
	const candidates = override
		? [isAbsolute(override) ? override : resolve(cwd, override)]
		: [join(cwd, "knowledge"), ...(cwd === "/workspace" || cwd.startsWith("/workspace/") ? ["/workspace/knowledge"] : [])];
	for (const dir of candidates) {
		if (existsSync(join(dir, "index.md"))) return realpathSync(dir);
	}
	return null;
}

export function runOkf(binary: string, args: string[], acceptedCodes = [0]) {
	const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 10 * 1024 * 1024 });
	if (result.error || result.status === null || !acceptedCodes.includes(result.status)) {
		throw new Error(`okf ${args[0]} failed: ${result.error?.message ?? `exit ${result.status}, signal ${result.signal}`}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	}
	return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

export function binaryVersion(binary: string): string {
	const output = runOkf(binary, ["--version"]).stdout;
	const version = output.match(/^okf version (v?\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s|$)/m)?.[1];
	if (!version) throw new Error(`Cannot identify OKF version: ${output.trim()}`);
	return version;
}

/** Tested release family; unknown/new minor versions require an integration review. */
export function supportsCurrentContract(version: string): boolean {
	const match = /^v?0\.4\.(\d+)$/.exec(version);
	return !!match && Number(match[1]) >= 3;
}

export function requireCurrentContract(binary: string): string {
	const version = binaryVersion(binary);
	if (!supportsCurrentContract(version)) throw new Error(`OKF ${version} is outside the tested range >=0.4.3 <0.5.0. Use the bundled binary or correct OKF_BIN, then run /memory-upgrade.`);
	return version;
}

export interface Validation {
	concept_count: number;
	is_conformant: boolean;
	gate_passed: boolean;
	errors: string[];
	warnings: string[];
	gate_findings: string[];
	broken_links: unknown[] | null;
	orphans: string[] | null;
	[key: string]: unknown;
}

export type OrphanPolicy = "advisory" | "strict";
export interface Advisory { code: "isolated-concepts"; message: string; concepts: string[] }
export function orphanPolicy(value = process.env.OKF_ORPHAN_POLICY ?? "advisory"): OrphanPolicy {
	if (value !== "advisory" && value !== "strict") throw new Error("OKF_ORPHAN_POLICY must be advisory or strict");
	return value;
}
function readValidation(text: string): Validation {
	const validation = JSON.parse(text) as Validation;
	if (!validation || typeof validation.is_conformant !== "boolean" || typeof validation.gate_passed !== "boolean" ||
		!Number.isInteger(validation.concept_count) || validation.concept_count < 0 ||
		![validation.errors, validation.warnings, validation.gate_findings].every(Array.isArray) ||
		![validation.broken_links, validation.orphans].every(v => v === null || Array.isArray(v))) {
		throw new Error("Unrecognized OKF validation JSON; refusing to infer success.");
	}
	if (validation.stale_count !== undefined && (!Number.isSafeInteger(validation.stale_count) || (validation.stale_count as number) < 0)) throw new Error("Unrecognized OKF stale_count; refusing to infer success");
	return validation;
}
function noBlockingFindings(v: Validation): boolean {
	return v.is_conformant && !v.stale_count &&
		[v.errors, v.warnings, v.gate_findings, v.broken_links].every(findings => !findings?.length);
}
export function validateBundle(binary: string, dir: string, policy: OrphanPolicy = orphanPolicy()) {
	policy = orphanPolicy(policy);
	const args = ["validate", dir, "--drift", "--stale", "--json"];
	const strict = runOkf(binary, [...args, "--strict"], [0, 1]);
	const strictValidation = readValidation(strict.stdout);
	let result = strict;
	let validation = strictValidation;
	// Relax ONLY the proven orphan-only case, never an arbitrary failed gate.
	// Confirm with upstream non-strict validation rather than fabricating gate_passed.
	if (policy === "advisory" && strict.code === 1 && !strictValidation.gate_passed &&
		noBlockingFindings(strictValidation) && strictValidation.orphans?.length) {
		result = runOkf(binary, args, [0, 1]);
		validation = readValidation(result.stdout);
	}
	const ok = result.code === 0 && validation.gate_passed && noBlockingFindings(validation) &&
		(policy === "advisory" || !validation.orphans?.length);
	const advisories: Advisory[] = policy === "advisory" && validation.orphans?.length
		? [{ code: "isolated-concepts", message: `${validation.orphans.length} concept(s) have no semantic relationships (advisory). Independent topics are allowed; do not invent links to silence this observation.`, concepts: validation.orphans }]
		: [];
	return { ok, exitCode: result.code, validation, orphanPolicy: policy, advisories, strictValidation };
}
