#!/usr/bin/env bash
# Dev environment: backend on 8100 + Vite dev server on 5184 (HMR).
# Open http://127.0.0.1:5184 — /api is proxied to the backend.
set -euo pipefail
cd "$(dirname "$0")/.."

TARSBOT_PORT=8100 node src/server.mjs &
BACK=$!
(cd web && npm run dev) &
WEB=$!

trap 'kill $BACK $WEB 2>/dev/null || true' EXIT INT TERM
wait $BACK $WEB
