# Unattended session maintenance — protocol v1

An installed `pi-session-maintenance` coordinator can invoke this adapter without
launching another pi process, opening auth.json, or injecting review chatter into
the source conversation. Normal package startup remains read-only. A trusted
host request is explicit consent for the requested bundle work, automatic local
commits, and (only when requested) a non-force push to the existing upstream.

Discovery: `pi-session-maintenance:capabilities:v1` fills
`request.capabilities.memory = {protocol:1, channel:"okf:maintenance:v1"}`.

Requests on `okf:maintenance:v1` assign `request.result` synchronously:

```ts
{
  protocol: 1,
  operation: "status" | "upgrade" | "review" | "push",
  context,                 // current pi ExtensionContext, including existing model registry
  cwd,                     // source workspace; never infer it from the current conversation
  workDir,                 // absolute private host-owned checkpoint directory OUTSIDE bundle
  memoryOwnership?,        // limited | full; host override is standing authority
  memoryGitIdentity?,      // explicit authorized {name,email}, applied only in full mode
  recoveryMaxTurns?,       // full recovery model calls per opportunity, default 50; integer 1–100
  maxCost?,                // approximate per-opportunity recovery budget, default 0.5
  modelTranscripts?,       // false omits durable provider context in recovery cases
  model?,                  // provider/model-id; defaults to context.model
  modelTimeoutMs?,          // per-call deadline, default 600000; range 1–3600000
  source?,                 // {path,cwd,hash,entries}; all-branch user/assistant text
  signal?, assertSource?,  // review requires a callback that verifies current source/ownership
  onUsage?, onProgress?,
  onModelEvent?,           // optional parsed prompt/delta/final-response observer
  onEvent?,                // optional plan/validation/commit/push events
  result?: Promise<unknown>
}
```

Results contain `available`, a policy/package/model `key`, `complete`, and optional
`detail`. The key no longer contains the package version, so a release that keeps
review policy does not re-admit every session. Status also reports canonical `bundle`,
`upgraded`, `repairPolicy:1` (automatic structural repair authority), `ownershipProtocol:1`,
selected `ownership`, and a constant `orphanPolicy:"advisory"` kept for older coordinators. Full missing-bundle status is read-only `available:true`,
`setupRequired:true`, `upgraded:false`; the next authorized upgrade provisions it. Updated coordinators
re-admit old validation-blocked plans when this capability appears, preserving
counters/checkpoints rather than waiting out obsolete static-blocker backoff.
Completed review details retain validation advisories. Structured exceptions carry
`maintenanceIssue:1`, `kind:"deferred"|"blocked"|"error"`, stable `code`, canonical
`resource`, message and optional detail. Busy/locked bundles are waiting; validation
is a shared bundle blocker, not one execution failure per affected session. Git
issues use stable resource-scoped codes (`git-identity`, `git-upstream`, `git-auth`,
`git-conflict`, `git-signing`, `git-push-rejected`, `git-push`, `git-finalization`)
so the coordinator can explain the actual prerequisite and next action instead
of recommending an ineffective blind retry. Structural corpus repair is automatic;
security, factual and external configuration prerequisites are never bypassed. Missing bundles
return `available:false` in limited mode without creating data. Full mode owns
bundle/Git setup during an operation, never startup/status. No author identity or
remote is invented; provide legitimate Git configuration/environment or explicit
memoryGitIdentity. Unrelated project Git operations are outside memory authority.

Optional observability callbacks are data-only. `onModelEvent` receives
`{type:"start",provider,model,systemPrompt,messages}`, then zero or more
`{type:"delta",channel:"text"|"thinking",delta}`, then
`{type:"end",message,timeoutMs,elapsedMs,abortReason?}` with the unchanged final
native assistant message. Start events include `timeoutMs`. Abort diagnostics
preserve the first local cancellation reason, name deadline expiry explicitly,
and distinguish provider-reported abortion without a local cancellation. Opaque provider metadata is preserved,
not interpreted. `onEvent(type,detail)` supplies operational references; neither
callback exposes HTTP credentials or transport options. The host owns logging,
privacy/retention and UI. If a callback fails mid-stream, abort and await the
provider before releasing ownership; reported usage is still accounted when available.

## Full agent ownership

Authority precedence is request/workspace settings, `PI_MEMORY_OWNERSHIP`, then
limited in every environment. Hosts opt into full ownership explicitly through
these generic settings; deployment/sandbox detection never grants authority.
These settings are configuration, not authenticated source identity. Full mode means no human
approval or console answer is expected for memory-owned repairs, including
human-verified concepts and stale review. Investigate repository/session evidence; qualify
or archive unsupported claims. Preserve prior verification as historical provenance,
never claim that agent-corrected content was human-reviewed.

