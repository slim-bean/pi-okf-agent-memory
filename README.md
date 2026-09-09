# pi-okf-agent-memory

[pi coding-agent](https://pi.dev) extension + skill for [OKF Agent Memory](https://github.com/okf-memory/okf-agent-memory) — git-native persistent project memory (Google OKF v0.2) that survives context compaction and session boundaries.

## Install (pi package)

```bash
pi install git:github.com/slim-bean/pi-okf-agent-memory@v0.1.0        # user-level
pi install -l git:github.com/slim-bean/pi-okf-agent-memory@v0.1.0    # project-level (.pi/settings.json)
pi -e git:github.com/slim-bean/pi-okf-agent-memory                   # try without installing
```

The repo ships a prebuilt `okf` binary under `bin/`, so no build step is needed. Refs are pinned; move to a newer release with `pi install git:github.com/slim-bean/pi-okf-agent-memory@<new-tag>`.

Then create a knowledge bundle if the project doesn't have one:

```bash
okf init knowledge   # or let the extension find an existing ./knowledge
```

Configuration (optional env): `OKF_BIN` (path to okf binary; otherwise the build matching the host OS/arch is chosen), `OKF_KNOWLEDGE_DIR` (bundle path). Defaults: `bin/okf` inside the installed package (then `PATH`), and `<cwd>/knowledge` (then `/workspace/knowledge`, only for /workspace-rooted deployments such as shared container workspaces).

## Local (non-package) install

```bash
./install.sh /path/to/project
```

This copies `index.ts` to `<project>/.pi/extensions/` (with `bin/okf` alongside) and the skill to `<project>/.pi/skills/okf-memory/`, then initializes `knowledge/` if absent. pi discovers both after project trust; `/reload` picks them up in a running session.

```
pi-okf-agent-memory/
├── index.ts                  # pi extension (package entry point)
├── bin/okf                   # okf CLI binary (built from okf-agent-memory, zero deps)
├── skills/okf-memory/SKILL.md # agent skill teaching the memory workflow + write budget
├── package.json              # pi package manifest (pi-package keyword, pi.extensions/skills)
├── install.sh                # local .pi/ install for projects/sandboxes
└── test/smoke.mjs            # jiti-based smoke tests (mock ExtensionAPI)
```

## What it gives a pi session

| Surface | Kind | Purpose |
|---|---|---|
| `memory_search` | tool | BM25 search over `knowledge/` (<300µs). Use before writing, and at task start. |
| `memory_show` | tool | Full concept: body, frontmatter (trust, status, stale_after), links. |
| `memory_validate` | tool | Conformance + orphans + index drift + staleness. Persistence claims require a pass. |
| `/memory-context` | command | Inject the corpus `index.md` into context on demand. |
| `/knowledge-review` | command | Guided post-task review (convention §9) + validation. |
| session_start hook | event | On new/resume/fork, queues the corpus index so a fresh or compacted session immediately knows durable state. |
| okf-memory skill | skill | Teaches the **why-only write budget** — the anti-bloat guardrails. |

## Install (project / sandbox, manual)

```bash
./install.sh /path/to/project
```

This copies `index.ts` to `<project>/.pi/extensions/` and the skill to `<project>/.pi/skills/okf-memory/`, then initializes `knowledge/` if absent. pi discovers both after project trust; `/reload` picks them up in a running session.

## Building okf from source

```bash
git clone https://github.com/okf-memory/okf-agent-memory && cd okf-agent-memory && make build
cp bin/okf /path/to/pi-okf-agent-memory/bin/
```

## Design notes

- **CLI over MCP.** pi has no built-in MCP support; the `okf` CLI is local, zero-dependency, sub-5ms — an MCP hop adds nothing.
- **Extension over skill-only.** Skills are advisory; the extension makes read-side tools always available and makes resume-injection + validation deterministic.
- **Why-only corpus.** The skill's first rule: git records *what*, runbooks record *how*, deploy logs record *when* — `knowledge/` records only *why*. See `skills/okf-memory/SKILL.md`.
