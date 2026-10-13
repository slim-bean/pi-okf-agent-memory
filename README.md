# pi-okf-agent-memory

[pi](https://pi.dev) extension and skills for [OKF Agent Memory](https://github.com/okf-memory/okf-agent-memory): local, Git-native project memory that retains **why** decisions were made without turning session history into a knowledge dump.

Release **0.5.0** bundles **OKF v0.4.3**. The corpus format remains **OKF v0.2**.
This release adds configurable maintenance deadlines and explicit abort diagnostics
for coordinator-owned run transcripts; no new corpus migration is required.

## Install

Test this checkout:

```bash
pi install .
# or try it for one invocation
pi -e .
```

Install this release using its pinned tag:

```bash
pi install git:github.com/slim-bean/pi-okf-agent-memory@v0.5.0
pi install -l git:github.com/slim-bean/pi-okf-agent-memory@v0.5.0  # project-local
```

Pinned refs do not move automatically. Select the new tag explicitly, then restart pi or `/reload`. The extension checks project upgrade progress when it loads; it does not poll for available package releases.

Prebuilt binaries support macOS/Linux on arm64/amd64; no build step or database is needed. Package installation **does not add `okf` to PATH**. Use the resolved executable path supplied in session context, or a host-matched binary from this checkout:

```bash
./bin/okf-darwin-arm64 --version  # example for Apple Silicon
```

Git is required. On the first TUI session, accept the setup prompt (or run `/memory-setup`) to create an empty bundle and initialize Git inside it if no enclosing worktree exists. Package installation itself does not create project data. Setup never invents identity, commits, pushes, or approves upgrades; `/memory-upgrade` is the separate review/commit step.

RPC/headless startup never opens unsolicited dialogs. For provisioned TUI sessions without an operator, set `OKF_SETUP_MODE=manual` and provision the bundle or authorize the host setup protocol. See **[Setup and unattended provisioning](docs/setup.md)** for host integration.

Optional environment variables:

- `OKF_BIN`: explicit executable path (`~` expands to HOME; relative paths resolve from the session workspace; invalid overrides fail rather than silently falling back). Otherwise: host-matched package binary → legacy `bin/okf` → PATH.
- `OKF_KNOWLEDGE_DIR`: explicit bundle path, relative to the session working directory if not absolute. Otherwise: `<cwd>/knowledge`, then an existing `/workspace/knowledge` only for `/workspace`-rooted deployments. Missing bundles are created at `<cwd>/knowledge` unless overridden.
- `OKF_SETUP_MODE`: `prompt` (default: offer setup at TUI startup) or `manual` (no startup dialogs, including TUI). Neither value authorizes unattended writes.
- `PI_MEMORY_OWNERSHIP`: `limited` or `full` maintenance authority. Explicit
  workspace/host ownership takes precedence, then this environment setting;
  otherwise ownership defaults to limited everywhere. Hosts opt into full
  explicitly; no deployment detection changes authority.
  This is configuration, not authentication. Full delegates shell-capable recovery
  with the process's existing permissions; use full-process isolation.
- `OKF_ORPHAN_POLICY`: `advisory` (default) or `strict`. Advisory allows independent
  concepts without invented semantic relationships; strict requires no isolated
  concepts (not necessarily one connected graph). Applies to validation and finalization.

## Tools and commands

| Surface | Purpose |
|---|---|
| `memory_search` | Text search (`query`) and code-path discovery (`for_path`), with optional `limit` (1–100) |
| `memory_show` | Full concept body, provenance, lifecycle, governance and code references |
| `memory_validate` | Structured blocking diagnostics plus advisories; optional `orphanPolicy:"strict"` inspection |
| `memory_upgrade` | Inspect status; retrieve/verify approved steps; finalize the required local Git commit |
| `/memory-setup` | Confirm bundle/Git setup; `status` is read-only |
| `/memory-context` | Queue the root index for the next turn |
| `/memory-diagnostics` | Read-only loaded package, binary candidates and resource settings provenance |
| `/knowledge-review` | Review this session for durable rationale; most reviews need no writes |
| `/memory-upgrade` | Confirm and start/resume an ordered upgrade review |

Session startup/resume/fork queues the index or an empty-corpus hint. Concept count comes from the CLI, not root-index formatting. The normal skill teaches search-before-write, governance, provenance, and the why-only write budget.

## Binary diagnostics

`/memory-diagnostics` never runs a model or the selected executable. It shows the
loaded extension file/package directory, workspace, OS/architecture, OKF_BIN
selection and candidate files with missing/non-executable/usable status. It also
shows personal and project `settings.json` paths and matching local resource
declarations; CLI `-e` and auto-discovery can load code without such a declaration.
OKF binary selection itself uses environment/package/PATH, not a separate config
file. Missing/unusable binaries report the same diagnostic detail as a structured
`okf-binary` blocker, deduplicated by the loaded package/override resource. An
explicit invalid override never silently falls back to another executable.

## Validation policy

`ok:true` still requires compatible OKF, conformance, a passing gate, and no schema,
governance/provenance, warning/drift, broken-link or stale-data findings. Isolation
alone is **advisory**: general-purpose knowledge can contain unrelated topics.
The wrapper runs strict validation first, then relaxes only a proven orphan-only
failure after confirming upstream non-strict validation passes. It never fabricates
`gate_passed`, drops other diagnostics, invents relationships, or changes the binary.
Raw `validation`, `strictValidation`, selected `orphanPolicy` and `advisories` remain
inspectable. Strict inspection does not change the configured commit policy.

This wrapper policy update needs no corpus conversion or rewritten upgrade timestamps.
Existing upgrade verifiers use the current policy; saved maintenance extraction plans
are retained and revalidated before Git finalization. Actual validation blockers remain
pending. Index discoverability remains separate from semantic relationships.

## After an update

A bundle with pending work shows a startup notice and persistent status:

> pi-okf-agent-memory 0.5.0: 1 bundle upgrade step pending. Run /memory-upgrade to review it in order.

**Startup inspection is read-only:** setup writes require user confirmation or a bound host setup request. No migration, ledger creation, or agent turn follows setup alone. Upgrade checks run on reload too; a short model-facing warning persists while work is pending. Missing Git setup is reported before upgrade review, not discovered only at its final commit.

`/memory-upgrade` shows the ordered plan and asks for confirmation. The command authorizes review and the **required final local Git commit of the agent-owned knowledge bundle**—not arbitrary corpus edits or a push. The runner supplies the package's exact skill/step text directly, independently of skill discovery. Repairs still need an approved plan and rollback checkpoint.

- Skipping package releases does not skip required steps. Completion advances only one step at a time after its deterministic checks pass. Completing several steps in the same tool batch is rejected: the next instructions must reach a subsequent model turn first.
- Step progress lives in `<bundle>/.pi-okf-memory/state.json`, not a session or global acknowledgment. The runner commits that ledger, its ignore file, and all tracked/non-ignored bundle changes (including pre-existing agent-owned knowledge edits). Shared/symlinked paths resolve to the same state.
- **Complete means validated and committed.** The last step re-verifies and performs the local commit, then returns its hash. Existing Git identity, signing, and hooks are honored. Unrelated files and staged changes outside an embedded bundle are excluded; locks and temporary files are never included. No push is made.
- A missing ledger means **unassessed**, including fresh bundles. The first step inspects compatibility; it does not manufacture concepts or convert the corpus format.
- The first step checks stable OKF **>=0.4.3 <0.5.0** and the zero-blocking-findings validation contract. New code bindings, governance edits, AAG and Hub sync are optional—not required migrations.
- Reading instructions is not completion; the agent cannot advance by merely asserting success. Structural checks cannot prove semantic correctness or that the model understood the prose—policy decisions still require human review.

### Status and interruption

```text
/memory-upgrade status   # read-only plan/progress; no model turn
/memory-upgrade cancel   # release this session's review; keep completed steps
/memory-upgrade unlock   # confirm recovery of a stopped local process's lock
```

Re-run `/memory-upgrade` after restart/reload to resume the first unfinished step. Within an approved session, `memory_upgrade(action="next")` recovers instructions after compaction.

If all step checks passed but Git finalization failed, the notice remains **final commit pending**. Fix the reported repository/identity/signing/hook/validation issue, then use `/memory-upgrade` or `memory_upgrade(action="finalize")` in the approved session. Retrying re-verifies without rewriting step timestamps or replaying the review. Repository creation requires separate setup approval; author identity is never fabricated. Failed attempts may leave bundle files staged; unrelated staging is preserved.

Old uncommitted ledgers are detected on reload and require just this finalization, not a repeated review. Git HEAD must contain the ledger and ignore file; the hash is not written back into the ledger, avoiding an endless second-commit requirement. Normal later corpus edits do not reopen an already committed upgrade. An ignored local `finalize-pending` marker retains interrupted or failed finalization, including changes made by hooks.

The lock covers review and finalization. Shutdown/session switching releases it; a crash may leave a lock requiring explicit recovery. Live local owners and foreign-host locks are not automatically displaced. The lock is advisory: other agents, shells, or humans can still edit files, and user Git hooks still execute. Cancel does not undo edits, staging, or commits. No automatic push, rollback, or package download occurs.

The runner rejects corrupt/out-of-order/newer state rather than overwriting it. Do not delete the ledger to bypass an upgrade or downgrade; inspect it with a compatible package. If a confirmed dead remote owner left a lock, coordinate with that owner before removing only the lock manually.

Normal read tools remain available during this compatible review; unsupported path-search calls fail explicitly and unsupported validators cannot report `ok:true`. This is not a filesystem sandbox or a global coding lock.

In print/JSON mode, pending status is supplied to the model and available through `memory_upgrade(action="status")`. The interactive command still requires confirmation; a trusted host can instead request an unattended review through the managed interface below. RPC receives supported notifications/dialogs, not TUI widgets.

## Autonomous hosts

A host adapter can use the versioned `pi.events` protocol to inspect and run upgrades without typing a slash command or answering a dialog. **No persona configuration or step allowlist is needed:** a host `run` request approves every pending step of the installed package and the required final local commit.

- First inspect `okf:setup:ready` / setup `status`. If needed, authorize a bound setup `run` to create the bundle/Git worktree without a model turn. See [setup protocol](docs/setup.md).
- Once setup is ready, wait for `okf:upgrade:ready`, query fresh upgrade `status`, then send a separate `run` bound to that session, canonical bundle, and package version. The two protocols have independent session bindings.
- The extension waits for idle/no queued messages/no unresolved tools. Hosts can hold the slot for other maintenance and observe its active state to defer hygiene.
- The agent gets the same ordered guides, with host consent for necessary scoped repairs. Unknown policy/factual decisions become an explicit `block`, not an unattended console question.
- Completion is reported structurally **after the agent settles**, with the verified commit hash. Failures stay pending; there is no autonomous retry loop or process kill.
- Version-only updates re-verify and commit an adoption receipt without repeating old guides. Already-current requests are no-ops. The host owns deploying the newest package and restarting/reloading pi; this package never downloads updates itself.

See **[Managed upgrade protocol](docs/managed-upgrades.md)** for request/response types, lifecycle, maintenance coordination, deadlines, and host-attested crash recovery. **[Example automatic host](examples/managed-host.ts)** shows setup followed by startup/version-change upgrade triggering and is not auto-loaded by the package. This is an in-process cooperative integration, not a new security boundary or authoritative infrastructure audit.

## Optional idle session maintenance

Install `pi-session-maintenance` separately to schedule autonomous all-branch
session reviews and installed-package upgrades. The coordinator discovers this
package's `okf:maintenance:v1` adapter; normal OKF startup still starts no work.
Review calls use the existing model registry, not authenticated pi subprocesses.
Warranted concept addenda are applied through the CLI, validated, and **committed
automatically**. Configured upstream pushes are separate retryable operations.
Default (`limited`) validation failures trigger **automatic structural repair** under the same bundle
lock: index listings/descriptions are restored from concept metadata, and a
bounded tool-free model can retarget broken Markdown links to evidenced existing
concepts. Repair checkpoints survive interruption and failed commits; extraction
plans are retained rather than paid for again. Repairs never change facts,
frontmatter, governance, review dates or orphan policy. Findings requiring missing
factual evidence or external Git/auth setup remain explicit blockers. No normal
repair approval or foreground delegation is required.

**Full ownership** (`memoryOwnership:"full"` in `.pi/maintenance.json`/host settings,
or `PI_MEMORY_OWNERSHIP=full`) also investigates schema,
provenance, governance and stale-fact problems with read/edit/write/shell tools.
It qualifies or archives unsupported claims instead of asking a human, provisions
missing bundles/Git, restores owner-only file access, and repairs scoped Git failures.
Cases/checkpoints survive cancellation; budget/turn limits cause automatic continuation,
not approval requests. Tool-based source reviews can handle failed extraction or
oversized corpora, with source-hash binding and actual validation/commit checks.
Corpus-content fingerprints and daily health checks catch failures even with fresh
session coverage. Optional `memoryGitIdentity:{name,email}` is an explicit authorized
repository-local identity; it is not invented by the agent. Incompatible runtimes,
missing credentials/mounts or unrelated project Git operations remain structured
host prerequisites. Full startup offers no setup dialog; `/memory-setup` uses standing
authority and `/memory-upgrade` delegates to the maintenance coordinator.

Full shell scope is cooperative, not a filesystem sandbox, and does not inherit
foreground tool overrides/approval extensions. It has the process's practical
filesystem/network/credential access. These private worker logs are not
infrastructure-authenticated audit. Hosts must deploy/load both updated packages,
explicitly configure their ownership/compaction defaults, and coordinate any old
independent hygiene loop. Installing this checkout does not update host deployments.
Limited mode diagnoses missing bundles; full mode provisions them. Unavailable
credentials/author identity are diagnosed, never fabricated. Updated coordinators
can capture parsed prompt/stream/final-response events and plan/validation/commit
references through optional `onModelEvent`/`onEvent` callbacks. No HTTP credentials
or new agent sessions are exposed; the coordinator owns private transcripts and UI.
Model calls default to a ten-minute deadline; maintenance's `modelTimeoutSeconds`
setting can override it (up to one hour). Traces record elapsed/deadline details and
the originating cancellation reason, while preserving the native provider message. See
[Unattended maintenance protocol](docs/maintenance.md) for authority, checkpoints,
limits, cancellation, bundle locking and the no-human-approval normal path.

## Local copy installation

```bash
./install.sh /path/to/project [knowledge-dir]
```

Copies the extension to `.pi/extensions/okf-memory/` and both skills to `.pi/skills/`. It replaces the recognized legacy `okf-memory.ts` entry point to avoid duplicate registrations. Explicit installation overwrites package-owned extension/skill files; keep custom instructions elsewhere. All bundles are left unchanged by installation. `/reload` offers the shared setup flow (or use `/memory-setup` / host setup); `/memory-upgrade` separately establishes the committed baseline. The installer no longer has a separate shell bootstrap that creates identity/commits.

## Development

```bash
npm test
npm run test:rpc
node scripts/update-okf.mjs v0.4.3 --static-linux
```

Tests locate pi locally or via `npm root --global`; set `PI_TEST_PACKAGE_DIR` to an installed pi package directory to override. They use pi's jiti loader, temporary bundles, mocked UI/hosts, and real CLI/Git calls. The RPC test also launches real pi with isolated settings/offline mode, declines the interactive dialog, then exercises unattended host finalization and its Git receipt. No model calls. An optional read-only `/workspace/knowledge` check skips when absent.

Vendoring verifies all four release assets against upstream SHA-256 checksums before replacing binaries. `--static-linux` (maintainer Go/Git required) rebuilds Linux amd64 from the release tag with CGO disabled: upstream's v0.4.3 asset otherwise requires glibc. The script rejects dynamically linked Linux artifacts. `bin/UPSTREAM.json` distinguishes release checksums from the source-built artifact and records its commit/toolchain/flags. Checksums are not an independent release signature. Keep `bin/NOTICES.md` current when dependencies change. `bin/okf` remains a legacy copy of Linux amd64. No runtime builds or downloads occur.

- `index.ts`: native tools, session context, commands.
- `lib/setup.ts` / `lib/setup-extension.ts`: deterministic Git-backed setup, interactive consent, and explicit host setup protocol.
- `lib/okf.ts`: executable/bundle resolution and structured CLI validation.
- `lib/upgrades.ts`: ordered registry, durable ledger, advisory lock, verifiers and finalization.
- `lib/git.ts`: read-only commit proof and bundle-scoped commits preserving unrelated staging.
- `lib/upgrade-extension.ts`: shared interactive/host workflow and consent handling.
- `lib/managed-upgrades.ts`: host protocol, idle scheduling, maintenance coordination and outcomes.
- `lib/maintenance.ts` / `lib/maintenance-git.ts`: optional host-driven tool-free
  snapshot reviews/upgrades, automatic bundle commits, and configured upstream pushes.
- `lib/maintenance-repair.ts`: checkpointed automatic index/link repair before
  validation/commit; bounded model proposals, source guards and conflict recovery.
- `lib/autonomous-recovery.ts` / `lib/maintenance-model.ts`: full-ownership tool
  worker, durable cases/checkpoints, native registry streams, accounting and aborts.
- `lib/ownership.ts` / `lib/owned-access.ts` / `lib/maintenance-fingerprint.ts`:
  explicit/provisioned policy, metadata-only owned-access recovery and corpus health.
- `skills/okf-memory-upgrade/`: portable upgrade workflow and historical steps.

Keep step IDs stable and append new steps only for actual upgrade work, not every release. Retain old guides and keep their verifiers compatible with the newest supported binary. Keep verifiers read-only and repeatable: finalization rechecks them before and after the commit. Test fresh/legacy/provisioned setup, broken Git metadata, stale consent, skipped releases, commit failures/retries, unrelated staging, cancellation, concurrent sessions, and missing/corrupt state. Never infer completion from a release number or a notice being dismissed.

CLI integration remains deliberate: local read tools and explicit upgrade control need no MCP server. Upstream's broader workflow and sync features are optional; this package retains its narrower why-only memory policy.