`autonomous-recovery.ts` uses the existing registry plus SDK read/edit/write/bash
in-process, without extension/agent discovery or another pi process. Private cases
under `workDir/recovery/` record native context, cause, attempts, checkpoints and
outcomes. Review case/trigger identities include source path and content hash, so
queued sessions never share review context. On an authorized operation, legacy
source-unbound trigger files are renamed to `.retired-<uuid>` evidence and fresh
validation/extraction replaces their stale diagnosis. Status/startup do not migrate
anything. Legacy cases/checkpoints, extraction journals and corpus files are retained;
retirement alone never grants completion or bypasses validation/commit.

Concept types are open, nonempty single-line labels (at most 80 characters).
The worker is told the bundle format and that `index.md`/`catalog.md` are generated; the
host regenerates them before verifying, so a worker never needs to edit navigation.
Original corpus bytes are checkpointed before writes; read versions and
source/lock guards protect normal file-tool writes. Interrupted calls are inspected,
not blindly replayed. Corpus snapshots are content-addressed; individual full
snapshots are capped at 8 MiB. Owner-only permission metadata can be repaired before
locking/checkpoint reads when the agent owns the files; no symlink traversal,
foreign UID rights or Git-object mode changes. Private work inside a bundle is refused.

Each opportunity permits at most `recoveryMaxTurns` sequential recovery calls
(default 50, whole number 1–100), bounded independently by the
reported-cost allowance and per-call deadline; shell commands have a 60s bound.
Opportunity exhaustion defers durable progress for automatic continuation; transient
provider failures back off without asking a human. Content fingerprints at opportunity
boundaries distinguish real corpus changes from repeated checkpoint events. After
three unchanged opportunities with no verified completion, `memory-recovery-stalled`
is an **error**, not a deferral, so the coordinator's ordinary backoff and `maxRetries`
apply. Evidence is retained and real repairs can still resume. An independently changed
corpus or selected model resets the no-progress streak. No-op scratch experiments,
context resets and reading prior transcripts do not reset it. These fingerprints detect
content changes, not semantic improvement; validation/commit still decide success.
Unsupported provider capabilities,
missing credentials/compatible runtimes/mounts or ownership outside memory scope are
structured `memory-external` host prerequisites. A model's external claim alone is
insufficient: failed operational evidence is required. Facts/policy ambiguity is
investigation/qualification work, not an external blocker.

Host verification, not model prose, decides success. Tool-based reviews can attest
`reviewed:true, reviewedSourceHash:<current hash>` after inspecting all source branches,
allowing failed extraction/oversized-corpus recovery without deleting valid memory.
Upgrade steps are deterministic: after a worker repairs what a step's verifier reported,
the host reruns the step itself and still requires final commit proof. Other repair-only successes
return `complete:false`; normal pending work resumes automatically. Full policy keys
include corpus-content fingerprints and a daily health boundary, so validation runs
again after independent edits/expiry without re-paying committed extraction sections.

Model/tool streams and replay request contexts reach optional host callbacks. Replay
contexts are data events rather than duplicate native assistant messages/accounting.
`modelTranscripts:false` omits durable provider context from cases as well as run logs;
continuation re-investigates from operational cases/checkpoints. These checkpoints
still contain private memory, and tool actions/errors may contain sensitive material.

Full shell has the process's practical filesystem/network/credential authority.
Memory-only shell scope is cooperative, not an OS sandbox or authenticated audit;
SDK worker tools do not inherit foreground tool overrides/approval extensions. Use
full-process isolation for unattended deployments. Never weaken validation, invent dates or
credentials, bypass signing/hooks, force push, or displace live/foreign owners.
Push recovery may reconcile the existing upstream only for an explicit push operation;
whole-repository reconciliation is not granted for unrelated enclosing project state.

## Execution and limits

- Upgrade runs the package's ordered deterministic steps through UpgradeRunner and
  commits, with no model call. A pending step that needs model review (none ship today)
  is reported as `memory-upgrade-review` for an interactive `/memory-upgrade`.
- Ordinary review reads all supplied branches. It splits long conversation text without
  sampling and processes at most one new section per opportunity. The reviewer is sent
  `memory.catalog` (one `id | title | description` line for every concept) and
  `memory.concepts` (full text of the concepts that best match the section, most
  relevant first; a concept too large for the remaining budget contributes its head and
  matching section, marked as an excerpt). The budget is derived from the selected
  model's context window and capped at 60,000 characters, so corpus growth does not
  change request size. Model calls are tool-free and use the existing registry, bounded
  to ten minutes by default and 8192 output tokens. Hosts can override the per-call
  deadline with `modelTimeoutMs`; pi-session-maintenance supplies its configurable
  `modelTimeoutSeconds`. Longer deadlines do not disable foreground/peer cancellation.
- Section journals live under `workDir/<hash(bundle, source path)>` and no longer
  depend on package version or model. Committed journals written by 0.6–0.11 under the
  current model are honoured, so adopting a release does not repeat paid extraction.
