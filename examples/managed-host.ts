/** Opt-in example: loading this adapter authorizes setup of the resolved bundle,
 * then unattended upgrades, scoped repairs and local commits. NOT auto-loaded.
 * Use OKF_SETUP_MODE=manual for provisioned TUI runtimes without an operator.
 * No package downloads, dialogs or automatic retries. A production host must
 * coordinate hygiene, keep pi alive, and escalate blocked/stalled outcomes.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SETUP_HOST, type SetupHostRequest, type SetupHostResponse } from "../lib/setup-extension.js";
import { UPGRADE_HOST, type UpgradeHostRequest, type UpgradeHostResponse } from "../lib/managed-upgrades.js";

export default function automaticMemoryHost(pi: ExtensionAPI) {
	const runtimeId = `example-host/${process.pid}/${randomUUID()}`;
	const queries = new Set<string>(), attempts = new Set<string>(), runIds = new Set<string>();
	const setupQueries = new Set<string>(), setupRuns = new Set<string>();
	let prepared = false;
	let off: Array<() => void> = [];
	const send = (r: UpgradeHostRequest) => pi.events.emit(UPGRADE_HOST.request, r);
	const sendSetup = (r: SetupHostRequest) => pi.events.emit(SETUP_HOST.request, r);
	function inspectSetup() {
		const id = randomUUID(); setupQueries.add(id);
		sendSetup({ protocol: 1, id, action: "status" });
	}
	function inspectUpgrade() {
		if (!prepared) return;
		const id = randomUUID(); queries.add(id);
		send({ protocol: 1, id, action: "status" });
	}
	function warn(r: { code?: string; message?: string }) {
		if (r.code && r.code !== "not_ready") console.warn(`[memory-host] ${r.code}: ${r.message ?? "inspection failed"}`);
	}
	function attach() {
		if (off.length) return;
		off = [
			pi.events.on(SETUP_HOST.ready, () => { prepared = false; inspectSetup(); }),
			pi.events.on(SETUP_HOST.response, raw => {
				const r = raw as SetupHostResponse;
				if (setupQueries.delete(r.id)) {
					if (r.phase !== "status" || !r.session || !r.status) { warn(r); return; }
					if (r.status.phase === "blocked") { warn({ code: "setup_blocked", message: r.status.error }); return; }
					if (r.status.phase === "ready") { prepared = true; inspectUpgrade(); return; }
					const key = `setup:${r.session}:${r.status.planId}`;
					if (attempts.has(key)) return;
					attempts.add(key);
					const id = randomUUID(); setupRuns.add(id);
					sendSetup({ protocol: 1, id, action: "run", session: r.session, packageVersion: r.packageVersion,
						bundle: r.status.bundle, planId: r.status.planId, runtimeId });
				} else if (setupRuns.delete(r.id)) {
					console.warn(`[memory-host] setup ${JSON.stringify(r)}`);
					if (r.phase === "completed" && r.status?.phase === "ready") { prepared = true; inspectUpgrade(); }
				}
			}),
			pi.events.on(UPGRADE_HOST.ready, inspectUpgrade),
			pi.events.on(UPGRADE_HOST.response, raw => {
				const response = raw as UpgradeHostResponse;
				if (queries.delete(response.id)) {
					if (response.phase !== "status" || !response.session || !response.snapshot?.status) { warn(response); return; }
					const status = response.snapshot.status;
					const key = JSON.stringify([response.session, response.packageVersion, status.bundle]);
					if (attempts.has(key)) return;
					attempts.add(key);
					const id = randomUUID(); runIds.add(id);
					send({ protocol: 1, id, action: "run", session: response.session, packageVersion: response.packageVersion, bundle: status.bundle, runtimeId });
				} else if (runIds.has(response.id) && (response.terminal || response.phase === "stopping")) {
					if (response.terminal) runIds.delete(response.id);
					console.warn(`[memory-host] ${JSON.stringify({ id: response.id, phase: response.phase, code: response.code, message: response.message, result: response.result })}`);
				}
			}),
		];
	}
	attach();
	pi.on("session_start", () => { attach(); inspectSetup(); }); // discovery works in either initial load order
	pi.on("session_shutdown", () => {
		for (const unsubscribe of off) unsubscribe(); off = []; prepared = false;
		queries.clear(); attempts.clear(); runIds.clear(); setupQueries.clear(); setupRuns.clear();
	});
}
