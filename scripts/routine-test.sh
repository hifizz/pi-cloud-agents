#!/usr/bin/env bash
# TEST-F06-1 demo against a REAL running server (run after integration). ~3-4 minutes.
# Usage: scripts/routine-test.sh [bot]      env: TARSBOT_URL (default http://127.0.0.1:8080)
# The server restart step is manual because this script does not own the server process.
set -euo pipefail
BASE="${TARSBOT_URL:-http://127.0.0.1:8080}"
BOT="${1:-tars}"
PROMPT='Run `uptime` and report the result in one line.'

api() { curl -fsS -H 'content-type: application/json' "$@"; }
count() { api "$BASE/api/routines" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(x=>x.id===process.argv[1]);console.log(r?r.fireCount:-1)})' "$1"; }

echo "1) create a 1-minute routine for bot '$BOT'"
ID=$(api -X POST "$BASE/api/routines" -d "$(node -e 'console.log(JSON.stringify({bot:process.argv[1],prompt:process.argv[2],everyMs:60000}))' "$BOT" "$PROMPT")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
echo "   routine id: $ID"

echo "2) wait for the first firing (up to 90s)"
for _ in $(seq 1 90); do [ "$(count "$ID")" -ge 1 ] && break; sleep 1; done
N1=$(count "$ID"); echo "   fireCount=$N1"; [ "$N1" -ge 1 ] || { echo "FAIL: routine never fired"; exit 1; }

echo "3) NOW RESTART THE SERVER (Ctrl-C the 'npm start' process and start it again)."
echo "   Waiting up to 5 minutes for the server to come back and the routine to fire again..."
sleep 5
for _ in $(seq 1 300); do
  N=$(count "$ID" 2>/dev/null || echo -1)
  if [ "$N" -ge $((N1 + 1)) ] 2>/dev/null; then
    # server must have been restarted at least once in between; we can't prove it, so ask the operator
    echo "   fireCount=$N (> $N1)"; break
  fi
  sleep 1
done
[ "${N:--1}" -ge $((N1 + 1)) ] || { echo "FAIL: no firing after restart"; exit 1; }

echo "4) the Bot conversation shows the prompt (newest first):"
api "$BASE/api/bots/$BOT/entries" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const items=j.items??j;let n=0;for(const e of items){const m=e.model?.[0];if(m?.role==="user"){console.log("   user:",typeof m.content==="string"?m.content:JSON.stringify(m.content).slice(0,100));if(++n>=3)break}}})'

echo "5) cancel the routine"
api -X POST "$BASE/api/routines/$ID/cancel"; echo
echo "PASS (verify step 3 restart happened while waiting)"
