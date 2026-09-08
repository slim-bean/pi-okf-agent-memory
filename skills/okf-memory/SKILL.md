---
name: okf-memory
description: Persistent project memory in the OKF v0.2 knowledge corpus at knowledge/. Use when starting substantial work (search for prior decisions/lessons), after making a decision or non-obvious discovery (persist the why), when asked to run a knowledge review, or when anything about the project's durable state is unclear.
---

# OKF Project Memory

The project keeps persistent memory in an OKF v0.2 bundle at `knowledge/` (Markdown + YAML frontmatter, git-tracked). The `okf` CLI and the `memory_search` / `memory_show` / `memory_validate` tools (from the okf-memory pi extension) operate on it.

## The one rule that matters most

**This corpus records WHY — not what, not how, not when.**

- Git records *what* changed. Runbooks record *how* to operate. Workflow/deploy logs record *what was done*.
- `knowledge/` records only: decisions and their rationale, constraints, incident lessons, non-obvious discoveries, corrections to stored facts.
- If the fact is already durably recorded elsewhere, or a future agent could re-derive it in about two minutes, **do not store it**.
- Most knowledge reviews end with "nothing worth storing". That is a correct outcome, not underuse. Never manufacture entries to feel productive.

## Read before write (every substantial task)

1. `memory_search` with task-relevant terms. Hit? → `memory_show <concept-id>` and use it.
2. Do the task.
3. Review: did a decision get made, an assumption break, a lesson emerge? If yes → step 4. If no → stop.
4. Search again for the topic. Update the existing concept rather than creating a duplicate.
5. Validate: `memory_validate`. Never claim persistence unless it passed.

## Writing (use the CLI, not hand-editing)

```bash
okf create <dir/topic> knowledge --type Decision --title "..." --desc "One line for the index"
okf update <dir/topic> knowledge --desc "Updated one-liner"   # then edit the body prose
okf relate <src> <tgt> knowledge                               # cross-link related concepts
okf validate knowledge --strict --drift --stale
```

After `create`/`update`, fill in the body: rationale, alternatives considered, consequences. Cite sources with footnotes (`[^id]` matching a `sources:` id). Keep the root `knowledge/index.md` listing (one line per concept, description matching the frontmatter `description`) — `--drift` enforces this.

## Trust and lifecycle (SRE-relevant)

- `generated: { by: agent/<name>, at: ... }` is written by the CLI. Leave `verified` empty unless a human or a process genuinely verified the content. Agent-written runbooks are hypotheses until exercised.
- Mark time-bound operational facts (`Observation` type) with `stale_after: YYYY-MM-DD` so they expire on paper.
- On conflict, update the current state and preserve the old meaning in prose; never silently overwrite.

## Never store

Conversation, chain-of-thought, transient alert/pod state without `stale_after`, duplicate concepts, speculative claims without qualification, trivial steps.

## Commands

- `/memory-context` — inject the corpus index now.
- `/knowledge-review` — guided post-task review + validation.
