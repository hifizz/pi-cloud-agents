#!/usr/bin/env bash
# Crash-recovery acceptance (TEST-F01-1/2/3, TEST-F04-0/1). Needs: docker, curl, jq, node, a working model key in .env.
# Starts/kills/restarts the TARSBot server (node --no-warnings src/server.mjs) and the Space container tarsbot-space,
# prints PASS/FAIL per scenario and writes the evidence to docs/recovery-test.md.
# Always leaves a server running on :8090 when it finishes.
#
# Usage: scripts/kill-test.sh [F01-1 F01-2 F01-3 F04]   (default: all)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUN="$(date +%Y%m%d-%H%M%S)"
BASE="${TARSBOT_URL:-http://127.0.0.1:8090}"
CONTAINER="${TARSBOT_SPACE_CONTAINER:-tarsbot-space}"
SERVER_CMD=(node --no-warnings src/server.mjs)
SERVER_PATTERN="node --no-warnings src/server.mjs"
LOG="$ROOT/logs/server-$RUN.log"
DOC="$ROOT/docs/recovery-test.md"
WORK="$(mktemp -d)"
SECTION=""            # current section file
LOGMARK=1             # first server-log line that belongs to the current scenario
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$ROOT/logs" "$ROOT/docs"
: >"$LOG"

ts() { date +%H:%M:%S; }
note() { printf -- '- `%s` %s\n' "$(ts)" "$*" >>"$SECTION"; echo "[$(ts)] $*"; }
block() { # $1 = language tag; stdin = content
  { printf '```%s\n' "$1"; cat; printf '```\n\n'; } >>"$SECTION"
}
raw() { printf '%s\n' "$*" >>"$SECTION"; }
begin_section() { # $1 = id, $2 = title
  SECTION="$WORK/$1.md"
  : >"$SECTION"
  LOGMARK=$(($(wc -l <"$LOG") + 1))
  printf '\n## %s — %s\n\n' "$1" "$2" >>"$SECTION"
  echo "=== $1: $2"
}
finish() { # $1 = id, $2 = PASS|FAIL, $3 = reason
  printf '\n**Result: %s** — %s\n' "$2" "$3" >>"$SECTION"
  echo "$2 $1 — $3"
  echo "$2" >"$WORK/$1.result"
}

# ---- server management -----------------------------------------------------------------------------------------------
server_pids() { pgrep -f "$SERVER_PATTERN" || true; }
server_up() { curl -sf --max-time 3 "$BASE/api/health" >/dev/null 2>&1; }
stop_server_term() {
  pkill -TERM -f "$SERVER_PATTERN" 2>/dev/null || true
  for _ in $(seq 1 20); do [ -z "$(server_pids)" ] && return 0; sleep 0.5; done
  pkill -9 -f "$SERVER_PATTERN" 2>/dev/null || true
  sleep 1
}
kill9_server() {
  pkill -9 -f "$SERVER_PATTERN" 2>/dev/null || true
  for _ in $(seq 1 20); do [ -z "$(server_pids)" ] && return 0; sleep 0.25; done
  return 1
}
start_server() { # waits for /api/health
  [ -z "$(server_pids)" ] || stop_server_term
  echo "----- server start $(ts) -----" >>"$LOG"
  nohup "${SERVER_CMD[@]}" >>"$LOG" 2>&1 &
  disown 2>/dev/null || true
  for _ in $(seq 1 90); do server_up && return 0; sleep 1; done
  echo "server did not become healthy; log tail:" >&2
  tail -20 "$LOG" >&2
  return 1
}
ensure_server() { server_up && [ -n "$(server_pids)" ] || start_server; }

