# Managed upgrades: host integration protocol v1

This interface lets a trusted pi host adapter (for example an unattended runtime adapter) run the same upgrade workflow as `/memory-upgrade`, without a console or dialog. It works in TUI, RPC, and host-managed headless runtimes kept alive for the operation. **No persona settings, step allowlist, or environment opt-in are required.** The explicit host `run` request supplies consent for all applicable steps of the currently loaded package.

There is no automatic network update mechanism here. The host deploys the newest package, restarts/reloads pi, and requests an upgrade for that installed version. An old runtime cannot upgrade itself by naming a version it has not loaded. Startup inspection stays read-only; setup writes require separate user confirmation or an explicit host setup request. Setup alone never starts an agent turn or grants upgrade consent.

## Responsibilities

| Extension | Host |
|---|---|
| Resolve the bundle and actual CLI; expose installed/adopted versions | Deploy the desired package and restart/reload the runtime |
| Apply all pending guides in order; retain step/turn guards | Send a run request on startup/version change (reissuing on startup is harmless) |
| Wait for idle, no queued messages, no unresolved tool calls, no maintenance hold | Coordinate its own compaction/review jobs using hold/maintenance events |
| Verify, commit locally, and return a structured outcome | Observe outcomes, apply backoff, and escalate blocked/stalled work |
| Keep Git progress across sessions; reject stale request bindings | Identify runtime generations and establish old-runtime termination before recovery |

First establish a Git-backed bundle through provisioning or the separate **[setup protocol](setup.md)**. Provisioned TUI runtimes should use `OKF_SETUP_MODE=manual` to suppress startup dialogs; that setting grants no write authority. Setup and upgrade readiness/session bindings are independent.

No host-platform command or schema is required by this protocol. `examples/managed-host.ts` demonstrates setup followed by a generic automatic upgrade host. It is **not auto-loaded** by this package. Loading it explicitly grants this maintenance behavior for the resolved agent-owned bundle.

## Transport and discovery

Use the in-process `pi.events` bus. This is **not** a new network/RPC endpoint or an LLM-callable start tool. A remote harness can implement an adapter inside pi that forwards its trusted control requests/results. Do not turn arbitrary comm text, model output, or `/memory-upgrade` strings into consent, and do not auto-answer dialogs.

Channels (also exported as `UPGRADE_HOST` from `lib/managed-upgrades.ts`):

- `okf:upgrade:ready`: emitted after this extension's session-start setup. Payload: `{ protocol: 1, session, packageVersion }`. `session` is a fresh opaque runtime/session binding, not an authentication token.
- `okf:upgrade:request`: requests below.
- `okf:upgrade:response`: correlated status/progress/outcomes.
- `okf:upgrade:maintenance`: `{ protocol: 1, session, packageVersion, active, runId, holds }` for local maintenance coordination.

Register listeners before requesting status. During initial load a request before readiness gets `not_ready`; during teardown the listener is absent. Wait for `ready` (with a host-side timeout), not terminal keystrokes. Session replacement and reload invalidate the old binding. Listeners/timers are disposed on shutdown and reattached if the runtime reuses this extension instance.

### 1. Inspect (always read-only)

```typescript
pi.events.emit("okf:upgrade:request", {
  protocol: 1, id: "inspect-1", action: "status",
});
```

The response has `phase: "status"` and:

- `session`, `packageVersion`: current request-binding values.
- `snapshot.status.bundle`: canonical resolved bundle path.
- `snapshot.status.appliedPackageVersion`, `versionPending`: release adoption.
- `snapshot.status.pending`: ordered remaining step IDs/titles.
- `snapshot.status.finalization`, `finished`: required Git completion state.
- `snapshot.version`, `binary`: actual resolved CLI, including overrides.
- `snapshot.lock`: `null` or the current lock's token, hostname, PID, start time, and optional host `runtimeId`.
- `maintenance`: local active/queued run and other-maintenance holds.

Malformed/unsupported state or a missing binary produces a structured blocked response. With no bundle, status returns `snapshot.status: null`; run requests are refused. Nothing is bootstrapped implicitly by this upgrade protocol. Missing Git backing is rejected before review dispatch; use the separate setup protocol first.

