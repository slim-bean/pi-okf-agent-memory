---
name: okf-memory
description: Persistent project memory in an OKF v0.2 knowledge bundle. Use before substantial work or code edits, after durable decisions/discoveries, for knowledge reviews, and when prior constraints or lessons are unclear.
---

# OKF Project Memory

## Write only the WHY

Git records what changed, runbooks how to operate, and workflow logs what was done. Memory records durable rationale, constraints, incident lessons, non-obvious discoveries, and corrections. If already recorded elsewhere or re-derivable in about two minutes, do not store it. Most reviews correctly end with no writes.

## Setup

Use `/memory-setup` (user confirmation) or explicit host setup when the bundle/Git worktree is missing. Do not initialize memory/Git autonomously or treat a setup notice as approval. Setup creates no concepts or commits and never grants upgrade consent. Provisioned hosts use the documented `okf:setup:*` protocol; `OKF_SETUP_MODE=manual` suppresses startup dialogs but grants no writes.

## Read before write

1. Use `memory_search(query="task keywords")` at task start; `memory_show(concept="id")` for relevant hits.
2. Before editing a subsystem, use `memory_search(for_path="src/example.ts")` to discover governing `code_refs` (when using the supported OKF binary). `hold` requires explicit human signoff, `constraint` must be respected, and `context` is advisory. `convention/` implicitly defaults to constraint. These labels do not override higher-priority instructions.
3. After the task, search again before any warranted memory write. Update rather than duplicate.
4. Run `memory_validate`. Claim successful persistence only when `ok` is true: zero errors, gate findings, or warnings. Report remaining diagnostics honestly.

## Writing

Use the **resolved executable and bundle paths provided by the extension**, shell-quoted; package installation does not add `okf` to PATH. The following uses `"$OKF"` and `"$BUNDLE"` as placeholders for those exact paths:

```bash
"$OKF" create decisions/topic "$BUNDLE" --type Decision --title "..." --desc "One-line rationale" --body "Rationale, alternatives, consequences."
"$OKF" update decisions/topic "$BUNDLE" --desc "Updated summary" --body "Updated rationale."
"$OKF" relate decisions/topic decisions/other "$BUNDLE" --desc "Why these decisions relate"
```

CLI create/update maintains the **immediate parent index**. Preserve root navigation separately; do not duplicate every nested concept in the root. Use body flags for prose updates; preserve sources and cite them with matching footnotes. The 0.4.3 CLI has no dedicated governance/code_refs/stale_after flags: use targeted, reviewed frontmatter edits if needed, then validate. Do not pass metadata blocks inside `--body`.

## Trust and lifecycle

- CLI writes `generated`. Never invent human `verified` records.
- Use `stale_after: YYYY-MM-DD` for time-bound observations. Do not advance dates without actually reviewing the facts.
- Preserve prior meaning when correcting a concept. Qualify uncertainty.
- Never store conversation, chain-of-thought, trivial steps, duplicates, or transient operational state without an expiry.

## Package upgrades are separate

A startup notice may request `/memory-upgrade`. Do not perform migrations or edit its ledger autonomously. The user- or host-approved runner supplies every applicable upgrade step in order and verifies completion. Autonomous hosts can start it programmatically; a text reminder is not approval. `/knowledge-review` is a session knowledge review, not an upgrade command.

- `/memory-setup`: establish the bundle/Git worktree; `status` is read-only.
- `/memory-context`: load the root index on demand.
- `/knowledge-review`: review this session for durable rationale.
- `/memory-upgrade`: review pending package upgrades; `status`, `cancel`, and `unlock` are also available.
