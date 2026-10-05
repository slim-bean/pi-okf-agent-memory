export class MemoryMaintenanceIssue extends Error {
  readonly maintenanceIssue = 1;
  constructor(readonly kind: "deferred" | "blocked" | "error", readonly code: string,
    readonly resource: string, message: string, readonly detail?: unknown) { super(message); }
}
/** Git diagnostics become stable resource-scoped issues; no repair or bypass is performed. */
export function gitIssue(bundle: string, error: unknown, operation: "commit" | "push"): Error {
  if ((error as { maintenanceIssue?: unknown })?.maintenanceIssue === 1) return error as Error;
  const message = (error as Error).message ?? String(error);
  const code = /Author identity unknown|unable to auto-detect email|empty ident name/i.test(message) ? "git-identity" :
    /no valid upstream|no upstream|detached HEAD/i.test(message) ? "git-upstream" :
    /Unmerged Git index|Git .* in progress|unmerged files|unresolved conflict/i.test(message) ? "git-conflict" :
    /Authentication failed|Permission denied|could not read Username|could not read Password/i.test(message) ? "git-auth" :
    /gpg failed|failed to sign|signing failed|pinentry/i.test(message) ? "git-signing" :
    operation === "push" && /non-fast-forward|fetch first|\[rejected\]|remote rejected|hook declined/i.test(message) ? "git-push-rejected" :
    operation === "push" ? "git-push" : "git-finalization";
  return new MemoryMaintenanceIssue(code === "git-push" || code === "git-finalization" ? "error" : "blocked", code, bundle, message);
}
