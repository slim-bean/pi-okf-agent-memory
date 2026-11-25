# pi-okf-agent-memory

[pi](https://pi.dev) extension and skills for local, Git-native project memory that retains **why** decisions were made without turning session history into a knowledge dump.

Memory is a directory of Markdown concept files with frontmatter, kept in Git. Package **0.12.1** stores, searches and validates it natively: there is **no external binary**, no database and no build step. Earlier releases wrapped the OKF Agent Memory CLI; the on-disk concept format is unchanged, so existing bundles keep working.

## Upgrading from 0.11 or earlier

Existing bundles adopt 0.12 through one deterministic upgrade step (`002-native-store`). It needs **no model call**, so corpus size and model context do not matter:

- per-directory `index.md` files are replaced by one generated `index.md` plus `catalog.md`; links to the removed files are retargeted;
- a local usage ledger is seeded from this workspace's pi session logs when they exist;
- the result is validated and committed with the ledger, like every upgrade.

Interactive sessions show the usual notice and run it with `/memory-upgrade` (one confirmation, no agent turn). Hosts using `pi-session-maintenance` or the managed upgrade protocol run it unattended. Skipped releases are fine: steps still apply in order.

Removed: the bundled `okf` binaries, `OKF_BIN`, `OKF_ORPHAN_POLICY`, `memory_search(for_path=…)`/`code_refs`, `hold` governance and scorecards. Agents now write with `memory_write` instead of a CLI. Concepts need not link to each other; isolation is never a finding. Hosts that called `okf init` can instead create `<bundle>/index.md` with any content (the upgrade regenerates it) or use the setup protocol.

## Install

```bash
pi install .                       # this checkout
pi install git:github.com/slim-bean/pi-okf-agent-memory@v0.12.1
pi install -l git:github.com/slim-bean/pi-okf-agent-memory@v0.12.1  # project-local
```

Pinned refs do not move automatically; select a new tag, then restart pi or `/reload`. Git is required.

On the first TUI session, accept the setup prompt (or run `/memory-setup`) to create an empty bundle and initialize Git inside it if no enclosing worktree exists. Setup never invents identity, commits or pushes. RPC/headless startup never opens unsolicited dialogs; see **[Setup and unattended provisioning](docs/setup.md)**.

Environment:

- `OKF_KNOWLEDGE_DIR`: bundle path, relative to the session working directory if not absolute. Default `<cwd>/knowledge` (and `/workspace/knowledge` for `/workspace`-rooted deployments).
- `OKF_SETUP_MODE`: `prompt` (default) or `manual` (no startup dialogs). Neither authorizes unattended writes.
- `PI_MEMORY_OWNERSHIP`: `limited` (default) or `full` maintenance authority; a workspace `.pi/maintenance.json` `memoryOwnership` wins. Configuration, not authentication.
- `OKF_INDEX_BUDGET` / `OKF_DEMOTE_IDLE_SESSIONS`: override the index settings below.

## Tools and commands

| Surface | Purpose |
|---|---|
| `memory_search` | Ranked search; returns the best-matching section and a snippet per concept |
| `memory_show` | Read a concept, or one `section` of a long one |
| `memory_write` | Create a concept, `append` a section, or replace its `body`; maintains index, catalog and log |
| `memory_move` | Rename/archive a concept; rewrites links and keeps its usage history |
| `memory_validate` | Regenerate navigation, then report blocking findings and advisories |
| `memory_upgrade` | Inspect upgrade status; drive a model-reviewed step when one exists |
| `/memory-setup` | Confirm bundle/Git setup; `status` is read-only |
| `/memory-context` | Queue the index for the next turn |
| `/memory-stats` | Tier and usage of every concept |
| `/memory-demote <id>\|idle` | Remove a concept from the index now, or apply idle demotion |
| `/memory-pin <id> [off]` | Always show a concept in the index |
| `/memory-consolidate [id]` | Ask the agent to merge stacked session addenda, with your approval |
| `/knowledge-review` | Review this session for durable rationale; most reviews need no writes |
| `/memory-upgrade` | Adopt a new package version; `status`, `cancel`, `unlock` |
| `/memory-diagnostics` | Loaded package, resolved bundle, ownership and settings paths (read-only) |

## The session index

Every session start injects `index.md`. It is generated and deliberately small:

- **Standing rules**: every `convention/` concept and any concept with `pinned: true`. Always shown.
- **Active**: recently used concepts, most recent first, cut off at a character budget (default 2,000).
- A one-line count of everything else. Those concepts are not in context; they are found by search.

`catalog.md` lists every concept with its tier. It is committed for review in Git and never injected.

A concept is *used* when it is opened (`memory_show` or a direct file read), written, or returned in the top three results of a search. Use is recorded in `.pi-okf-memory/usage.jsonl`, which is local and Git-ignored, so reading never creates commits.

- **Promotion is immediate**: opening or writing a concept puts it in Active, dropping the least recently used entry if the budget is full.
- **Demotion happens at maintenance time**: a concept unused for 20 sessions leaves Active. Run `/memory-demote idle` to apply it by hand, or `/memory-demote <id>` to remove one now; a manual demotion holds until the concept is next opened or written.
- Demotion never deletes or moves a file.

The Active set is whatever the committed `index.md` lists, so all machines sharing a bundle agree on it; only the usage that drives changes is per machine. Settings live in `.pi-okf-memory/config.json` (`{"indexBudget": 2000, "demoteIdleSessions": 20}`) or the environment variables above.

## Search

Search is BM25 over concept *sections*, with title, description, tags and ID weighted above body text and light stemming (plurals and common verb endings). Queries rank by how much of the query a section covers, so a partial match returns lower in the list instead of returning nothing. The index is rebuilt in memory per query; there is no cache to invalidate. It is keyword search, not semantic search.

## Validation

`memory_validate` returns `ok: true` when:

- every concept file has a readable frontmatter block with `title` and `description`, and a valid ID as its file name;
- every relative Markdown link in a concept resolves inside the bundle;
- no concept is a symlink;
- `index.md` and `catalog.md` match what the concepts generate (the tool regenerates them first, so this only fails for read-only checks).

While a bundle still has the pre-0.12 layout (its upgrade is pending), `memory_validate` and reads change nothing: concept files are checked and a `navigation-pending` advisory explains that the upgrade will generate navigation. A bundle with no usable history starts with its most recently written concepts in Active.

An expired `stale_after` date is an advisory, not a blocker. Structural checks cannot prove that a concept is true.

## Upgrades

A bundle with pending work shows a startup notice and status line; startup inspection is read-only. `/memory-upgrade` shows the plan and asks for confirmation of the steps and the **required final local Git commit of the bundle**. No push is made.

- Progress lives in `<bundle>/.pi-okf-memory/state.json`, per bundle rather than per session. Skipping releases does not skip steps.
- **Complete means validated and committed.** Existing Git identity, signing and hooks are honored; unrelated files and staging outside an embedded bundle are untouched. If the commit fails, the notice stays *final commit pending* and `/memory-upgrade` retries just that.
- Shipped steps are deterministic. The runner still supports model-reviewed steps (ordered guides, one completion per model turn) for any future step that needs judgement.
- An advisory lock covers the upgrade. `/memory-upgrade cancel` releases this session's review; `/memory-upgrade unlock` recovers the lock of a stopped local process. Corrupt, out-of-order or newer ledgers are refused, never overwritten.

```text
/memory-upgrade status   # read-only plan/progress; no model turn
```

## Autonomous hosts

A host adapter can run setup and upgrades over the versioned `pi.events` protocols without a slash command or dialog: inspect `okf:setup:ready`/status, authorize a bound setup `run`, then wait for `okf:upgrade:ready` and send a `run` bound to the session, bundle and package version. Completion is reported with the verified commit hash. See **[Managed upgrade protocol](docs/managed-upgrades.md)** and the **[example host](examples/managed-host.ts)** (not auto-loaded). This is cooperative in-process integration, not a security boundary.

## Idle session maintenance

Install `pi-session-maintenance` to schedule background work through this package's `okf:maintenance:v1` adapter. Normal startup still starts nothing.

- **Upgrade**: runs pending steps and commits, with no model call.
- **Review**: reads all branches of a finished session and proposes warranted concept additions, one section per opportunity. The reviewer receives the catalog of every concept plus the text most related to the section, sized to the model's context, not the whole corpus. Changes are applied, validated and committed automatically. Review journals are keyed by source session, so a new package release does not pay for extraction again.
- **Rebalance**: each opportunity applies idle demotion to the index and commits the result.
- **Repair**: navigation is regenerated without a model; a broken link may get one bounded, tool-free model proposal that can only retarget it to an existing concept.
- **Push**: separate, opt-in, non-force, existing upstream only.

**Limited ownership** (default) only creates concepts or appends attributed addenda, and never edits a concept marked human-verified.

**Full ownership** (`memoryOwnership: "full"` or `PI_MEMORY_OWNERSHIP=full`) additionally:

- **consolidates** a concept that has accumulated four or more session-evidence sections into one coherent body, one concept per opportunity. A rewrite is accepted only if it is shorter, keeps the concept's links and has no leftover per-session headings; Git history holds the earlier wording;
- runs a shell-capable recovery worker for failures validation cannot fix (for example an unreadable concept file), provisions missing bundles/Git, and applies an explicitly supplied `memoryGitIdentity`.

Full shell scope is cooperative, not a sandbox: it has the process's practical filesystem, network and credential access. Use full-process isolation for unattended deployments. See **[Unattended maintenance protocol](docs/maintenance.md)** for authority, checkpoints, limits and cancellation.

## Local copy installation

```bash
./install.sh /path/to/project [knowledge-dir]
```

Copies the extension to `.pi/extensions/okf-memory/` and both skills to `.pi/skills/`, replacing package-owned files and removing binaries left by earlier releases. Bundles are left unchanged; `/reload` offers the shared setup flow.

## Development

```bash
npm test
npm run test:rpc
```

Tests locate pi locally or via `npm root --global`; set `PI_TEST_PACKAGE_DIR` to an installed pi package directory to override. They use pi's jiti loader, temporary bundles, mocked UI/hosts and real Git. `test:rpc` launches real pi offline and runs unattended setup and upgrade. No model calls.

- `index.ts`: tools, commands, session index injection, usage hooks.
- `lib/store.ts`: concept files, frontmatter, links, structural validation, moves.
- `lib/view.ts`: generated `index.md`/`catalog.md` and Active-set selection.
- `lib/usage.ts`: local usage ledger and its one-time seeding from session logs.
- `lib/search.ts`: section-level BM25.
- `lib/memory.ts`: the operations tools and maintenance share (write, move, validate, init).
- `lib/setup.ts` / `lib/setup-extension.ts`: Git-backed setup, consent and host setup protocol.
- `lib/upgrades.ts` / `lib/upgrade-extension.ts` / `lib/managed-upgrades.ts`: ordered step registry, ledger, lock, finalization, interactive and host workflows.
- `lib/git.ts` / `lib/maintenance-git.ts`: commit proof and bundle-scoped commits/pushes.
- `lib/maintenance.ts` and `lib/maintenance-*.ts`: the unattended adapter: review context, repair, consolidation, model calls.
- `lib/autonomous-recovery.ts`: full-ownership tool worker with durable cases.
- `skills/okf-memory/`: the why-only policy and tool workflow. `skills/okf-memory-upgrade/`: review skill for model-reviewed steps.

Keep step IDs stable and append new steps only for real migrations. Steps must be idempotent; verifiers are read-only and run again before and after the final commit. The package name, `OKF_*` variables, `okf:*` channels and `.pi-okf-memory/` keep their names for compatibility with installed hosts.
