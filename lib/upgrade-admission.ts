import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Optional projection of the existing v1 control response. Older hosts may only return admission text. */
interface RecordedIssue {
	resource?: string;
	kind?: string;
	code?: string;
	message?: string;
	error?: string;
	lastAttemptAt?: number;
	parked?: unknown;
	detail?: { recovery?: { casePath?: string; pendingRepair?: string; cause?: string; attempts?: number }; external?: { reason?: string } };
}
interface CoordinatorStatus {
	admission?: string;
	enabled?: boolean;
	config?: { memoryOwnership?: "limited" | "full"; upgrades?: boolean; knowledge?: boolean };
	running?: { stage: string } | null;
	sessions?: { cwd: string; errors?: { upgrade?: RecordedIssue; review?: RecordedIssue } }[];
}

export function maintenanceControl(pi: ExtensionAPI, operation: "status" | "run") {
	const request: { protocol: 1; operation: typeof operation; result?: Promise<CoordinatorStatus> } = { protocol: 1, operation };
	pi.events.emit("pi-session-maintenance:control:v1", request);
	return request.result;
}

// Error text comes from Git/providers/models. Keep it bounded and on one line in command notifications.
const line = (value: string, limit = 600) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, limit);
export const noCoordinator = "Load pi-session-maintenance or have the trusted host schedule the upgrade through okf:maintenance:v1. Full ownership does not need interactive approval.";
export const upgradesDisabled = "The Upgrades stage is disabled. Enable it in /maintenance settings (or through the host), then let the coordinator schedule the upgrade.";

function nextAction(issue: RecordedIssue) {
	if (issue.code === "memory-recovery-stalled" || issue.code === "memory-recovery-transient") {
		return "Inspect recovery evidence in /maintenance history; if the model is not making progress, select a more capable review model in /maintenance settings.";
	}
	if (issue.kind === "deferred") return "Wait for the next safe maintenance opportunity. Use /maintenance watch to follow an active run.";
	if (issue.code === "memory-external" || issue.code?.startsWith("git-")) {
		return "Address the reported prerequisite through the host or repository configuration, then use /maintenance retry. Retry alone does not fix it.";
	}
	return "Inspect /maintenance status and /maintenance history for prerequisites and retry guidance.";
}

/** Use only recorded bundle-scoped metadata. Never open private case transcripts or treat a record as a receipt. */
export function describeUpgradeAdmission(status: CoordinatorStatus | undefined, cwd: string, bundle: string | null): string {
	if (!status) return noCoordinator;
	if (status.config?.upgrades === false) return upgradesDisabled;
	if (status.running?.stage === "upgrade") return "The coordinator is running an upgrade. Use /maintenance watch to follow progress.";
	const hints: string[] = [];
	if (status.enabled === false) hints.push("Maintenance is off or suspended; check /maintenance status for how to resume it.");
	for (const stage of ["upgrade", "review"] as const) {
		if (!bundle || (stage === "review" && status.config?.knowledge === false)) continue;
		const newest = status.sessions?.filter(record => record.cwd === cwd).map(record => record.errors?.[stage])
			.filter((issue): issue is RecordedIssue => issue?.resource === bundle && (stage === "upgrade" || !!issue.detail?.recovery))
			.sort((a, b) => (b.lastAttemptAt ?? 0) - (a.lastAttemptAt ?? 0))[0];
		if (!newest) continue;
		const attempt = new Date(newest.lastAttemptAt ?? NaN);
		const when = Number.isFinite(attempt.getTime()) ? ` (${attempt.toISOString()})` : "";
		const label = stage === "upgrade" ? "Last recorded upgrade issue" : "Related knowledge-review recovery (not an upgrade prerequisite)";
		hints.push(`${label}${when} [${line(newest.code ?? "unknown", 80)}]: ${line(newest.message ?? newest.error ?? "No diagnostic recorded.")}`);
		const recovery = newest.detail?.recovery;
		if (recovery?.casePath) hints.push(`Recovery case: ${line(recovery.casePath, 1024)}`);
		else if (recovery?.pendingRepair) hints.push(`Recovery queued; pending marker: ${line(recovery.pendingRepair, 1024)}`);
		const cause = recovery?.cause ?? newest.detail?.external?.reason;
		if (cause) hints.push(`Cause: ${line(cause)}`);
		if (recovery?.attempts !== undefined && Number.isSafeInteger(recovery.attempts) && recovery.attempts >= 0) hints.push(`Recovery attempts: ${recovery.attempts}`);
		hints.push(nextAction(newest));
		if (newest.parked && newest.code !== "memory-external" && !newest.code?.startsWith("git-")) {
			hints.push("The last recorded issue parked automatic retries. After addressing it, /maintenance retry requests a new admission without discarding evidence.");
		}
	}
	return hints.join("\n") || "Inspect /maintenance status for scheduler gates and /maintenance watch or history for progress.";
}
