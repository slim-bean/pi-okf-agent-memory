# Git-backed memory setup

Memory needs a knowledge bundle in a usable Git worktree. `pi install` installs resources, not project data; adding the package to pi settings has the same effect. On `session_start` (including reload/resume/fork), the extension inspects the resolved location. The extension factory and status operations do not create files or start model turns.

## Interactive use

In TUI mode, startup offers **Set up Git-backed memory?** once per bundle per extension runtime. Declining leaves the filesystem unchanged. Use `/memory-setup` to try again; `/memory-setup status` is read-only.

With explicit confirmation, deterministic extension code:

1. Creates an empty OKF bundle if absent. A nonempty directory without `index.md` is refused rather than overwritten; an otherwise empty pre-initialized Git repo is supported.
2. Reuses an enclosing Git worktree, including linked worktrees. No nested repository is created in that case.
3. If there is no repository, runs `git init` **inside the bundle only**. It never initializes the parent project.
4. Leaves existing knowledge content and upgrade records unchanged. Broken/dangling Git metadata, bare repositories, ownership/Git errors, or active upgrade locks require operator attention, not replacement Git history.

If an earlier failed upgrade still owns a review, stop the agent and `/memory-upgrade cancel` before setup; recorded steps stay intact. A crashed owner's lock needs explicit recovery first.

Setup makes **no commit**, sets no author identity, adds no remote, pushes nothing, and does not approve or mark any upgrades complete. Existing Git configuration and initialization templates are honored. Run `/memory-upgrade` separately to review/validate and make the required local commit. A working Git identity/signing/hooks configuration is required for that commit; setup success alone does not prove it will work. Read-only memory tools remain available for diagnosis while setup is incomplete.

Paths follow the normal resolver: explicit `OKF_KNOWLEDGE_DIR` (relative to session cwd if needed), existing `<cwd>/knowledge`, then existing `/workspace/knowledge` for `/workspace`-rooted sessions only. With no existing bundle or override, creation targets `<cwd>/knowledge`. Missing explicit paths never fall back elsewhere. Existing ancestors/symlink aliases are canonicalized before approval. The approved path/plan and session are checked again before writing.

## Unattended and provisioned sessions

**No unsolicited dialogs in RPC, JSON, or print mode**, even though RPC reports `hasUI: true`. An operator may explicitly invoke `/memory-setup` through an RPC client that implements confirmations. Do not auto-answer dialogs to manufacture host consent.

