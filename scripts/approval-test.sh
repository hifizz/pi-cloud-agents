#!/usr/bin/env bash
# Manual demo of the approval hook (F10) against a running TARSBot server.
#
# Prerequisites (done by the orchestrator, not by this script):
#   - src/runtime.mjs installs `Approval` from src/ext/approval.mjs in productionExtensions(), after CodingTools.
#   - the server mounts `register` from src/routes/approvals.mjs as a route plugin.
#   - `npm start` is running (default http://127.0.0.1:8090) with a Cua Space available.
#
# Usage:  scripts/approval-test.sh [bot-name]
# Env:    TARSBOT_URL (default http://127.0.0.1:8090)
#
# What it does:
#   1. creates a bot (or reuses it) and asks it to run `rm -rf /tmp/approval-demo` in the Space
#   2. waits for the item to appear in GET /api/approvals
#   3. denies it first (the model receives "User denied: ..."), then asks again and approves it
#
# Restart check (REQ-F10-2, by hand): repeat step 1, approve, and kill the server right away; after `npm start`
# the call does not show up in /api/approvals again. Kill the server WITHOUT approving: after restart it is listed again.
set -euo pipefail

BASE="${TARSBOT_URL:-http://127.0.0.1:8090}"
BOT="${1:-approval-demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"

json() { node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")),null,2))'; }

if ! curl -fsS "$BASE/api/bots/$BOT/entries?limit=1" >/dev/null 2>&1; then
  echo "creating bot $BOT"
  curl -fsS -X POST "$BASE/api/bots" -H 'content-type: application/json' -d "{\"name\":\"$BOT\"}" | json
fi

wait_pending() {
  for _ in $(seq 1 120); do
    local body
    body="$(curl -fsS "$BASE/api/approvals")"
    if [ "$body" != "[]" ]; then
      printf '%s' "$body"
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for a pending approval" >&2
  return 1
}

task_id() { node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(a[0].taskId)'; }

run_round() {
  local verdict="$1"
  echo
  echo "== round: $verdict =="
  node "$HERE/ask.mjs" "$BOT" "Use the bash tool to run exactly: rm -rf /tmp/approval-demo (create it first with mkdir -p if needed, in a separate command). Then report the result." --timeout 180 &
  local ask_pid=$!
  local pending
  pending="$(wait_pending)"
  echo "$pending" | json
  local id
  id="$(echo "$pending" | task_id)"
  curl -fsS -X POST "$BASE/api/approvals/$id" -H 'content-type: application/json' -d "{\"approved\":$verdict}" | json
  wait "$ask_pid" || true
}

run_round false
run_round true

echo
echo "pending after both rounds (expect []):"
curl -fsS "$BASE/api/approvals" | json
