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

export function validateBundle(binary: string, dir: string) {
	const result = runOkf(binary, ["validate", dir, "--strict", "--drift", "--stale", "--json"], [0, 1]);
	const validation = JSON.parse(result.stdout) as Validation;
	if (!validation || typeof validation.is_conformant !== "boolean" || typeof validation.gate_passed !== "boolean" ||
		!Number.isInteger(validation.concept_count) || validation.concept_count < 0 ||
		![validation.errors, validation.warnings, validation.gate_findings].every(Array.isArray) ||
		![validation.broken_links, validation.orphans].every(v => v === null || Array.isArray(v))) {
		throw new Error("Unrecognized OKF validation JSON; refusing to infer success.");
	}
	// Upstream strict mode still permits quality/drift warnings. Our persistence
	// contract is deliberately stronger: no unresolved findings of any category.
	const ok = result.code === 0 && validation.is_conformant && validation.gate_passed &&
		[validation.errors, validation.warnings, validation.gate_findings, validation.broken_links, validation.orphans]
			.every(findings => !findings?.length);
	return { ok, exitCode: result.code, validation };
}