### 2. Run the newest installed version

Copy the binding from the status response; do not reconstruct the bundle path or reuse a previous session's binding.

```typescript
pi.events.emit("okf:upgrade:request", {
  protocol: 1,
  id: "memory-upgrade-attempt-42",
  action: "run",
  session: status.session,
  bundle: status.snapshot.status.bundle,
  packageVersion: status.packageVersion,
  runtimeId: "sandbox-uid/pod-uid/session-generation",
});
```

This approves **all pending installed steps**, necessary upgrade-related repairs inside the agent-owned bundle, and the required local Git commit (including existing agent-owned bundle work). No interactive confirmation follows. There is no version/step-selection policy to configure.

The managed prompt replaces interactive repair-plan approval with a transcript plan/checkpoint, followed by scoped work. In limited ownership it does **not** grant new governance authority; unresolved facts/policy become a structured `block`, not an unattended question. Configured full ownership instead grants scoped corpus/governance/lifecycle corrections: investigate, qualify or archive unsupported memory, and block only for genuinely unavailable external resources. Neither mode permits external project edits, fabricated human verification/review dates, pushes, Hub sync, credential changes or instruction replacement.

For fully automatic repair/continuation rather than this host-managed foreground
review, use [the maintenance adapter](maintenance.md) with full ownership and
pi-session-maintenance. It persists tool-based recovery cases, budgets and retries.
In full mode `/memory-upgrade` delegates to that coordinator without a dialog;
`memory_upgrade` still cannot manufacture a managed run or bypass its step guards.

A package-version change with no new steps re-verifies and commits an `application` receipt in the existing ledger. Old step records/timestamps are preserved and no LLM review is replayed. Legacy ledgers derive their adopted version from the last recorded step. An already adopted and committed version returns success without another commit or model turn. Stable numeric package downgrades and unknown/newer step state are refused.

### Responses and completion

Every response has `protocol`, `id`, `session`, `packageVersion`, `phase`, `terminal`, and `maintenance`; status/hold/recovery/cancel-ack replies are terminal for their own request IDs (not for the target run). It may include `code`, `message`, `snapshot`, and `result`. Run responses also carry the original `target: {session,bundle,packageVersion}` and `runtimeId` so a scope-change failure cannot be mistaken for a result about the new bundle.

Run phases:

- `queued`: accepted, but waiting for a safe window. `code` may be `agent_busy`, `pending_messages`, `unresolved_tools`, `interactive_review_active`, `host_hold`, or `idle_state_unavailable`.
- `running`: owns the maintenance slot and is dispatching/running the review.
- `finishing`: the verifier/commit succeeded, but the agent has not safely settled yet. **Not terminal.**
- `stopping`: cancellation/deadline/block requested; the runtime may still be executing. **Not terminal; do not start a competing writer.**
- `completed`: terminal; `result.finished === true` and `result.commit` identifies the verified local commit. Maintenance and the bundle lock have been released.
- `blocked` / `cancelled`: terminal; durable step progress remains and no rollback occurred.

Use **`phase === "completed" && terminal === true`**, not prose, `agent_end`, or just a ledger's `finished` field, as the host completion signal. Do not skip retries merely because package-version strings match: a working-tree application record can exist before a failed commit; check pending steps/finalization as well. `agent_settled` without verified completion becomes `blocked/review_incomplete`—it is not success.

Responses are in-process notifications, not a durable queue. Status and the committed ledger reconcile lost notifications. The extension keeps a bounded cache of 128 run IDs per live session; duplicates replay their latest response and changed fields under the same ID are refused. A new retry uses a new ID. After runtime replacement, query fresh status and issue a fresh-bound run. This is idempotent progress, not an exactly-once delivery guarantee.

## Maintenance coordination

Use `action: "hold"` with the current binding, `key: "context-hygiene"`, and `held: true/false` while another local maintenance operation owns the runtime. Holds block launch, not ordinary coding. They reset on session replacement/shutdown. A hold requested after an upgrade is already running is rejected with `maintenance_busy`: defer that other job instead.

