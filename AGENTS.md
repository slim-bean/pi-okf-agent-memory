# AGENTS.md

pi-okf-agent-memory is a pi extension + skill that wires an OKF v0.2 knowledge
corpus (https://github.com/okf-memory/okf-agent-memory) into pi sessions as
persistent project memory. See `README.md` for user docs.

## Layout

- `index.ts` — the entire extension. Registers `memory_search` /
  `memory_show` / `memory_validate` tools, `/memory-context` and
  `/knowledge-review` commands, and a `session_start` hook that queues the
  corpus index on startup/resume/fork (skips `reload`). Resolves the okf
  binary at factory time: `$OKF_BIN` → sibling `bin/okf` → `PATH`.
- `bin/okf` — prebuilt okf CLI binary (Go, zero deps), built from
  okf-agent-memory v0.1.2. Committed so `pi install git:...` works with no
  build step. Rebuild with `make build` in a clone of okf-agent-memory and
  copy over.
- `skills/okf-memory/SKILL.md` — agent skill: the why-only write budget,
  read-before-write loop, trust/lifecycle rules.
- `install.sh` — local (non-package) install into a project's `.pi/` dirs.
- `test/smoke.mjs` — smoke tests via jiti with a mock ExtensionAPI.
  Run: `node test/smoke.mjs`. They load `index.ts` through the same loader pi
  uses and exercise tools against a real bundle at `/workspace/knowledge`
  (tests that need a bundle skip gracefully if absent — keep it that way).

## Conventions

- pi-bundled imports (`@earendil-works/pi-coding-agent`, `typebox`) go in
  `peerDependencies` with `"*"` and `optional: true` — never `dependencies`.
- Git tags `vX.Y.Z` are the pinning refs for `pi install git:...@vX.Y.Z`.
  Tag on every release.
- `keywords` must include `pi-package` (gallery discoverability).
- Knowledge-corpus rule that also applies to this repo's own docs: record
  *why*, not *what*; git already has the what.
