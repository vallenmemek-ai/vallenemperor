#!/usr/bin/env bash
set -euo pipefail

# Works on Linux, macOS and Termux. Windows uses install.ps1.
REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Termux keeps executables in $PREFIX/bin (already on PATH); everywhere else
# uses the usual ~/.local/bin.
if [[ -n "${PREFIX:-}" && "$PREFIX" == *com.termux* ]]; then
  BIN_DIR="${PREFIX}/bin"
else
  BIN_DIR="${HOME}/.local/bin"
fi

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js >= 20 is required." >&2
    if [[ -n "${PREFIX:-}" && "$PREFIX" == *com.termux* ]]; then
      echo "  Termux: pkg install nodejs-lts" >&2
    fi
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major < 20 )); then
    echo "Error: Node.js >= 20 required (found $(node -v))." >&2
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is required." >&2
    exit 1
  fi
}

# better-sqlite3 is an optional dependency, so a missing toolchain only costs the
# session search index — warn instead of failing the whole install.
warn_optional_native() {
  if [[ -n "${PREFIX:-}" && "$PREFIX" == *com.termux* ]]; then
    if ! command -v clang >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
      echo "Note: install python, make and clang for the fast session index (optional):"
      echo "      pkg install python make clang"
    fi
  fi
}

build_core() {
  require_node
  warn_optional_native
  if ! npm ci --workspace=vallenagent --workspace=vallencli --include-workspace-root=false; then
    echo "npm ci failed; retrying with npm install..." >&2
    npm install --workspace=vallenagent --workspace=vallencli --include-workspace-root=false
  fi
  npm -w vallenagent run build
  npm -w vallencli run build
}

link_launchers() {
  mkdir -p "$BIN_DIR"
  chmod +x "$REPO_DIR/bin/vallenemperor" "$REPO_DIR/bin/vallenemperorcli" 2>/dev/null || true
  ln -sf "$REPO_DIR/bin/vallenemperor" "$BIN_DIR/vallenemperor"
  ln -sf "$REPO_DIR/bin/vallenemperorcli" "$BIN_DIR/vallenemperorcli"
}

case "${1:-}" in
  --install-vallencli)
    build_core
    link_launchers
    echo "Installed vallenemperor to $BIN_DIR"
    ;;
  --uninstall-vallencli)
    rm -f "$BIN_DIR/vallenemperor" "$BIN_DIR/vallenemperorcli"
    echo "Uninstalled vallenemperor from $BIN_DIR"
    ;;
  *)
    build_core
    link_launchers
    echo "Done. Launchers: $BIN_DIR/vallenemperor, $BIN_DIR/vallenemperorcli"
    ;;
esac
