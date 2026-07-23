#!/usr/bin/env bash
# Share your local Mandarin Learn with 1–2 testers over a Cloudflare quick tunnel —
# no account, no domain. Builds the app, serves app+api from ONE port, and exposes it
# as an HTTPS *.trycloudflare.com URL. Ctrl-C tears everything down.
#
# Usage:  npm run share        (or: bash scripts/tunnel.sh)
# Env:    SHARE_PORT=8787      port the shared single-origin server binds (default 8787)
set -euo pipefail
cd "$(dirname "$0")/.."

SHARE_PORT="${SHARE_PORT:-8787}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "✗ cloudflared not found."
  echo "  Install it (no account needed for quick tunnels):"
  echo "    macOS:  brew install cloudflared"
  echo "    other:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  echo "  Alternatives: ngrok ('ngrok http $SHARE_PORT') or Tailscale Funnel."
  exit 1
fi

echo "→ Building the app (so one port serves app + api)…"
npm run build >/dev/null

echo "→ Starting shared server on :$SHARE_PORT (app + api, single origin)…"
SERVE_APP=1 PORT="$SHARE_PORT" node server/index.js &
API_PID=$!
cleanup() { echo; echo "→ Shutting down…"; kill "$API_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Wait for the server to answer before opening the tunnel.
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$SHARE_PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

echo "→ Opening Cloudflare quick tunnel…"
echo "  • Keep this machine awake and Ollama running (ollama serve)."
echo "  • Each tester should pick or add their own user on the login screen."
echo "  • Testers share one Qwen, so simultaneous turns queue; a per-session cap protects the keys."
echo
cloudflared tunnel --url "http://localhost:$SHARE_PORT"
