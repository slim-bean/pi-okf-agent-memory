# AGENTS.md

pi-okf-agent-memory gives pi a local, Git-backed memory of Markdown concepts. Read `README.md` for usage, the session index, upgrades and development commands. Current package version: 0.12.0. There is no external binary; memory is stored, searched and validated in TypeScript.

## Layout

- `index.ts`: tools (`memory_search/show/write/move/validate`), commands, session index injection, usage hooks. `createMemoryExtension({steps})` lets hosts/tests supply an upgrade registry.
- `lib/store.ts`: concept files. Frontmatter is parsed as ordered raw fields so unknown or structured values survive a rewrite. Owns IDs, links, moves and read-only structural validation. No dependency on navigation.
- `lib/view.ts`: generated `index.md` (standing rules + budgeted Active set) and `catalog.md`. Both are pure functions of concept metadata and the Active set, and the Active set is whatever the committed `index.md` lists. Selection uses the usage ledger.
- `lib/usage.ts`: append-only local ledger `.pi-okf-memory/usage.jsonl`, compaction, one-time seeding from pi session logs.
- `lib/search.ts`: section-level BM25 with weighted title/description/tags/ID and light stemming.
- `lib/memory.ts`: operations shared by tools and maintenance (`writeConcept`, `moveConcept`, `validateBundle`, `repairAndValidate`, `initBundle`).
- `lib/diagnostics.ts`: read-only `/memory-diagnostics`. Show paths and settings declarations, never credentials.
- `lib/setup.ts` / `lib/setup-extension.ts`: Git-backed setup, startup confirmation and `okf:setup:*` host protocol (`docs/setup.md`).
- `lib/upgrades.ts`: append-only step registry, bundle ledger, lock, finalization. A step without `instructions` is automatic: `apply` (idempotent migration) then `verify`. `002-native-store` converts OKF-CLI-era bundles.
- `lib/upgrade-extension.ts` / `lib/managed-upgrades.ts`: interactive and host workflows (`docs/managed-upgrades.md`). Automatic steps run inside `begin()` with no model turn.
- `lib/git.ts` / `lib/git-status-async.ts` / `lib/maintenance-git.ts`: commit proof and bundle-scoped commits/pushes; preserve staging outside the bundle.
- `lib/maintenance.ts`: `okf:maintenance:v1` adapter (`docs/maintenance.md`). `maintenance-context.ts` sizes existing memory for the reviewer; `maintenance-repair.ts` regenerates navigation and bounds link repair; `maintenance-consolidate.ts` rewrites stacked addenda (full ownership); `maintenance-model.ts` admits and runs one provider call.
- `lib/autonomous-recovery.ts`: full-ownership tool worker, durable cases/checkpoints.
- `lib/ownership.ts` / `lib/owned-access.ts` / `lib/maintenance-fingerprint.ts`: ownership policy, owner-only access restoration, corpus health keys.
- `skills/okf-memory/`: why-only policy and tool workflow; it is also the unattended reviewer's prompt. `skills/okf-memory-upgrade/`: skill and guide for model-reviewed steps.
- `test/`: jiti + real Git fixtures with mock pi API/hosts (`npm test`); `npm run test:rpc` runs real pi offline. `test/support.mjs` builds fixtures through the native store and provides a model-reviewed test step. Never launch an authenticated pi or call a model in tests.

## Invariants

- Reads never create commits. The usage ledger is local and Git-ignored, and is only written once the bundle's `.pi-okf-memory/.gitignore` lists it (otherwise a read would dirty a tracked file and reopen a finished upgrade).
- `index.md` and `catalog.md` are generated. Anything allowed to write regenerates them before validating; never make stale navigation a reason to call a model or block a host. Read-only checks (upgrade verifiers, status) report it instead.
- Demotion changes a line in `index.md`, never a file's path or contents. Promotion on use is immediate; idle demotion runs only with `rebalance` (maintenance, upgrade, `/memory-demote idle`). Standing rules (`convention/`, `pinned: true`) are exempt from usage.
- Blocking validation is structural only: readable frontmatter with title and description, valid file-name IDs, resolvable local links, no symlinks. Do not add graph, trust or scorecard gates. Expired `stale_after` is advisory.
- Review requests are sized to the model, not the corpus: catalog of everything plus the most related text. Do not reintroduce whole-corpus prompts. Journals are keyed by source, not package version or model, and committed journals from older releases must keep counting.
- Body replacement by unattended maintenance is full-ownership only, one concept per opportunity, never for human-verified concepts, and only when the rewrite is shorter and keeps links. Limited ownership creates or appends.
- Startup/status inspection never mutates or starts an agent turn. Never prompt unsolicited in RPC/headless; `OKF_SETUP_MODE=manual` also suppresses TUI prompts. Setup and upgrade consent are separate.
- Final upgrade success requires validation and a verified Git commit. Step IDs/order are immutable; steps are idempotent; verifiers are read-only and run again before and after finalization. Unknown/corrupt ledger state fails closed. Ledgers written by older packages (`okfVersion: "v0.x"`) stay readable.
- Maintenance emits structured deferred/blocked/error issues keyed by canonical resource. Never guess authors, forge verification, force push or bypass hooks/signing. Keep private work outside the bundle.
- Advisory locks are not a sandbox; full-ownership shell scope is cooperative.
- Compatibility names stay: package name, `OKF_KNOWLEDGE_DIR`, `OKF_SETUP_MODE`, `okf:*` channels, `.pi-okf-memory/`, skill directory names. Renaming is a separate, coordinated release.
- pi-bundled imports belong in optional `peerDependencies` with `"*"`. Keep `pi-package` in keywords.
- Publish a matching `vX.Y.Z` Git tag for each release; do not tag merely to test a working-tree change.
- Keep docs concise. Persistent project memory records *why*; Git already records *what*.