For a provisioned **TUI** runtime without an attached operator (such as Yono's pi launcher), set:

```bash
export OKF_SETUP_MODE=manual
export OKF_KNOWLEDGE_DIR=/workspace/knowledge  # choose your actual persistent bundle
```

`OKF_SETUP_MODE` accepts `prompt` (default: offer in TUI) or `manual` (no startup dialogs). It **never grants permission to create files or run upgrades**. Explicit `/memory-setup` remains available. Invalid values suppress the startup dialog and produce a diagnostic. In manual mode, either provision the Git-backed bundle before pi starts or load a trusted adapter using the host protocol below.

### Provision before pi starts

Provisioning may create/restore the bundle and its intended worktree before launching pi. Startup sees a ready setup and does not change it. The provisioner owns correct Git mounts (including linked worktree metadata), filesystem ownership, Git author/signing credentials and persistence. Both the knowledge files and Git metadata must survive runtime replacement.

For a **known-new standalone** bundle only, the essential operations are:

```bash
"$OKF" init "$BUNDLE"   # exact installed native binary; it may not be on PATH
git -C "$BUNDLE" init
```

Do not use this recipe as a blind repair command for restored or existing storage. Inspect existing worktree metadata first, and reuse an enclosing repository rather than creating nested history. The extension's host setup path handles those checks. Neither provisioning nor `git init` completes package upgrade review. No seed concepts are necessary.

### Host protocol v1

Use the trusted **in-process** `pi.events` bus, not an LLM tool or a new RPC/network endpoint. An SDK/RPC harness can load a host adapter extension and forward its own trusted control requests. Channel names and TypeScript request/response types are exported by `lib/setup-extension.ts`:

- `okf:setup:ready`: `{ protocol: 1, session, packageVersion }`
- `okf:setup:request`: `status` or `run`
- `okf:setup:response`: correlated terminal result

Attach listeners during the adapter factory, then wait for readiness (with a host-side timeout). Status is also safe for discovery when loaded after readiness; `not_ready` means wait. Setup and upgrade readiness/bindings are **independent**; don't use a setup session token for upgrades.

```typescript
pi.events.emit("okf:setup:request", {
  protocol: 1, id: "inspect-setup-1", action: "status",
});
```

The response includes `protocol`, `id`, `session`, `packageVersion`, `phase: "status"`, `terminal: true`, and `status`:

| Field | Meaning |
|---|---|
| `bundle` | Canonical target, including when the bundle does not yet exist |
| `phase` | `ready`, `needed`, or `blocked` |
| `createBundle`, `initGit` | Proposed operations |
| `repository` | Existing canonical worktree root, or null |
| `planId` | Opaque binding to the inspected path/operations/repository state |
| `error` | Operator-facing reason if blocked |

The host explicitly approves that plan by copying its binding:

```typescript
pi.events.emit("okf:setup:request", {
  protocol: 1, id: "setup-attempt-1", action: "run",
  session: inspected.session,
  packageVersion: inspected.packageVersion,
  bundle: inspected.status.bundle,
  planId: inspected.status.planId,
  runtimeId: "sandbox-uid/pod-uid/session-generation",
});
```

This approves **only setup**, not upgrades, commits, repairs to existing content, or replacement of existing Git metadata. It runs without dialogs or an LLM. A response with `phase: "completed"`, `terminal: true`, and `status.phase: "ready"` means a bundle and usable Git worktree now exist. An already-ready request is a no-op. It is not proof of validation, committed history, or successful release adoption.

All setup responses are terminal; there is no deferred queue, `running` phase, automatic retry, cancellation API, or implicit upgrade continuation. CLI/Git calls are synchronous and bounded by their subprocess timeouts, not a hard end-to-end deadline. Requests require idle/no queued input/no unresolved tools, no interactive setup/review, no queued/running managed upgrade and no upgrade maintenance holds. A `maintenance_busy` response makes no setup changes; the host chooses a later window and a new request ID. Hosts should serialize bootstrap **before ordinary input or hygiene**; the API is cooperative coordination, not a barrier against arbitrary filesystem writers.

Other blocked codes include `unsupported_protocol`, `not_ready`, `invalid_request`, `binding_mismatch`, `id_conflict`, and `setup_failed`. Status can itself describe a blocked filesystem plan. Diagnose missing Git/binary/permissions/storage instead of retrying indefinitely. Failed setup may leave newly created files or directories; there is no destructive rollback. Inspect fresh status before retrying.

The extension caches up to 128 executed run results per live session. An identical run ID replays its receipt; changed fields under that ID are refused. Receipts are historical outcomes, so request fresh status to reconcile current storage after a lost response. Reload/session replacement invalidates old bindings. A new retry needs fresh status and a new ID; there is no exactly-once guarantee across process death.

A sibling directory lock `.<bundle-name>.pi-okf-setup.lock` serializes cooperating setup writers, including creation of an absent bundle. It is outside the bundle and contains no knowledge. A crash can leave this lock. **Only after establishing that all setup writers have stopped**, remove that empty lock directory and retry. No automatic stale-lock stealing. Upgrade locks have their own [recovery protocol](managed-upgrades.md#cross-runtime-lock-recovery).

### Setup → upgrades

After setup is ready, query **fresh upgrade status** and send a separate upgrade `run` bound to its own session, canonical bundle and installed package version. Upgrade execution still follows idle scheduling, holds, verification, commit and settle. Keep pi alive until its terminal outcome; a one-shot print invocation is not an upgrade worker.

[`examples/managed-host.ts`](../examples/managed-host.ts) implements this sequence and handles either initial extension load order. It is **not** a default package resource. Explicitly loading it grants setup plus upgrade/repair/local-commit authority for the resolved bundle. The example makes one attempt per binding, logs outcomes and does not automatically recover locks or retry blockers. A production adapter must coordinate other maintenance and route failures to its existing monitoring/recovery path.

```bash
OKF_SETUP_MODE=manual pi \
  -e /path/to/pi-okf-agent-memory \
  -e /path/to/pi-okf-agent-memory/examples/managed-host.ts
```

The adapter/event bus and `okf-setup-host` transcript receipts are **COOPERATIVE** diagnostics in a trusted process, not authenticated host identity or tamper-proof infrastructure audit. A host requiring **OBSERVED** records must record its own request/runtime/path/version and returned or unresolved outcome outside agent-controlled storage. A transcript append failure is warned about but cannot roll back filesystem setup.

## Yono integration notes

Inspected against `~/projects/yono-worktree/main/`:

- `images/features/pi/yono-pi-start.sh` currently bootstraps missing knowledge files with `okf init` and leaves existing bundles untouched. It does **not** initialize Git. This package's setup handles those existing bundles without rewriting content.
- The launcher executes TUI pi, even when no operator is attached. Provision `OKF_SETUP_MODE=manual`; do not rely only on `ctx.hasUI` to decide whether someone can answer a dialog.
- Set `OKF_KNOWLEDGE_DIR` consistently with `YONO_WORKSPACE_PATH` and the hygiene resolver, especially for a non-default workspace. Do not accidentally create separate bundles for subdirectory sessions.
- Deploy/pin the new package and native binaries through `deps.yaml`, `images/features/pi/install-extensions.sh`, and the image contract in `okf-agent-memory-contract.mjs`. This checkout does not update Yono's deployment pins.
- Load a Yono-owned adapter (or explicitly opt into the example) to perform setup first, then managed upgrades. Coordinate `yono-context-hygiene-ext.ts` using upgrade hold/maintenance events so compaction/review and upgrades don't overlap. Existing Yono hygiene does not automatically implement this protocol.
- Preserve Git state with the bundle and provision real author/signing configuration. No fake sandbox identity is supplied by this extension.
- Use Yono's infrastructure runtime identity and failure reporting; event-bus/transcript labels alone are not authoritative audit or termination proof.

No Yono source/deployment is modified here. The local-copy installer now installs resources only and uses this same session-time setup flow instead of a separate shell bootstrap that invented identity/commits. Validate Yono's native Linux image contract and an unattended sandbox after integrating the adapter; local package/RPC tests are not a substitute for that deployment test.
