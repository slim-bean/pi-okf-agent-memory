/**
 * Smoke test: load the okf-memory extension through jiti (the same loader pi
 * uses) with a mock ExtensionAPI, then exercise the tools and hooks.
 * Run: node test/smoke.mjs
 */
import { createJiti } from "/home/sandbox/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PI_DIR = "/home/sandbox/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": `${PI_DIR}/dist/index.js`,
    typebox: `${PI_DIR}/node_modules/typebox/build/index.mjs`,
  },
});

const calls = [];
const mockPi = {
	on: (event, handler) => calls.push(["on", event]),
	registerTool: (def) => calls.push(["tool", def.name]),
	registerCommand: (name) => calls.push(["command", name]),
	sendMessage: (msg, opts) => calls.push(["sendMessage", opts?.deliverAs, msg.content.slice(0, 60)]),
	sendUserMessage: (text) => calls.push(["sendUserMessage", text.slice(0, 60)]),
	exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
};

const ext = await jiti.import("../index.ts");
ext.default(mockPi);

const registered = calls.map((c) => `${c[0]}:${c[1]}`);
console.log("registered:", JSON.stringify(registered, null, 0));

// Fire session_start like pi would (startup reason should NOT inject)
const handlers = {};
for (const c of calls) if (c[0] === "on") handlers[c[1]] = true;

// Pull actual handler closures by re-loading with capturing mock
const captured = {};
const mockPi2 = {
	on: (event, handler) => { captured[event] = handler; },
	registerTool: (def) => { captured["tool:" + def.name] = def; },
	registerCommand: (name, opts) => { captured["cmd:" + name] = opts?.handler; },
	sendMessage: (msg, opts) => { captured.lastMessage = { msg, opts }; },
	sendUserMessage: (t) => { captured.lastUserMessage = t; },
	exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
};
(await jiti.import("../index.ts")).default(mockPi2);

const ctx = { cwd: "/workspace", ui: { notify: () => {} } };

// 1. reload: no injection (would duplicate); startup DOES inject (cron-dispatched sessions start fresh)
captured.session_start({ reason: "reload" }, ctx);
if (captured.lastMessage) throw new Error("reload should not inject");
console.log("PASS session_start(reload): no injection");

captured.session_start({ reason: "startup" }, ctx);
if (!captured.lastMessage?.msg?.content.includes("Anti-bloat")) throw new Error("startup should inject index");
console.log("PASS session_start(startup): index injected");
captured.lastMessage = undefined;

// 2. resume: injects index
captured.session_start({ reason: "resume" }, ctx);
const m = captured.lastMessage;
if (!m || !m.msg.content.includes("memory_search") || !m.msg.content.includes("Anti-bloat")) {
	throw new Error("resume injection missing index content");
}
if (m.opts?.deliverAs !== "nextTurn") throw new Error("injection must be nextTurn");
console.log("PASS session_start(resume): index injected as nextTurn");

// 3. tools work against /workspace/knowledge
for (const name of ["memory_search", "memory_show", "memory_validate"]) {
	const def = captured["tool:" + name];
	if (!def) throw new Error(name + " not registered");
	const result = await def.execute("t1", name === "memory_search" ? { query: "anti-bloat" } : name === "memory_show" ? { concept: "decisions/memory-budget" } : {}, undefined, undefined, ctx);
	const text = result.content[0].text;
	if (!text || text.length < 20) throw new Error(name + " returned empty output");
	console.log(`PASS ${name}: ${text.split("\n")[0].slice(0, 80)}`);
}

// 4. validate reports ok:true on a clean bundle
const v = await captured["tool:memory_validate"].execute("t2", {}, undefined, undefined, ctx);
if (v.details?.ok !== true) throw new Error("validate should report ok:true for clean bundle");
console.log("PASS memory_validate details.ok === true");

// 5. missing bundle -> readable error
const errCtx = { cwd: "/tmp/empty-no-knowledge", ui: { notify: () => {} } };
try {
	await captured["tool:memory_search"].execute("t3", { query: "x" }, undefined, undefined, errCtx);
	throw new Error("should have thrown for missing bundle");
} catch (e) {
	if (!String(e.message).includes("No OKF knowledge bundle")) throw e;
	console.log("PASS memory_search(missing bundle): readable error");
}

// 6. /knowledge-review sends the review prompt
captured["cmd:knowledge-review"]?.(undefined, { ui: { notify: () => {} } });
if (!captured.lastUserMessage?.includes("knowledge review")) throw new Error("knowledge-review did not send prompt");
console.log("PASS knowledge-review prompt:", JSON.stringify(captured.lastUserMessage?.slice(0, 40)));

// 9. binary resolution prefers the runtime-matched arch build
{
	const mod = await jiti.import("../index.ts");
	if (!mod.resolveOkfBin) throw new Error("resolveOkfBin not exported");
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	const expected = `/workspace/pi-okf-agent-memory/bin/okf-${process.platform}-${arch}`;
	const got = mod.resolveOkfBin();
	if (got !== expected) throw new Error(`resolveOkfBin = ${got}, want ${expected}`);
	writeFileSync("/tmp/custom-okf-test", "#!/bin/sh\n", { mode: 0o755 });
	process.env.OKF_BIN = "/tmp/custom-okf-test";
	if (mod.resolveOkfBin() !== "/tmp/custom-okf-test") throw new Error("OKF_BIN override ignored");
	delete process.env.OKF_BIN;
	rmSync("/tmp/custom-okf-test");
	console.log(`PASS resolveOkfBin: arch-matched (${process.platform}-${arch}), OKF_BIN override respected`);
}

// 7. empty corpus -> bootstrap nudge (not index injection)
const emptyHost = "/tmp/empty-bundle-host";
rmSync(emptyHost, { recursive: true, force: true });
execFileSync("/workspace/pi-okf-agent-memory/bin/okf", ["init", `${emptyHost}/knowledge`]);
const emptyCtx = { cwd: emptyHost, ui: { notify: () => {} } };
captured.lastMessage = undefined;
captured.session_start({ reason: "resume" }, emptyCtx);
if (!captured.lastMessage?.msg?.content.includes("no concepts yet")) throw new Error("empty corpus should get bootstrap nudge");
if (captured.lastMessage.msg.content.includes("Anti-bloat")) throw new Error("empty corpus must not claim concepts exist");
console.log("PASS session_start(empty corpus): bootstrap nudge");

// 8. no bundle at all -> non-intrusive notify, no injection
captured.lastMessage = undefined;
let notified = null;
const noBundleCtx = { cwd: "/tmp/empty-no-knowledge", ui: { notify: (msg) => { notified = msg; } } };
captured.session_start({ reason: "resume" }, noBundleCtx);
if (captured.lastMessage) throw new Error("missing bundle should not inject a turn");
if (!notified?.includes("okf init")) throw new Error("missing bundle should notify with init hint");
console.log("PASS session_start(missing bundle): notify hint, no injection");

console.log("\nALL SMOKE TESTS PASSED");
