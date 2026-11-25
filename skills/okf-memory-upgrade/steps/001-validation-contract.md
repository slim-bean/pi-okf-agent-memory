# 001 — Baseline contract (historical)

This step ID is retained so ledgers written by earlier packages stay in order. The
OKF CLI contract it once reviewed no longer exists: memory is stored natively and the
shipped upgrade steps are deterministic migrations that need no model review.

If a host or test configures this guide as a reviewed step, the review is:

1. Call `memory_validate`. Every concept must have readable frontmatter with a title
   and description, and every relative Markdown link must resolve. `index.md` and
   `catalog.md` are generated; never hand-edit them.
2. Repair only what a finding names. Do not invent links, facts, dates or human
   verification to pass validation.
3. When `ok` is true, call
   `memory_upgrade(action="complete", step="001-validation-contract")`. The runner
   verifies independently and makes the required local Git commit. No push is made.