- Full ownership consolidates before extracting: the concept with the most
  `## Session evidence` sections (four or more) is sent alone with a rewrite guide.
  The returned body is accepted only if it is at least 200 characters, shorter than the
  original, free of per-session evidence headings and keeps every local link. It is
  written, validated and committed as `chore(memory): consolidate <id>`, and the
  opportunity returns `complete:false` with `detail.consolidated`. A rejected rewrite
  is recorded in `workDir/consolidation/`; after two rejections of the same content the
  concept is left alone until it changes. Human-verified concepts are never rewritten.
  Limited ownership never consolidates; `/memory-consolidate` asks the foreground agent.
- Prompts state the output-token budget. A section whose call stops on `length` or
  its own deadline is not retried unchanged: a `<section>.split.json` marker in the
  private work dir halves only that section (whole entries by size, or one oversized
  entry at its midpoint with exact `startChar`/`endChar`), and the opportunity returns
  `complete:false` with `detail.split`. Other section hashes and committed journals
  stay stable, so nothing is re-extracted or duplicated. Sections at or below 2,000
  JSON chars are not split; they fail with structured `model-output-limit` /
  `model-timeout` issues (`detail.minimumSplit`) for the coordinator's retry limit.
  Caller/foreground cancellation never triggers a split.
- Before review and after applying a plan, navigation (`index.md`, `catalog.md`) is
  regenerated from concept metadata and the usage ledger, which is also when idle
  concepts leave the session index. This needs no model, checkpoint or approval. If
  blocking findings remain and all of them are broken links, one tool-free model
  proposal per opportunity may retarget them, capped at two proposals per unchanged
  corpus. The model sees only the files with broken links and the catalog. Only exact
  broken Markdown body links may be retargeted to existing bundle files; labels, prose,
  facts and frontmatter stay unchanged. Human-verified concepts cannot receive model
  edits. Findings that need a concept file repaired (unreadable frontmatter, missing
  title/description, symlink) are `memory-validation` blockers in limited mode and go
  to the recovery worker in full mode.
- Link repairs checkpoint original/replacement bytes and rationale in private
  `workDir/repairs/` before writes. Source freshness/corpus agreement is checked before
  application; partial application resumes idempotently. A changed target archives the
  stale checkpoint and defers fresh planning rather than overwriting foreground work.
  A pending repair commit retries before any new model extraction. Repair-only runs
  return `complete:false` after validation and commit; the normal step/section resumes
  next opportunity. Stable section evidence markers prevent re-appending repaired
  addenda. `onEvent` exposes failed/successful `validation` and applied `repair` records.
- If extraction already used the opportunity's model allowance, link repair emits
  deferred `memory-repair-pending` and runs next idle opportunity. No approval prompt
  or foreground delegation. Unresolved concept-file findings stay `memory-validation`
  blockers with repair evidence; no dates, identity, provenance or verification claims
  are fabricated to pass validation.
- Limited structured extraction plans cite source entries and permit only create or attributed body
  addenda to concepts. They cannot delete, overwrite frontmatter,
  mark human verification, or execute shell/browser actions. Corrections qualify
  earlier claims rather than erase provenance. Human-verified concepts are
  not automatically modified in limited mode. Full ownership grants investigation
  and warranted corrections, preserving historical provenance; it does not fabricate verification.
- Before each model call, the complete serialized request (prompt, source, supplied
  memory and tools) is estimated at one token per two characters, plus the output
  allowance and 1,000 overhead tokens, against the selected model's context window.
  This is a heuristic, not provider tokenization. Because supplied memory is sized to
  the model, only a model too small for one source section plus the prompt reports
  `memory-context-capacity`; nothing is truncated silently to avoid it.
- Concepts are written through the package's native store, which stamps frontmatter,
  appends the log and regenerates navigation. Validation must have zero blocking
  findings; concepts need no links to each other. Every completed section is automatically committed,
  including already-present agent-owned changes within the bundle, while preserving
  unrelated outer-repository staging. Hooks/signing and configured identity are honored.
- Plans are checkpointed before writes; interrupted application detects already
  applied addenda. Failed Git finalization retries the same plan, not another model
  extraction. Source freshness and corpus changes are checked before applying.
- Push is a separate operation, never part of ordinary upgrade consent. Full
  recovery can fetch/reconcile a dedicated memory repository's existing upstream;
  limited mode does not auto-merge/rebase. It requires
  an existing upstream and uses no force/rebase/reset. Network/auth failures remain
  retryable independently of review. Git terminal prompts and default SSH password
  prompts are disabled; configure unattended Git credentials/signing/hooks yourself.

The adapter shares the existing bundle upgrade lock. Dead local locks may be
recovered only after local PID-death checks and exact lock comparison; live/foreign
owners are never displaced by age. Foreground input aborts nested model calls.
Cancellation keeps ownership until work stops; it does not roll back completed
corpus edits or commits. Synchronous Git operations can occupy the event loop
until their bounded timeout; interruption is cooperative, not instantaneous.

This is a trusted in-process protocol, not a model-callable surface or a sandbox.
Model responses are proposals; structural validation cannot prove their truth.
Worker receipts/corpus data contain private conversation-derived material.
