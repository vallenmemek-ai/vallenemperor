#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"

mkdir -p "$BIN_DIR"

build_core() {
  npm ci --workspace=vallenagent --workspace=vallencli --include-workspace-root=false
  npm -w vallenagent run build
  npm -w vallencli run build
}

case "${1:-}" in
  --install-vallencli)
    build_core
    ln -sf "$REPO_DIR/bin/vallenemperor" "$BIN_DIR/vallenemperor"
    ln -sf "$REPO_DIR/bin/vallenemperorcli" "$BIN_DIR/vallenemperorcli"
    echo "Installed vallenemperor to $BIN_DIR"
    ;;
  --uninstall-vallencli)
    rm -f "$BIN_DIR/vallenemperor" "$BIN_DIR/vallenemperorcli"
    echo "Uninstalled vallenemperor from $BIN_DIR"
    ;;
  *)
    build_core
    ln -sf "$REPO_DIR/bin/vallenemperor" "$BIN_DIR/vallenemperor"
    ln -sf "$REPO_DIR/bin/vallenemperorcli" "$BIN_DIR/vallenemperorcli"
    echo "Done."
    ;;
esac
