# AGENTS.md

pi-okf-agent-memory integrates a local OKF v0.2 corpus with pi. Read `README.md` for usage, upgrade behavior, and development commands. The current release is 0.2.0, bundling OKF v0.4.3.

## Layout

- `index.ts`: tools, knowledge-review/context commands, session index injection.
- `lib/okf.ts`: binary/bundle resolution and structured CLI diagnostics.
- `lib/setup.ts` / `lib/setup-extension.ts`: Git-backed setup, startup confirmation and explicit `okf:setup:*` host protocol. See `docs/setup.md` for provisioning/Yono; setup never grants upgrade consent.
- `lib/upgrades.ts`: append-only upgrade registry, bundle-scoped ledger, review lock and required finalization.
- `lib/git.ts`: commit proof and scoped Git operations; preserve staging outside the bundle.
- `lib/maintenance.ts` / `lib/maintenance-git.ts`: optional snapshot review/upgrade adapter;
  see `docs/maintenance.md`. Tool-free model proposals, scoped CLI writes, validation,
  automatic commits, separately requested non-force upstream pushes. Never launch an
  authenticated pi in tests; fake registries plus real temporary CLI/Git fixtures only.
- `lib/upgrade-extension.ts`: shared interactive/host workflow, notices and step delivery.
- `lib/managed-upgrades.ts`: versioned in-process host protocol, idle scheduling and lifecycle. See `docs/managed-upgrades.md`; `examples/managed-host.ts` is an explicitly loaded example, never a default package resource.
- `skills/okf-memory/`: why-only budget and normal memory workflow.
- `skills/okf-memory-upgrade/`: review skill plus ordered historical step guides.
- `bin/`: standalone macOS/Linux arm64/amd64 binaries; `UPSTREAM.json` records release checksums. `bin/okf` is the legacy Linux amd64 copy.
- `scripts/update-okf.mjs`: maintainer-only vendoring from an explicit release tag; verify release checksums, use `--static-linux` to retain CGO-free Linux portability. Preserve `bin/NOTICES.md` for bundled dependencies.
- `install.sh`: resource-only local-copy installation; ship helper modules, package metadata, binaries, and both skills. Use shared session setup, not a second shell bootstrap.
- `test/setup.mjs` / `test/smoke.mjs` / `test/managed.mjs`: portable jiti/real-CLI/Git fixtures and mock pi API/hosts (`npm test`). `npm run test:rpc` checks real pi startup/dialogs offline without model calls. Optional `/workspace/knowledge` checks stay read-only and skip when absent. Use `PI_TEST_PACKAGE_DIR` for a nonstandard installed pi.

## Invariants

- Startup/status inspection never mutates or starts an agent turn. TUI startup can offer setup; writes need confirmed session/plan-bound consent or explicit host setup. Never prompt unsolicited in RPC/headless; `OKF_SETUP_MODE=manual` also suppresses provisioned TUI prompts. Setup and upgrade consent are separate. Check both on reload.
- Setup preserves existing content/ledgers, reuses enclosing worktrees, initializes Git only inside a bundle with no repository, and refuses broken metadata/nonempty non-bundles. No identity, commits, remotes or pushes. Host setup requires idle/no maintenance and is synchronous; no hidden retry loop or automatic stale-lock removal.
- Skills explain; the runner enforces ordering and deterministic verification. Reading a skill or dismissing a notice never marks completion.
- Persist progress/adopted package version per canonical bundle. Consent is interactive or an explicit trusted host request bound to the current session/bundle/version; never infer it from prose. Host requests cover all installed pending steps and the local commit, with no allowlist/persona config. Upgrade host consent alone never grants push authority. Separately requested maintenance
  pushes require an existing upstream. No fabricated identity/verification or hook bypass.
- Managed work waits for safe idle and maintenance holds. Terminal host success follows verified commit AND settle; deadlines/cancellation never unlock a running writer. Recovery requires exact lock/runtime correlation plus explicit host confirmation of old-runtime termination; it is not proof or a security boundary.
- Final success requires validation and a verified Git commit, not just a local ledger. Failed finalization stays pending/retryable without rewriting step records. Never include transient files or unrelated outer-repository staging.
- Step IDs/order are immutable. Retain historical guides/verifiers when releases are skipped. New steps must work with the current binary and be safe to retry. Verifiers are read-only and run again before and after finalization. Unknown/corrupt ledger state fails closed.
- Validation preserves stdout diagnostics on exit 1. Isolation is advisory by default; OKF_ORPHAN_POLICY=strict opts in to requiring semantic links. Relax only a proven orphan-only failure confirmed by upstream non-strict validation. Schema, governance/provenance, warnings/drift, broken links and stale data still block persistence.
- Maintenance emits structured deferred/blocked/error issues keyed by canonical resource. Preserve cached extraction journals across validation-policy changes; revalidate before completing/committing.
- Advisory locks are not a security sandbox. Do not claim to prevent arbitrary shell edits or prove model comprehension.
- pi-bundled imports belong in optional `peerDependencies` with `"*"`, never `dependencies`. Keep `pi-package` in keywords.
- Publish a matching `vX.Y.Z` Git tag for each release; do not tag/push merely to test a working-tree change.
- Keep docs concise. Persistent project memory records *why*; git already records *what*.
