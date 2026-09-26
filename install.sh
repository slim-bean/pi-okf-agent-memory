#!/usr/bin/env bash
# Wire pi-okf-agent-memory into a pi project.
# Usage: ./install.sh /path/to/project [knowledge-dir]
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:?Usage: ./install.sh /path/to/project [knowledge-dir]}"
KNOWLEDGE_DIR="${2:-}"

EXT="$TARGET/.pi/extensions/okf-memory"
LEGACY="$TARGET/.pi/extensions/okf-memory.ts"
if [ -f "$LEGACY" ] && ! grep -q 'okfMemoryExtension' "$LEGACY"; then
  echo "Unrecognized legacy $LEGACY; inspect/relocate it before installing to avoid duplicate tools." >&2
  exit 1
fi
mkdir -p "$EXT/bin" "$TARGET/.pi/skills"
# A directory entry point keeps helper modules out of pi's top-level discovery.
cp "$SRC/index.ts" "$SRC/package.json" "$EXT/"
cp -R "$SRC/lib" "$EXT/"
cp -R "$SRC/skills/okf-memory" "$SRC/skills/okf-memory-upgrade" "$TARGET/.pi/skills/"
# Ship every supported architecture; the extension selects its runtime match.
cp "$SRC"/bin/okf-* "$SRC/bin/UPSTREAM.json" "$SRC/bin/NOTICES.md" "$EXT/bin/"
cp "$SRC/bin/okf" "$EXT/bin/okf"
# Remove our legacy entry point so old local installs do not register twice.
# Keep the old shared bin/ directory: other extensions may use it.
if [ -f "$LEGACY" ]; then rm "$LEGACY"; fi
echo "Installed extension -> $EXT/index.ts (+ bundled OKF binaries)"
echo "Installed skills    -> $TARGET/.pi/skills/okf-memory{,-upgrade}/"

# All installation paths use the same session-time setup. Installation itself
# neither creates a corpus nor guesses a Git identity/commits on the user's behalf.
if [ -n "$KNOWLEDGE_DIR" ]; then
  echo "Set OKF_KNOWLEDGE_DIR=$KNOWLEDGE_DIR in pi's environment to select this bundle."
fi

cat <<'EOF'

Done. In a running pi session, /reload picks up the extension and skills.
Accept the startup setup prompt or run /memory-setup, then /memory-upgrade.
For unattended provisioning use the explicit host setup protocol (docs/setup.md).
No knowledge files, Git repositories, identities or commits were changed by this installer.
EOF
