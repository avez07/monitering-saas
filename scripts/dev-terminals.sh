#!/usr/bin/env bash
# Opens Backend, Worker and Frontend each in its own terminal (tmux, else gnome-terminal/xterm/macOS Terminal).
# Usage (repo root): bash scripts/dev-terminals.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMDS=("npm run dev:backend" "npm run dev:worker" "npm run dev:frontend")
NAMES=(backend worker frontend)
if command -v tmux >/dev/null; then
  tmux new-session -d -s yuktiops -n "${NAMES[0]}" -c "$ROOT" "${CMDS[0]}"
  for i in 1 2; do tmux new-window -t yuktiops -n "${NAMES[$i]}" -c "$ROOT" "${CMDS[$i]}"; done
  echo "Started in tmux session 'yuktiops'. Attach: tmux attach -t yuktiops"
  exit 0
fi
for i in 0 1 2; do
  if [ "$(uname)" = Darwin ]; then
    osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT' && ${CMDS[$i]}\""
  elif command -v gnome-terminal >/dev/null; then
    gnome-terminal --title="yuktiops-${NAMES[$i]}" -- bash -lc "cd '$ROOT' && ${CMDS[$i]}; exec bash"
  elif command -v xterm >/dev/null; then
    xterm -T "yuktiops-${NAMES[$i]}" -e bash -lc "cd '$ROOT' && ${CMDS[$i]}; exec bash" &
  else
    echo "No terminal launcher found. Run each in its own terminal: ${CMDS[*]}"; exit 1
  fi
done
