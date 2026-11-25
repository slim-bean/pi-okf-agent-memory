---
name: okf-memory
description: Persistent project memory stored as Markdown concepts in a Git-backed knowledge bundle. Use before substantial work, after durable decisions/discoveries, for knowledge reviews, and when prior constraints or lessons are unclear.
---

# Project Memory

## Write only the WHY

Git records what changed, runbooks how to operate, and workflow logs what was done. Memory records durable rationale, constraints, incident lessons, non-obvious discoveries, and corrections. If already recorded elsewhere or re-derivable in about two minutes, do not store it. Most reviews correctly end with no writes.

## What you see and what you do not

Each session starts with `index.md`: **standing rules** (every `convention/` concept and anything pinned) plus an **Active** set of recently used concepts, held to a small size budget. Everything else is in the bundle but not in your context. `catalog.md` lists every concept ID; it is for people and is not loaded.

So an absent topic in the index means "not recently used", not "unknown". Search before concluding memory has nothing.

## Read before write

1. `memory_search(query="task keywords")` at task start. Results name the best-matching section; partial matches rank lower rather than disappearing.
2. `memory_show(concept="id")` for relevant hits; pass `section` to read one heading of a long concept.
3. After the task, search again before any warranted write. Update rather than duplicate.

Reading a concept counts as use and keeps it in the index. Concepts nobody uses for a while leave the index automatically but stay searchable; that is intended, not data loss.

## Writing

Use `memory_write`; there is no memory CLI and the index, catalog and log are maintained for you.

- **New concept:** `concept` (ID such as `decisions/storage-choice`), `title`, `description` (one or two sentences: this is what the index and search results show), optional `type` (Decision, Constraint, Lesson, Fact, ...) and `body`.
- **Add to an existing concept:** `append` with a dated section. Prefer this for new evidence or a correction that qualifies earlier text.
- **Rewrite an existing concept:** `body` replaces the whole body. Read it first and preserve prior meaning and sources; Git history keeps the old wording.
- **Standing rules:** put rules that must apply in every session under `convention/`. `pinned: true` does the same for a single concept. Both cost context in every session, so use them sparingly.
- **Retire:** `status: "deprecated"` removes a concept from the index; `memory_move` renames or archives one and rewrites links to it.

Then run `memory_validate`. Claim successful persistence only when `ok` is true: every concept has readable frontmatter with a title and description, and every relative Markdown link resolves. Do not invent links to make concepts look connected; independent topics are fine.

Do not hand-edit `index.md` or `catalog.md`: they are regenerated from concept files. Editing a concept file directly is allowed (keep its frontmatter block); run `memory_validate` afterwards to regenerate navigation.

## Trust and lifecycle

- Writes are stamped as generated. Never invent human `verified` records, and do not modify a concept that carries one without being asked.
- Use `stale_after: YYYY-MM-DD` in frontmatter for time-bound observations. Do not advance dates without actually reviewing the facts.
- Preserve prior meaning when correcting a concept. Qualify uncertainty.
- Never store conversation, chain-of-thought, trivial steps, duplicates, or transient operational state without an expiry.

## Setup and upgrades are separate

Use `/memory-setup` (user confirmation) or explicit host setup when the bundle or its Git worktree is missing; do not initialize memory or Git on your own. A startup notice may request `/memory-upgrade`: do not perform migrations or edit its ledger yourself. Autonomous hosts run both programmatically.

- `/memory-setup`: establish the bundle/Git worktree; `status` is read-only.
- `/memory-context`: load the index on demand.
- `/memory-stats`: which concepts are in the index and how much each is used.
- `/memory-demote <id>` / `/memory-pin <id>`: remove a concept from the index now, or keep one in it.
- `/memory-consolidate [id]`: rewrite stacked session addenda into one body, with approval.
- `/knowledge-review`: review this session for durable rationale.
- `/memory-upgrade`: adopt a new package version; `status`, `cancel`, and `unlock` are also available.
