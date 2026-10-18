import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { jiti } from "./loader.mjs";
const { bundleCommitStatus } = await jiti.import(resolve("lib/git.ts"));
const { bundleCommitStatusAsync } = await jiti.import(resolve("lib/git-status-async.ts"));
const { requireCurrentContractAsync } = await jiti.import(resolve("lib/contract-async.ts"));

test("async Git proof matches synchronous proof without blocking timer progress", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "okf-async-proof-"));
  const oldPath = process.env.PATH;
  try {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const git = args => execFileSync(realGit, ["-C", dir, ...args], { encoding: "utf8" });
    git(["init", "-q"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    mkdirSync(join(dir, ".pi-okf-memory"));
    writeFileSync(join(dir, ".pi-okf-memory/state.json"), "{}");
    writeFileSync(join(dir, ".pi-okf-memory/.gitignore"), "lock.json\nfinalize-pending\n");
    git(["add", "."]); git(["commit", "-qm", "fixture"]);
    const expected = bundleCommitStatus(dir);
    const bin = join(dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "git"), '#!/bin/sh\nsleep 0.03\nexec "' + realGit + '" "$@"\n');
    chmodSync(join(bin, "git"), 0o700);
    process.env.PATH = bin + ":" + oldPath;
    let ticks = 0; const timer = setInterval(() => ticks++, 5);
    try { assert.deepEqual(await bundleCommitStatusAsync(dir), expected); assert.ok(ticks > 10); }
    finally { clearInterval(timer); }
    writeFileSync(join(dir, ".pi-okf-memory/state.json"), '{"changed":true}');
    assert.equal((await bundleCommitStatusAsync(dir)).pending, true);
    assert.equal((await bundleCommitStatusAsync(dir)).pending, bundleCommitStatus(dir).pending);
  } finally { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});

test("binary checks share unchanged executable work and reject an edited incompatible binary", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "okf-contract-cache-"));
  try {
    const binary = join(dir, "okf"), count = join(dir, "calls");
    const script = version => '#!' + process.execPath + '\n' +
      'require("node:fs").appendFileSync(' + JSON.stringify(count) + ', "x"); console.log("okf version ' + version + '");\n';
    writeFileSync(binary, script("v0.4.3")); chmodSync(binary, 0o700);
    assert.deepEqual(await Promise.all([requireCurrentContractAsync(binary), requireCurrentContractAsync(binary)]), ["v0.4.3", "v0.4.3"]);
    assert.equal(readFileSync(count, "utf8"), "x");
    writeFileSync(binary, script("v0.5.0"));
    await assert.rejects(requireCurrentContractAsync(binary), /outside the tested range/);
    assert.equal(readFileSync(count, "utf8"), "xx");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
