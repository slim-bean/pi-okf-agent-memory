# AGENTS.md

pi-okf-agent-memory integrates a local OKF v0.2 corpus with pi. Read `README.md` for usage, upgrade behavior, and development commands. The current release is 0.7.0, bundling OKF v0.4.3.

## Layout

- `index.ts`: tools, knowledge-review/context commands, session index injection.
- `lib/okf.ts`: binary/bundle resolution and structured CLI diagnostics.
- `lib/diagnostics.ts`: read-only /memory-diagnostics and typed okf-binary blockers.
  Show module/candidate/settings paths, never credentials or invented loader provenance.
  Relative overrides use the session cwd; invalid explicit overrides never fall back.
- `lib/setup.ts` / `lib/setup-extension.ts`: Git-backed setup, startup confirmation and explicit `okf:setup:*` host protocol. See `docs/setup.md` for unattended provisioning; setup never grants upgrade consent.
- `lib/upgrades.ts`: append-only upgrade registry, bundle-scoped ledger, review lock and required finalization.
- `lib/git.ts`: commit proof and scoped Git operations; preserve staging outside the bundle.
  `git-status-async.ts` provides non-blocking maintenance inspection with the same
  transient/committed-ledger rules plus a final HEAD recheck. `contract-async.ts`
  shares unchanged binary checks; failures/replacements invalidate the cache.
  Never use cached status to authorize mutation or bypass final verification.
- `lib/maintenance.ts` / `lib/maintenance-git.ts`: optional snapshot review/upgrade adapter;
  see `docs/maintenance.md`. Tool-free model proposals, scoped CLI writes, validation,
  automatic commits, separately requested non-force upstream pushes. `maintenance-issue.ts`
  exposes stable Git/validation prerequisite codes for actionable coordinator messaging. Optional
  onModelEvent/onEvent callbacks expose parsed model streams and operational results to a host;
  never include auth/transport options, start another foreground agent/pi process, or release ownership before an aborted stream settles.
  model-deadline.ts preserves the first cancellation cause and elapsed/deadline metadata;
  modelTimeoutMs overrides the default 600s deadline. Native response messages stay
  unchanged; additive end-event diagnostics distinguish timeout from provider abortion.
  Own-deadline timeouts and `length` stops are structured `model-timeout`/`model-output-limit`
  issues; review halves only the failing section via a persisted split marker (never re-splits
  committed sections or splits on caller cancellation) down to a 2,000-char floor. Never launch an
  authenticated pi in tests; fake registries plus real temporary CLI/Git fixtures only.
- `lib/maintenance-repair.ts`: automatic structural repair under the adapter's bundle lock.
  Restore indexes from CLI metadata; model proposals only retarget broken body links to
  existing corpus targets, preserving labels/frontmatter/facts. Checkpoint before writes,
  guard source/corpus freshness, retain pending commit state, cap proposals at two per
  unchanged corpus/policy. Never repeat extraction to repair validation. Preserve stale
  plans as conflict evidence and replan. Facts/governance outside limited authority
  escalate to the full worker only with explicit/provisioned full ownership.
- `lib/autonomous-recovery.ts` / `lib/maintenance-model.ts`: registry-backed tool loop,
  no second pi process/session or auth loading. Full ownership investigates/qualifies/
  archives ambiguous memory rather than waiting for human approval. Eight turns and
  approximate budgets bound each opportunity; persist progress and continue automatically.
  File tools constrain roots/protect receipts and check read versions; shell is cooperative
  scope with process/network/credential authority, not a sandbox or foreground tool override.
  Preserve native responses/args; journal before writes, await cancelled streams/tools before
  releasing leases, and require host validation/commit/source binding. External model claims
  need operational failure evidence. modelTranscripts:false omits durable provider context;
  operational checkpoints still hold private corpus content.
- `lib/ownership.ts` / `lib/owned-access.ts` / `lib/maintenance-fingerprint.ts`: workspace/
  host override > PI_MEMORY_OWNERSHIP > limited everywhere. Platform-specific
  defaults/detection belong in host adapters. Settings are not authenticated identity. Metadata-only owner
  access restoration may precede locking; no symlink following/foreign UID changes/Git
  object chmod. Content fingerprints + daily health keys re-admit corpus validation without
  re-paying committed extraction; preserve checkpoint namespace across policy changes.
