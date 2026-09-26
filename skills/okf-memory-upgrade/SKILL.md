---
name: okf-memory-upgrade
description: Review and verify ordered pi-okf-agent-memory upgrades after a package update, skipped releases, or an interrupted review. Start with /memory-upgrade; this skill alone does not authorize migrations.
disable-model-invocation: true
---

# Memory upgrade review

The extension owns upgrade ordering and completion. Use `memory_upgrade(action="status")` to inspect progress. A review starts through `/memory-upgrade` confirmation or an explicit trusted host request. If neither approved a review, ask the user or wait for the host; do not invoke the command on their behalf or treat this skill being loaded as approval.

- Work only on the current step supplied by the runner. Never edit `.pi-okf-memory/state.json` or its lock yourself, and never skip steps.
- Use the exact executable and bundle paths supplied by the runner. Quote paths for the shell. Do not substitute a different `okf` from PATH.
- First inspect and report, including any pre-existing uncommitted bundle work. The command authorizes review, verified step records, and the **required final local commit of the agent-owned knowledge bundle**. It does not authorize arbitrary repairs, policy changes, pushes, sync, or instruction replacement.
- If repairs are needed: propose exact edits and a rollback plan, obtain approval, then take a snapshot or approved Git checkpoint before editing. In a **host-managed review**, the runner's supplied consent already covers necessary upgrade-related repairs inside this bundle: record the plan/checkpoint and proceed without waiting for a console answer. Unestablished facts, new governance authority, or out-of-scope actions must use `memory_upgrade(action="block", reason="...")` and stop upgrade work. Preserve unrelated project work. Never reset or stash it. All tracked and non-ignored bundle changes—including existing agent-owned knowledge edits—belong in the final commit; unrelated files outside the bundle do not.
- Never fabricate verification, remove provenance to silence a check, advance review dates without reviewing facts, or assign governance authority without approval.
- Request `memory_upgrade(action="complete", step="<current-id>")` only after the current requirements are satisfied. The last step automatically re-verifies and commits the bundle and ledger. Success requires a returned commit hash, not just a local completion record or your assertion.
- The completion result supplies the next step, if any. Process it in a subsequent model turn before requesting its completion; do not batch several step completions together. After context loss, use `memory_upgrade(action="next")` to recover current instructions.
- If the commit fails, the workflow is **incomplete** even though step checks remain recorded. Report the Git/validation blocker, resolve it without inventing identity or bypassing hooks/signing, then call `memory_upgrade(action="finalize")`. A missing repository needs correct Git setup, not a fabricated success. Do not push.
- If interrupted: `/memory-upgrade` or a fresh host request resumes the first incomplete step or retries just the final commit under renewed consent. Completed step records are preserved. `/memory-upgrade cancel` releases the review lock but does not undo corpus edits, staging, or commits. A crashed local owner can be recovered through `/memory-upgrade unlock` with confirmation.

In a managed review, report the final result and stop upgrade work so the agent can settle and the host can release the maintenance lease. Never batch future writes alongside completion. Report what was checked, what changed (or that no corpus repair was needed), any unresolved decisions, and the verified final commit hash. Never call the workflow complete while its commit remains pending. Upgrade instructions belong to the package, not the project's knowledge corpus.