Listen to `okf:upgrade:maintenance` and avoid starting new ordinary knowledge reviews/compaction while `active` is true. Do not add a hold for the upgrade itself; the extension already owns that slot. Pair every host hold with release in the host's own `finally`/recovery path. This is coordination among cooperating extensions, not a filesystem or process sandbox.

Scheduling happens on a deferred timer, after the lifecycle event handlers have returned. Conditions are rechecked at dispatch, including after maintenance listeners have run. Queued work is revisited on settle/hold changes and a one-second fallback. The extension does not hijack or interrupt a busy task.

## Deadlines, cancellation and retry

A request has a 30-minute queue/review deadline and a 30-second dispatch-acceptance watchdog. The extension observes its input before potentially slow auth/model preflight; it does not equate a quiet `isIdle()` with proof that an issued prompt will never execute. An uncertain dispatch stays `stopping` with its lease retained until a settle event or runtime teardown. There is no autonomous retry loop. A deadline reports a blocked/stopping condition; it **does not kill a pi process or unlock a running writer**. Host code owns abort/reset/escalation of a runtime that never settles. Synchronous CLI/Git work cannot be interrupted by a JS timer; deadlines are operational watchdogs, not hard process-execution limits.

To cancel, emit `action: "cancel"` with the current binding and `runId` of the active request. The cancellation request receives `cancel_requested`; watch the original run ID for its eventual terminal outcome. Pending work can cancel immediately; dispatched work retains its lock until idle/settled or runtime teardown. Changes, staging, and commits are not rolled back. The host can also inspect progress after a failure and request another run—recorded steps and Git-only retries do not repeat completed reviews.

No GUI is needed for host-managed work. A one-shot `pi --print` may exit before a deferred job runs; use a persistent RPC/SDK/TUI lifecycle or otherwise keep the runtime alive until the terminal response. Runtime shutdown cancels the request rather than claiming it completed. The limited interactive command still requires confirmation; full ownership delegates the command to the automatic coordinator. The model cannot grant itself a managed run through `memory_upgrade`.

## Cross-runtime lock recovery

Run requests stamp `runtimeId` into their advisory bundle lock. After a crash/pod replacement:

1. Inspect fresh status and the exact lock owner/token.
2. The host establishes from its infrastructure that the old runtime has actually terminated and that recovery is serialized (no competing recovery/start controller).
3. Emit `action: "recover"` with the current binding, `lockToken`, `stoppedRuntimeId`, and `previousRuntimeStopped: true`.
4. On `recovered`, request a new run. Recovery alone does not start one.

The extension checks exact token/runtime correlation and refuses a demonstrably live local PID, an active review, or a non-idle runtime. It does not infer remote death from age or hostname differences. A replacement lock/token mismatch is refused. Legacy unstamped or malformed locks require separate inspection; there is no force-unlock request.

The host's termination assertion is a **trust assumption**, not proof supplied by this package. An agent-controlled file or claimed display name cannot provide infrastructure-owned evidence. Never use this API as a reason to bypass the host's actual runtime-termination checks.

## Assurance and integration checklist

This API selects behavior inside an already trusted pi process. Event payloads, runtime IDs, the Git ledger, and `okf-upgrade-host` session entries are **cooperative** diagnostics, not authentication or tamper-proof audit. They add no network credentials or new external authority. Hosts should record dispatch/outcomes through their own observation point with an attempt ID, sandbox/runtime identity, installed version, bundle, and returned commit or unresolved blocker; distinguish an observed report from independently verified storage state.

For host integration:

- Publish/pin this package and its native executable checksums; update image contract expectations.
- Install a host adapter that requests the latest loaded version on readiness and knows how to coordinate hygiene.
- Establish the intended agent-owned Git-backed bundle through provisioning or an explicit setup request, then request upgrades with fresh upgrade bindings. Provision identity/signing separately; this extension never invents identity.
- Route blocked/stalled outcomes to existing monitoring/comm machinery with bounded retries.
- Test against the host's deployed pi and native architectures, then a real unattended session with no attached operator.

Host-specific defaults, deployment files and persona schemas belong to the host, not this package.
