#!/bin/bash
set -euo pipefail

# Double-click in Finder (or run in Terminal) to launch the Ōwashi lightshow bridge + browser UI.
cd "$(dirname "$0")/.."

# Locate Node (supports nvm, Homebrew, and system installs when launched from Finder).
NODE="$(command -v node || true)"
if [ -z "$NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  NODE="$(command -v node || true)"
fi
if [ -z "$NODE" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then NODE="$candidate"; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "Error: Node.js not found. Install Node or check PATH."
  read -r -p "Press Enter to close..."
  exit 1
fi

URL="http://localhost:8770/sim/"

# If the bridge is already running on :8770, just open the sim in the browser.
if lsof -iTCP:8770 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Ōwashi bridge is already running on :8770 — opening $URL"
  open "$URL"
  exit 0
fi

# Open the browser once the server starts listening.
(
  for _ in $(seq 1 30); do
    if lsof -iTCP:8770 -sTCP:LISTEN -t >/dev/null 2>&1; then
      open "$URL"
      exit 0
    fi
    sleep 0.2
  done
) &

exec "$NODE" sim/bridge/artnet-bridge.mjs --lan
