# 001 — OKF 0.4 validation and governance contract

## Applicability and baseline

This is the first tracked upgrade in pi-okf-agent-memory 0.2.0. It applies to both older installations without a ledger and new bundles. Missing state means **unassessed**, not an old format or permission to rewrite anything. An empty, conformant bundle can pass without adding concepts.

The bundled engine is OKF v0.4.3, still using the OKF **v0.2 corpus format**. There is no required format conversion or bulk metadata migration. Currently tested binaries are stable releases >=0.4.3 and <0.5.0. Correct an unsupported `OKF_BIN` with the user's help; do not download or install another binary autonomously.

## Review

1. Call `memory_validate`. Review every finding, including warnings. The extension now requires **zero errors, gate findings, and warnings**; upstream's `--strict` exit status alone is insufficient. Validation failures retain their JSON diagnostics.
2. Inspect any flagged parent-index omissions, description mismatches, broken links, expired facts, and code-reference drift. CLI create/update maintains the immediate parent index, not necessarily root navigation. Check that the root index is still useful; do not infer corpus emptiness from its bullet formatting.
3. Explain the new semantics: `convention/` concepts implicitly have `constraint` authority; other concepts default to `context`. Explicit `hold` means request human signoff before editing governed code. These are agent workflow rules, not an OS-level sandbox. Do not silently relabel existing concepts.
4. Optional adoption is **not** a prerequisite: `memory_search(for_path="src/example.ts")` can discover `code_refs`; no need to add bindings to every concept. The 0.4.3 create/update CLI lacks dedicated governance/code_refs flags, so proposed frontmatter edits must be reviewed, preserve provenance, and be validated afterward.
5. Keep this integration's why-only write budget. Do not run upstream bootstrap over user instructions, enforce AAG, enable Hub sync, or replace this package's skill with upstream's MCP-oriented skill. Those are separate choices.

## Completion and rollback

- If diagnostics require changes, obtain approval for the repair plan and checkpoint first. Do not manufacture links/rationale merely to silence an orphan warning; ask whether the concept belongs and how it relates.
- Re-run `memory_validate` until `ok` is true, or stop and report blockers. No automatic downgrade or rollback is needed when nothing changed.
- When reviewed and clean, call `memory_upgrade(action="complete", step="001-validation-contract")`. The runner independently verifies the binary and zero-findings contract, records the step, and makes the required local Git commit of the agent-owned bundle and upgrade records. Even an empty bundle needs this commit.
- Do not claim the workflow finished until the runner returns the commit hash. If Git setup, identity, signing, hooks, or validation blocks finalization, report it and retry `memory_upgrade(action="finalize")` after resolving it. Recorded steps need not be replayed; there is no automatic push.
- If a repair must be rolled back, restore only its approved changes from the checkpoint; preserve unrelated edits. Do not delete the ledger to fake a downgrade. An older package may not understand newer completion IDs; use a compatible package to inspect them.

The tool can verify structural checks, not whether a policy decision is correct or the agent understood prose. Surface those decisions honestly for human review.