# ---- API helpers -----------------------------------------------------------------------------------------------------
api() { curl -sS --max-time 30 "$@"; }
new_bot() { # $1 = name prefix -> prints bot id
  api -X POST "$BASE/api/bots" -H 'content-type: application/json' -d "{\"name\":\"$1-$RUN\"}" | jq -r '.id'
}
submit() { # $1 = bot, $2 = text
  jq -n --arg t "$2" '{text:$t}' | api -X POST "$BASE/api/bots/$1/input" -H 'content-type: application/json' -d @-
}
entries() { api "$BASE/api/bots/$1/entries?limit=1000"; }
JQ_SUMMARY='
.[] | . as $e | ($e.model[0] // {}) as $m
| select($e.kind != "pi.system")
| "\($e.id)\t\($e.kind)\t" + (
    if $e.kind == "pi.user" then (($m.content | if type == "string" then . else tostring end) | .[0:200])
    elif $e.kind == "pi.assistant" then
      "stop=\($m.stopReason) " + ([$m.content[] | if .type == "text" then "text: " + (.text | .[0:200]) elif .type == "toolCall" then "call: " + .name + " " + (.arguments | tostring | .[0:200]) else empty end] | join(" | "))
    elif $e.kind == "pi.tool-result" then
      "tool=\($m.toolName) isError=\($m.isError) diag=[" + (($e.data.diagnostics // []) | map(.code // "?") | join(",")) + "] :: " + ([$m.content[] | select(.type == "text") | .text] | join(" ") | gsub("\n"; "\\n") | .[0:240])
    else "" end)'
summary() { entries "$1" | jq -r "$JQ_SUMMARY"; }
# Non-empty when a tool result says the tool was interrupted.
interrupted_results() { entries "$1" | jq -r '.[] | select(.kind == "pi.tool-result") | select((.model[0].content | tostring | test("interrupted"; "i")) or ((.data.diagnostics // []) | tostring | test("interrupted|orphaned|aborted"; "i"))) | .id'; }
# Final state of the conversation: FINAL (last entry is an assistant message that ended its turn), else the last kind.
final_state() {
  entries "$1" | jq -r 'map(select(.kind != "pi.system")) | last | if .kind == "pi.assistant" and (.model[0].stopReason == "stop") and ([.model[0].content[] | select(.type == "text")] | length > 0) then "FINAL" else (.kind + ":" + ((.model[0].stopReason // .model[0].toolName // "") | tostring)) end'
}
bot_busy() { api "$BASE/api/bots" | jq -r --arg id "$1" '.[] | select(.id == $id) | (.busy or (.queued > 0))'; }
# Wait until the bot has a final assistant answer, is idle and stable (3 polls); $2 = timeout seconds.
wait_final() {
  local bot="$1" limit="${2:-240}" stable=0 start=$SECONDS
  while [ $((SECONDS - start)) -lt "$limit" ]; do
    if [ "$(bot_busy "$bot")" = "false" ] && [ "$(final_state "$bot")" = "FINAL" ]; then
      stable=$((stable + 1))
      [ "$stable" -ge 3 ] && return 0
    else
      stable=0
    fi
    sleep 2
  done
  return 1
}
# Wait until the bot is idle (busy=false, nothing queued) for 4 consecutive polls, whatever the final entry is.
wait_idle() {
  local bot="$1" limit="${2:-240}" stable=0 start=$SECONDS
  while [ $((SECONDS - start)) -lt "$limit" ]; do
    if [ "$(bot_busy "$bot")" = "false" ]; then stable=$((stable + 1)); [ "$stable" -ge 4 ] && return 0; else stable=0; fi
    sleep 2
  done
  return 1
}
# Wait until a process matching $1 runs in the container ($2 = timeout seconds).
wait_in_container() {
  local pattern="$1" limit="${2:-120}" start=$SECONDS
  while [ $((SECONDS - start)) -lt "$limit" ]; do
    docker exec "$CONTAINER" pgrep -f "$pattern" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
container_started_at() { docker inspect -f '{{.State.StartedAt}}' "$CONTAINER"; }
wait_space_ready() { # viewer answers 200 again
  for _ in $(seq 1 90); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3211/viewer/ || true)" = "200" ] && return 0
    sleep 1
  done
  return 1
}
server_log_excerpt() { tail -n "+${LOGMARK:-1}" "$LOG" | grep -E 'resume done|listening|fatal|Error|error|\[space\]|server start' | tail -20; }

LONG_CMD='for i in $(seq 1 20); do echo $i; sleep 1; done; echo DONE > /home/cua/work/%s.txt'

# =====================================================================================================================
# F01-1  kill -9 the server while a long bash call runs
# =====================================================================================================================
f01_1() {
  begin_section "F01-1" "kill -9 server during a long bash run; restart resumes the run"
  local bot cmd t_kill
  bot="$(new_bot kt-f01-1)"
  cmd="$(printf "$LONG_CMD" kt-f01-1)"
  raw "Bot \`$bot\`. Long task command (inside the Space):"
  raw ""; printf '%s\n' "$cmd" | block sh
  raw "Procedure: submit the task; when the \`seq 1 20\` process is running in the container, wait 4 s, \`pkill -9 -f \"$SERVER_PATTERN\"\`, start the server again, wait for the run to finish."
  raw ""; raw "Timeline:"; raw ""
  note "server up: $(server_up && echo yes || echo no)"
  submit "$bot" "Use the bash tool exactly once with this exact command (do not change it): $cmd . After the tool returns, reply in one sentence saying whether it completed and what you observed." >/dev/null
  note "task submitted to bot $bot"
  if ! wait_in_container 'seq 1 20' 150; then
    note "bash never started in the container"; finish F01-1 FAIL "long bash command did not start"; return
  fi
  sleep 4
  t_kill="$(ts)"
  kill9_server; note "kill -9 server (pids left: '$(server_pids)')"
  note "state while server is dead: health=$(server_up && echo up || echo down); container process still running: $(docker exec "$CONTAINER" pgrep -f 'seq 1 20' >/dev/null 2>&1 && echo yes || echo no)"
  if ! start_server; then finish F01-1 FAIL "server did not restart"; return; fi
  note "server restarted (healthy)"
  if ! wait_final "$bot" 240; then
    raw ""; raw "Conversation when giving up:"; summary "$bot" | block text
    finish F01-1 FAIL "no final assistant answer within 240 s after restart"; return
  fi
  note "run finished, bot idle, final answer present"
  local intr; intr="$(interrupted_results "$bot" | tr '\n' ' ' | sed 's/ *$//')"
  raw ""; raw "Server log excerpt (resume):"; raw ""; server_log_excerpt | block text
  raw ""; raw "Conversation entries (id, kind, content):"; raw ""; summary "$bot" | block text
  raw "Observed afterwards: \`cat /home/cua/work/kt-f01-1.txt\` -> \`$(docker exec "$CONTAINER" sh -c 'cat /home/cua/work/kt-f01-1.txt 2>&1' | head -1)\` (if the file is missing, the Space dropped the command together with the lost connection; \`bash\` is not \`replay:\"safe\"\`, so the harness reports it as interrupted instead of re-running it)."
  if [ -n "$intr" ]; then
    finish F01-1 PASS "run resumed after kill -9 at $t_kill; interrupted tool result entries: $intr; final assistant answer present"
  else
    finish F01-1 FAIL "run finished but no interrupted tool result found in the conversation"
  fi
}

# =====================================================================================================================
# F01-2  docker restart of the Space, then a bash call succeeds
# =====================================================================================================================
f01_2() {
  begin_section "F01-2" "docker restart tarsbot-space; the next bash call succeeds"
  local bot marker before after
  ensure_server || { finish F01-2 FAIL "server not available"; return; }
  bot="$(new_bot kt-f01-2)"
  marker="F01-2-OK-$RANDOM"
  raw "Bot \`$bot\`. Procedure: warm-up bash call, \`docker restart $CONTAINER\`, immediately ask for \`uname -a\` + marker \`$marker\` (does not wait for spacesd: the Space handle must reconnect by itself, backoff ≤ 60 s)."
  raw ""; raw "Timeline:"; raw ""
  submit "$bot" "Use the bash tool to run: echo warmup; whoami" >/dev/null
  wait_final "$bot" 150 || { summary "$bot" | block text; finish F01-2 FAIL "warm-up call failed"; return; }
  note "warm-up done"
  before="$(container_started_at)"
  docker restart "$CONTAINER" >/dev/null
  after="$(container_started_at)"
  note "docker restart done (StartedAt $before -> $after)"
  submit "$bot" "Use the bash tool to run exactly: uname -a; echo $marker . Then tell me the kernel name and the marker." >/dev/null
  note "second task submitted right after restart"
  if ! wait_final "$bot" 240; then
    summary "$bot" | block text; finish F01-2 FAIL "no final answer after container restart"; return
  fi
  note "second task finished"
  raw ""; raw "Conversation entries:"; raw ""; summary "$bot" | block text
  local ok
  ok="$(entries "$bot" | jq -r --arg m "$marker" '[.[] | select(.kind == "pi.tool-result") | select(.model[0].isError == false) | select(.model[0].content | tostring | contains($m))] | length')"
  if [ "$before" != "$after" ] && [ "$ok" -ge 1 ]; then
    finish F01-2 PASS "bash after docker restart returned marker $marker without error (tool results matching: $ok)"
  else
    finish F01-2 FAIL "restarted=$([ "$before" != "$after" ] && echo yes || echo no), successful marker results=$ok"
  fi
}

# =====================================================================================================================
# F01-3  kill -9 server AND docker restart at the same time
# =====================================================================================================================
f01_3() {
  begin_section "F01-3" "kill -9 server and docker restart simultaneously"
  local bot cmd
  ensure_server || { finish F01-3 FAIL "server not available"; return; }
  bot="$(new_bot kt-f01-3)"
  cmd="$(printf "$LONG_CMD" kt-f01-3)"
  raw "Bot \`$bot\`. Same long command as F01-1. Procedure: when it is running, in parallel \`pkill -9\` the server and \`docker restart $CONTAINER\`; start the server immediately (while the container is still booting)."
  raw ""; raw "Timeline:"; raw ""
  submit "$bot" "Use the bash tool exactly once with this exact command (do not change it): $cmd . After the tool returns, reply in one sentence saying whether it completed and what you observed." >/dev/null
  note "task submitted to bot $bot"
  if ! wait_in_container 'seq 1 20' 150; then
    finish F01-3 FAIL "long bash command did not start"; return
  fi
  sleep 4
  docker restart "$CONTAINER" >/dev/null 2>&1 &
  local rpid=$!
  kill9_server
  note "server killed -9 and docker restart issued at the same time"
  if ! start_server; then wait "$rpid" 2>/dev/null; finish F01-3 FAIL "server crashed/failed to start after the double kill"; return; fi
  note "server restarted (healthy) — docker restart still running: $(kill -0 "$rpid" 2>/dev/null && echo yes || echo no)"
  wait "$rpid" 2>/dev/null
  local http; http="$(curl -s -o "$WORK/bots.json" -w '%{http_code}' "$BASE/api/bots")"
  note "GET /api/bots -> HTTP $http, bots: $(jq -r 'map(.name) | length' "$WORK/bots.json" 2>/dev/null)"
  if [ "$http" != "200" ]; then finish F01-3 FAIL "/api/bots returned $http"; return; fi
  if ! wait_idle "$bot" 240; then
    summary "$bot" | block text; finish F01-3 FAIL "bot still busy 240 s after restart"; return
  fi
  local st intr; st="$(final_state "$bot")"; intr="$(interrupted_results "$bot" | tr '\n' ' ' | sed 's/ *$//')"
  note "bot idle. final state: $st; interrupted/errored tool results: ${intr:-none}"
  raw ""; raw "Conversation entries after recovery:"; raw ""; summary "$bot" | block text
  raw ""; raw "Server log excerpt:"; raw ""; server_log_excerpt | block text
  # Human take-over: the bot must accept and complete a new instruction.
  local marker="F01-3-TAKEOVER-$RANDOM"
  wait_space_ready || { finish F01-3 FAIL "Space never became ready again"; return; }
  submit "$bot" "Use the bash tool to run exactly: echo $marker . Then repeat the marker." >/dev/null
  note "follow-up instruction submitted (manual take-over check)"
  if ! wait_final "$bot" 240; then
    summary "$bot" | block text; finish F01-3 FAIL "bot did not answer the follow-up"; return
  fi
  local ok
  ok="$(entries "$bot" | jq -r --arg m "$marker" '[.[] | select(.kind == "pi.tool-result") | select(.model[0].isError == false) | select(.model[0].content | tostring | contains($m))] | length')"
  raw ""; raw "Follow-up conversation tail:"; raw ""; summary "$bot" | tail -4 | block text
  if [ "$ok" -ge 1 ] && { [ "$st" = "FINAL" ] || [ -n "$intr" ]; }; then
    finish F01-3 PASS "server+container double kill survived; /api/bots 200; recovered state '$st' (interrupted results: ${intr:-none}); follow-up executed ($marker)"
  else
    finish F01-3 FAIL "state='$st' interrupted='${intr:-none}' follow-up results=$ok"
  fi
}

# =====================================================================================================================
# F04-0/1  persistence of /home/cua and of the Chromium profile across a container restart
# =====================================================================================================================
f04() {
  begin_section "F04" "F04-0/1: home volume and Chromium profile survive a container restart"
  local marker="F04-$RUN-$RANDOM" cookie="tars_session_$RANDOM"
  raw "Volume: \`$(docker inspect -f '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{end}}' "$CONTAINER")\`"
  raw ""; raw "Timeline:"; raw ""
  docker exec -u cua -e HOME=/home/cua "$CONTAINER" sh -c "mkdir -p /home/cua/work && echo '$marker' > /home/cua/work/f04-persist.txt"
  note "F04-0: wrote /home/cua/work/f04-persist.txt = $marker"
  # F04-1: a real Chromium session stores a cookie (what a login does) in ~/.config/chromium.
  docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e COOKIE="$cookie" "$CONTAINER" sh -c '
cat > /tmp/cookie_srv.py <<PY
import http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Set-Cookie", os.environ["COOKIE"] + "=LOGGED_IN; Max-Age=86400; Path=/")
        self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(b"<html><body>login ok</body></html>")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 18099), H).serve_forever()
PY
python3 /tmp/cookie_srv.py & SRV=$!
sleep 1
(nohup chromium --no-sandbox http://127.0.0.1:18099/ >/tmp/chromium.log 2>&1 &)
for i in $(seq 1 60); do
  python3 - "$COOKIE" <<PY2 && break
import sqlite3, sys
c = sqlite3.connect("file:/home/cua/.config/chromium/Default/Cookies?mode=ro", uri=True)
sys.exit(0 if c.execute("select count(*) from cookies where name=?", (sys.argv[1],)).fetchone()[0] else 1)
PY2
  sleep 1
done
pkill -TERM -x chromium; for i in $(seq 1 20); do pgrep -x chromium >/dev/null || break; sleep 1; done
pkill -KILL -x chromium 2>/dev/null; kill $SRV 2>/dev/null; true'
  cookie_query() {
    docker exec -i -u cua -e HOME=/home/cua "$CONTAINER" python3 - "$cookie" <<'PY'
import sqlite3, sys
c = sqlite3.connect("file:/home/cua/.config/chromium/Default/Cookies?mode=ro", uri=True)
rows = c.execute("select host_key, name, length(encrypted_value) > 0 from cookies where name=?", (sys.argv[1],)).fetchall()
print(rows if rows else "NO COOKIE")
PY
  }
  local list_before cookie_before hash_before list_after cookie_after hash_after
  list_before="$(docker exec -u cua "$CONTAINER" sh -c 'ls /home/cua/.config/chromium | head -40')"
  hash_before="$(docker exec -u cua "$CONTAINER" sh -c 'sha256sum "/home/cua/.config/chromium/Local State" | cut -c1-16')"
  cookie_before="$(cookie_query)"
  note "F04-1: before restart: cookie $cookie -> $cookie_before; Local State sha256[:16]=$hash_before; profile entries: $(printf '%s\n' "$list_before" | wc -l | tr -d ' ')"
  raw ""; raw "\`ls ~/.config/chromium\` before restart:"; raw ""; printf '%s\n' "$list_before" | block text
  docker restart "$CONTAINER" >/dev/null
  wait_space_ready || { finish F04 FAIL "Space did not come back after restart"; return; }
  note "container restarted and ready"
  local file_after
  file_after="$(docker exec -u cua "$CONTAINER" cat /home/cua/work/f04-persist.txt 2>&1)"
  list_after="$(docker exec -u cua "$CONTAINER" sh -c 'ls /home/cua/.config/chromium | head -40')"
  hash_after="$(docker exec -u cua "$CONTAINER" sh -c 'sha256sum "/home/cua/.config/chromium/Local State" | cut -c1-16')"
  cookie_after="$(cookie_query)"
  note "F04-0: after restart file content: $file_after"
  note "F04-1: after restart: cookie -> $cookie_after; Local State sha256[:16]=$hash_after"
  raw ""; raw "\`ls ~/.config/chromium\` after restart:"; raw ""; printf '%s\n' "$list_after" | block text
  raw ""; raw "Limitation: a login on a real website cannot be automated here (credentials, 2FA, bot detection). The test instead has Chromium store a cookie from a local server, which is the same mechanism (profile cookie DB in \`~/.config/chromium\`, on the persistent volume). The cookie value is encrypted by Chromium and is not read."
  if [ "$file_after" = "$marker" ] && [ "$cookie_before" = "$cookie_after" ] && [ "$cookie_after" != "NO COOKIE" ] && [ "$list_before" = "$list_after" ]; then
    finish F04 PASS "file content and Chromium profile (listing, cookie $cookie) identical after container restart"
  else
    finish F04 FAIL "file='$file_after' cookie_before='$cookie_before' cookie_after='$cookie_after' listing_equal=$([ "$list_before" = "$list_after" ] && echo yes || echo no)"
  fi
}

# ---- main ------------------------------------------------------------------------------------------------------------
WANT=("$@"); [ ${#WANT[@]} -gt 0 ] || WANT=(F01-1 F01-2 F01-3 F04)
want() { local w; for w in "${WANT[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }

"$ROOT/scripts/space-up.sh" || { echo "space-up failed" >&2; exit 2; }
ensure_server || exit 2

want F01-1 && f01_1
want F01-2 && f01_2
want F01-3 && f01_3
want F04 && f04

# leave a healthy server running
ensure_server
API_SPACE="$(curl -s "$BASE/api/space" | jq -c '{name, viewerUrl, id: .info.id}' 2>/dev/null)"

{
  echo "# TARSBot crash-recovery test (WP5)"
  echo
  echo "Generated by \`scripts/kill-test.sh\` on $(date '+%Y-%m-%d %H:%M:%S %z'), run id \`$RUN\`."
  echo
  echo "- Server: \`${SERVER_CMD[*]}\`, log \`logs/server-$RUN.log\`"
  echo "- Space: container \`$CONTAINER\` (image \`$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" | cut -c1-80)\`), restart policy \`$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")\`, volume \`$(docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}}{{end}}' "$CONTAINER")\`"
  echo "- \`GET /api/space\` after the run: \`$API_SPACE\`"
  echo "- Model: \`${TARSBOT_MODEL:-glm-5.3}\` via tokenrouter (key from the environment, never printed)"
  echo
  echo "## Summary"
  echo
  echo "| Scenario | Result |"
  echo "|---|---|"
  for f in "$WORK"/*.result; do [ -e "$f" ] && printf '| %s | %s |\n' "$(basename "$f" .result)" "$(cat "$f")"; done
  for f in "$WORK"/*.md; do [ -e "$f" ] && cat "$f"; done
} >"$DOC"

echo
echo "evidence: $DOC"
FAILED=0
for f in "$WORK"/*.result; do [ -e "$f" ] && [ "$(cat "$f")" != "PASS" ] && FAILED=1; done
exit "$FAILED"
