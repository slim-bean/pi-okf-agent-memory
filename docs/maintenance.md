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
  workDir,                 // private host-owned durable checkpoint directory
  model?,                  // provider/model-id; defaults to context.model
  source?,                 // {path,cwd,hash,entries}; all-branch user/assistant text
  signal?, assertSource?,  // review requires a callback that verifies current source/ownership
  onUsage?, onProgress?,
  result?: Promise<unknown>
}
```

Results contain `available`, a policy/package/model `key`, `complete`, and optional
`detail`. Status also reports canonical `bundle` and `upgraded`. Missing bundles
return `available:false` without creating data. No setup, identity or remote is
invented. Configure a Git-backed bundle first; the setup protocol is separate.

## Execution and limits

- Upgrade uses package-owned ordered guides and UpgradeRunner validation/ledger.
  One step per opportunity; finalization retries do not repeat completed guides.
- Ordinary review reads all supplied branches and the complete Markdown corpus
  (excluding the append-only log). It splits long conversation text without sampling.
  At most one new section is processed per opportunity; completed section receipts
  reuse unchanged source sections. Model calls are tool-free and use the existing
  registry, bounded to three minutes and 8192 output tokens.
- Structured plans cite source entries and permit only create or attributed body
  addenda to concepts. They cannot delete, overwrite frontmatter, grant governance,
  mark human verification, or execute shell/browser actions. Corrections qualify
  earlier claims rather than erase provenance. Held/human-verified concepts are
  not automatically modified. Outside-policy repairs become visible blockers.
- Corpus input is capped at 180,000 serialized characters and checked against
  model context; oversized input fails explicitly, never silently drops evidence.
- Writes use the bundled OKF CLI and maintain root/immediate indexes. Validation
  must have zero findings. Every completed section is automatically committed,
  including already-present agent-owned changes within the bundle, while preserving
  unrelated outer-repository staging. Hooks/signing and configured identity are honored.
- Plans are checkpointed before writes; interrupted application detects already
  applied addenda. Failed Git finalization retries the same plan, not another model
  extraction. Source freshness and corpus changes are checked before applying.
- Push is a separate operation, never part of ordinary upgrade consent. It requires
  an existing upstream and uses no force/rebase/reset. Network/auth failures remain
  retryable independently of review. Git terminal prompts and default SSH password
  prompts are disabled; configure unattended Git credentials/signing/hooks yourself.

The adapter shares the existing bundle upgrade lock. Dead local locks may be
recovered only after local PID-death checks and exact lock comparison; live/foreign
owners are never displaced by age. Foreground input aborts nested model calls.
Cancellation keeps ownership until work stops; it does not roll back completed
corpus edits or commits. Synchronous CLI/Git operations can occupy the event loop
until their bounded timeout; interruption is cooperative, not instantaneous.

This is a trusted in-process protocol, not a model-callable surface or a sandbox.
Model responses are proposals; structural validation cannot prove their truth.
Worker receipts/corpus data contain private conversation-derived material.
