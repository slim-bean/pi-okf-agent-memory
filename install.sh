#!/usr/bin/env bash
# Wire pi-okf-agent-memory into a pi project.
# Usage: ./install.sh /path/to/project [knowledge-dir]
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:?Usage: ./install.sh /path/to/project [knowledge-dir]}"
KNOWLEDGE_DIR="${2:-}"

mkdir -p "$TARGET/.pi/extensions" "$TARGET/.pi/skills"
cp "$SRC/index.ts" "$TARGET/.pi/extensions/okf-memory.ts"
cp -r "$SRC/skills/okf-memory" "$TARGET/.pi/skills/"
mkdir -p "$TARGET/.pi/extensions/bin"
# Ship every architecture build; the extension picks the one matching its runtime.
cp "$SRC"/bin/okf-* "$TARGET/.pi/extensions/bin/"
cp "$SRC/bin/okf" "$TARGET/.pi/extensions/bin/okf" 2>/dev/null || true
echo "Installed extension -> $TARGET/.pi/extensions/okf-memory.ts (+ bin/okf-* for linux/darwin amd64+arm64)"
echo "Installed skill      -> $TARGET/.pi/skills/okf-memory/"

# Knowledge bundle: explicit dir, <target>/knowledge, or — when the target itself
# lives under a shared /workspace — the workspace's top-level bundle.
if [ -n "$KNOWLEDGE_DIR" ]; then
  CANDIDATE="$KNOWLEDGE_DIR"
elif [ -f "$TARGET/knowledge/index.md" ]; then
  CANDIDATE=""
elif { [ "$TARGET" = "/workspace" ] || [ "${TARGET#/workspace/}" != "$TARGET" ]; } && [ -f /workspace/knowledge/index.md ]; then
  CANDIDATE=""
  echo "Reusing existing bundle at /workspace/knowledge (set OKF_KNOWLEDGE_DIR to override)"
else
  CANDIDATE="$TARGET/knowledge"
fi

if [ -n "${CANDIDATE:-}" ]; then
  # Use the build matching this host for the init step.
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) ARCH=unknown ;;
  esac
  OKF="$SRC/bin/okf-$OS-$ARCH"
  [ -x "$OKF" ] || OKF="$SRC/bin/okf"
  "$OKF" init "$CANDIDATE"
  # A bundle without history loses half its value; make it a git repo. Only set
  # a local identity when none resolves (developers usually have a global one).
  if [ ! -d "$CANDIDATE/.git" ]; then
    git -C "$CANDIDATE" init -q
    git -C "$CANDIDATE" add -A
    if [ -z "$(git -C "$CANDIDATE" config user.email || true)" ]; then
      BASE="$(basename "$TARGET")"
      git -C "$CANDIDATE" config user.name "$BASE"
      git -C "$CANDIDATE" config user.email "$BASE@$(hostname -s 2>/dev/null || echo localhost)"
    fi
    git -C "$CANDIDATE" commit -qm "Initialize OKF knowledge bundle" || true
  fi
  echo "Initialized OKF bundle -> $CANDIDATE (git repo)"
  echo "  Set OKF_KNOWLEDGE_DIR=$CANDIDATE if the bundle lives outside the project."
fi

cat <<'EOF'

Done. In a running pi session, /reload picks up the extension and skill.
Suggested next step: seed knowledge/project/overview.md with the project's purpose.
EOF
