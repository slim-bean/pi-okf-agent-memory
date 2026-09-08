#!/usr/bin/env bash
# Wire pi-okf-agent-memory into a pi project/sandbox.
# Usage: ./install.sh /path/to/project [knowledge-dir]
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:?Usage: ./install.sh /path/to/project [knowledge-dir]}"
KNOWLEDGE_DIR="${2:-}"

mkdir -p "$TARGET/.pi/extensions" "$TARGET/.pi/skills"
cp "$SRC/index.ts" "$TARGET/.pi/extensions/okf-memory.ts"
cp -r "$SRC/skills/okf-memory" "$TARGET/.pi/skills/"
mkdir -p "$TARGET/.pi/extensions/bin"
cp "$SRC/bin/okf" "$TARGET/.pi/extensions/bin/okf"
echo "Installed extension -> $TARGET/.pi/extensions/okf-memory.ts (+ bin/okf)"
echo "Installed skill      -> $TARGET/.pi/skills/okf-memory/"

# Knowledge bundle: explicit dir, <target>/knowledge, or reuse /workspace/knowledge
if [ -n "$KNOWLEDGE_DIR" ]; then
  CANDIDATE="$KNOWLEDGE_DIR"
elif [ -f "$TARGET/knowledge/index.md" ]; then
  CANDIDATE=""
elif [ -f /workspace/knowledge/index.md ]; then
  CANDIDATE=""
  echo "Reusing existing bundle at /workspace/knowledge (set OKF_KNOWLEDGE_DIR to override)"
else
  CANDIDATE="$TARGET/knowledge"
fi

if [ -n "${CANDIDATE:-}" ]; then
  "$SRC/bin/okf" init "$CANDIDATE"
  echo "Initialized OKF bundle -> $CANDIDATE"
  echo "  Set OKF_KNOWLEDGE_DIR=$CANDIDATE if the bundle lives outside the project."
fi

cat <<'EOF'

Done. In a running pi session, /reload picks up the extension and skill.
Suggested next step: seed knowledge/project/overview.md with the project's purpose.
EOF