- `lib/upgrade-extension.ts`: shared interactive/host workflow, notices and step delivery.
- `lib/managed-upgrades.ts`: versioned in-process host protocol, idle scheduling and lifecycle. See `docs/managed-upgrades.md`; `examples/managed-host.ts` is an explicitly loaded example, never a default package resource.
- `skills/okf-memory/`: why-only budget and normal memory workflow.
- `skills/okf-memory-upgrade/`: review skill plus ordered historical step guides.
- `bin/`: standalone macOS/Linux arm64/amd64 binaries; `UPSTREAM.json` records release checksums. `bin/okf` is the legacy Linux amd64 copy.
- `scripts/update-okf.mjs`: maintainer-only vendoring from an explicit release tag; verify release checksums, use `--static-linux` to retain CGO-free Linux portability. Preserve `bin/NOTICES.md` for bundled dependencies.
- `install.sh`: resource-only local-copy installation; ship helper modules, package metadata, binaries, and both skills. Use shared session setup, not a second shell bootstrap.
- `test/setup.mjs` / `test/smoke.mjs` / `test/managed.mjs`: portable jiti/real-CLI/Git fixtures and mock pi API/hosts (`npm test`). `npm run test:rpc` checks real pi startup/dialogs offline without model calls. Optional `/workspace/knowledge` checks stay read-only and skip when absent. Use `PI_TEST_PACKAGE_DIR` for a nonstandard installed pi.

## Invariants

- Startup/status inspection never mutates or starts an agent turn. Limited TUI startup can offer setup; writes need confirmed session/plan-bound consent or explicit host setup. Configured full ownership is standing setup/recovery authority; suppress startup dialogs, make /memory-setup humanless and delegate /memory-upgrade to the maintenance coordinator. Never prompt unsolicited in RPC/headless; `OKF_SETUP_MODE=manual` also suppresses provisioned TUI prompts. Setup and upgrade consent are separate. Check both on reload.
- Setup preserves existing content/ledgers, reuses enclosing worktrees, initializes Git only inside a bundle with no repository, and refuses broken metadata/nonempty non-bundles. No identity, commits, remotes or pushes. Host setup requires idle/no maintenance and is synchronous; no hidden retry loop or automatic stale-lock removal.
- Skills explain; the runner enforces ordering and deterministic verification. Reading a skill or dismissing a notice never marks completion.
- Persist progress/adopted package version per canonical bundle. Consent is interactive or an explicit trusted host request bound to the current session/bundle/version; never infer it from prose. Host requests cover all installed pending steps and the local commit, with no allowlist/persona config. Upgrade host consent alone never grants push authority. Separately requested maintenance
  pushes require an existing upstream. No fabricated identity/verification or hook bypass.
- Managed work waits for safe idle and maintenance holds. Terminal host success follows verified commit AND settle; deadlines/cancellation never unlock a running writer. Recovery requires exact lock/runtime correlation plus explicit host confirmation of old-runtime termination; it is not proof or a security boundary.
- Final success requires validation and a verified Git commit, not just a local ledger. Failed finalization stays pending/retryable without rewriting step records. Never include transient files or unrelated outer-repository staging.
- Step IDs/order are immutable. Retain historical guides/verifiers when releases are skipped. New steps must work with the current binary and be safe to retry. Verifiers are read-only and run again before and after finalization. Unknown/corrupt ledger state fails closed.
- Validation preserves stdout diagnostics on exit 1. Isolation is advisory by default; OKF_ORPHAN_POLICY=strict opts in to requiring semantic links. Relax only a proven orphan-only failure confirmed by upstream non-strict validation. Schema, governance/provenance, warnings/drift, broken links and stale data still block persistence.
- Maintenance emits structured deferred/blocked/error issues keyed by canonical resource. Limited mode repairs within structural authority; full mode recovers broader memory failures automatically, with no normal human approval. Missing credentials/compatible runtimes/mounts and unrelated project Git operations are host prerequisites, not console questions. Never guess authors, forge verification, weaken validation, force push or bypass hooks/signing. Keep private work outside the bundle. Yield when extraction consumed the opportunity's model allowance. Preserve cached extraction journals across repair/validation-policy changes; stable evidence markers survive link correction. Revalidate before completing/committing.
- Advisory locks are not a security sandbox. Do not claim to prevent arbitrary shell edits or prove model comprehension.
- pi-bundled imports belong in optional `peerDependencies` with `"*"`, never `dependencies`. Keep `pi-package` in keywords.
- Publish a matching `vX.Y.Z` Git tag for each release; do not tag/push merely to test a working-tree change.
- Keep docs concise. Persistent project memory records *why*; git already records *what*.
