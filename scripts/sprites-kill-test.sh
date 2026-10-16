#!/usr/bin/env bash
# L3 durability acceptance for the Sprites (shell) mode — docs/tasks/S4-recovery.md, scenarios R1–R5.
# Needs: curl, jq, gh, python3, perl, lsof, node >= 24, a working model key in .env. GITHUB_TOKEN from .env is used only by the
# LOCAL gh (cleanup/verification) and, inside the server, as GH_TOKEN for the Bot; it is never printed. Output is scrubbed.
#
# The script manages the server itself (like scripts/kill-test.sh): it restarts it at the start with
#   TARSBOT_SPRITES_LOG=1 node --no-warnings src/server.mjs      (log: logs/server-sprites-kt-<RUN>.log)
# kills it with `kill -9` during the scenarios and leaves a healthy server running when it finishes.
# The kill only ever targets node processes started from this directory with that exact command line.
#
# Scenarios (every Bot gets its own branch  tarsbot/kt-<RUN>-R<n>[-t<attempt>]  in the TEST repository):
#   R1  L2-style task; kill -9 as soon as ~/workspace/tars-sandbox-playground/.git exists in the Sprite, restart.
#   R2  full PR flow, then "force push"; kill -9 while the approval is pending, restart; the same approval must come back.
#   R3  kill -9 as soon as the remote branch exists (target window: after push, before `gh pr create` finished). A kill that
#       lands after the PR exists is a MISS (not a pass, not a fail); retried with a new branch name.
#   R3B (extra) kill while the Bot's `gh pr create` is running (the PR may be created remotely while the tool result is lost).
#   R4  idle Bot until the Sprite status is "cold" and >= 3 min idle (max 10 min), then a new instruction.
#   R5  grep -F for the secret values in data/ logs/ docs/sprites-*.md docs/acceptance/ (only file names are printed).
# Each scenario runs at most 3 attempts; every attempt (PASS / FAIL / MISS) is kept in the report docs/sprites-recovery-test.md.
#
# Cleanup (before each attempt and at the end) touches ONLY this run's PRs/branches: head prefix  tarsbot/kt-<RUN>-  in the
# hard-coded repository hifizz/tars-sandbox-playground (PRs #1-#3 and their branches are evidence and are never touched; the script
# checks at the end that they are unchanged). ~/workspace/tars-sandbox-playground in the Sprite is deleted before each attempt.
#
# Env: KT_PREVIOUS_REPORT=<file> appends an earlier report to the new one as an appendix.
# Usage: scripts/sprites-kill-test.sh [R1 R2 R3 R3B R4 R5]     (default: all; R3B = extra: kill while `gh pr create` is running)
# Exit code: 0 = all PASS, 1 = some scenario FAIL / inconclusive, 2 = precondition failed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUN="$(date +%Y%m%d-%H%M%S)"
BASE="${TARSBOT_URL:-http://127.0.0.1:8090}"
REPO="hifizz/tars-sandbox-playground"     # hard-coded and re-validated: cleanup never touches another repository
SPRITE_NAME="pi-cloud-agents"
BASE_BRANCH="dev"
REPO_DIR_SPRITE='$HOME/workspace/tars-sandbox-playground'
PREFIX="tarsbot/kt-${RUN}-"
TARGET_FILE="src/ext/history.mjs"
OLD_LINE='const DEFAULT_LIMIT = 10;'
NEW_LINE='const DEFAULT_LIMIT = 20;'
EVIDENCE_PRS="1 2 3"                       # PRs from earlier acceptance runs: must stay open and untouched
SERVER_PATTERN="node --no-warnings src/server.mjs"
LOG="$ROOT/logs/server-sprites-kt-$RUN.log"
DOC="$ROOT/docs/sprites-recovery-test.md"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SECTION=""; LOGMARK=1; CHECKS=""; FAILS=0
SCEN_IDS=()
mkdir -p "$ROOT/logs" "$ROOT/docs"
: >"$LOG"

# ---- secrets: only for the local gh and for scrubbing; never echoed ---------------------------------------------------------
set -a
# shellcheck disable=SC1091
. "$ROOT/.env" 2>/dev/null
set +a
[ -n "${GITHUB_TOKEN:-}" ] || { echo "GITHUB_TOKEN is not set in .env" >&2; exit 2; }
[ "${TARSBOT_SPRITE_NAME:-}" = "$SPRITE_NAME" ] || { echo "TARSBOT_SPRITE_NAME must be exactly $SPRITE_NAME" >&2; exit 2; }
[ "$REPO" = "hifizz/tars-sandbox-playground" ] || { echo "refusing: repository is not the test repository" >&2; exit 2; }
ghx() { GH_TOKEN="$GITHUB_TOKEN" gh "$@"; }
scrub() {
  python3 -c '
import sys, os, re
s = sys.stdin.read()
for k in ("GITHUB_TOKEN", "SPRITES_TOKEN", "TOKEN_ROUTER_API_KEY", "EXA_API_KEY"):
    v = os.environ.get(k, "")
    if len(v) >= 8:
        s = s.replace(v, "<redacted>")
s = re.sub(r"(github_pat_|ghp_|gho_|ghs_|ghu_)[A-Za-z0-9_]{10,}", "<redacted>", s)
sys.stdout.write(s)' 2>/dev/null || cat
}

# ---- tiny doc/console helpers ---------------------------------------------------------------------------------------------
ts() { date +%H:%M:%S; }
ts_ms() { perl -MTime::HiRes=time -MPOSIX=strftime -e '$t = time; printf "%s.%03d", strftime("%H:%M:%S", localtime($t)), ($t * 1000) % 1000'; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }
note() { printf -- '- `%s` %s\n' "$(ts)" "$*" >>"$SECTION"; echo "[$(ts)] $*" | scrub; }
block() { { printf '```%s\n' "$1"; cat; printf '```\n\n'; } >>"$SECTION"; }
raw() { printf '%s\n' "$*" >>"$SECTION"; }
begin_section() { # $1 = id (R1.1), $2 = title
  SECTION="$WORK/$1.md"; CHECKS="$WORK/$1.checks"; FAILS=0
  : >"$SECTION"; : >"$CHECKS"
  LOGMARK=$(($(wc -l <"$LOG") + 1))
  printf '\n## %s — %s\n\n' "$1" "$2" >>"$SECTION"
  echo; echo "=== $1: $2"
}
check() { # $1 = name, $2 = PASS|FAIL|INFO, $3 = detail
  printf '| %s | %s | %s |\n' "$1" "$2" "$(printf '%s' "$3" | tr '\n|' '  ' | cut -c1-400)" >>"$CHECKS"
  echo "  [$2] $1 — $(printf '%s' "$3" | tr '\n' ' ' | cut -c1-200)" | scrub
  [ "$2" = FAIL ] && FAILS=$((FAILS + 1))
  return 0
}
finish() { # $1 = id, $2 = PASS|FAIL|MISS, $3 = reason
  if [ -s "$CHECKS" ]; then
    { printf '\n### Checks\n\n| Check | Result | Detail |\n|---|---|---|\n'; cat "$CHECKS"; } >>"$SECTION"
  fi
  printf '\n**Result: %s** — %s\n' "$2" "$3" >>"$SECTION"
  echo "$2 $1 — $3" | scrub
  echo "$2" >"$WORK/$1.result"; echo "$3" >"$WORK/$1.detail"
}
verdict() { # $1 = id; PASS when no check failed (a MISS has already been handled by the caller)
  if [ "$FAILS" = 0 ]; then finish "$1" PASS "all checks passed"; else finish "$1" FAIL "$FAILS check(s) failed"; fi
}

# ---- server management (never touches a process that was not started from $ROOT with the exact command line) -----------
server_pids() {
  local p
  for p in $(pgrep -f "$SERVER_PATTERN" 2>/dev/null || true); do
    case "$(ps -o command= -p "$p" 2>/dev/null)" in
      "$SERVER_PATTERN"*) lsof -a -p "$p" -d cwd -Fn 2>/dev/null | grep -qx "n$ROOT" && echo "$p" ;;
    esac
  done
}
server_up() { curl -sf --max-time 3 "$BASE/api/health" >/dev/null 2>&1; }
stop_server_term() {
  local p
  for p in $(server_pids); do kill -TERM "$p" 2>/dev/null; done
  for _ in $(seq 1 30); do [ -z "$(server_pids)" ] && return 0; sleep 0.5; done
  for p in $(server_pids); do kill -9 "$p" 2>/dev/null; done
  sleep 1
}
kill9_server() {
  local p
  for p in $(server_pids); do kill -9 "$p" 2>/dev/null; done
  for _ in $(seq 1 40); do [ -z "$(server_pids)" ] && return 0; sleep 0.1; done
  return 1
}
start_server() { # waits for /api/health
  [ -z "$(server_pids)" ] || stop_server_term
  echo "----- server start $(ts_ms) -----" >>"$LOG"
  (cd "$ROOT" && TARSBOT_SPRITES_LOG=1 nohup node --no-warnings src/server.mjs </dev/null >>"$LOG" 2>&1 &)
  for _ in $(seq 1 90); do server_up && return 0; sleep 1; done
  echo "server did not become healthy; log tail:" >&2
  tail -20 "$LOG" | scrub >&2
  return 1
}
ensure_server() { { server_up && [ -n "$(server_pids)" ]; } || start_server; }
restart_after_kill() { # $1 = label; kill -9, restart, return after healthy
  local t_kill
  KILL_MS="$(now_ms)"; t_kill="$(ts_ms)"
  kill9_server; KILL_DONE_MS="$(now_ms)"
  note "kill -9 server at $t_kill (pids left: '$(server_pids)'; kill took $((KILL_DONE_MS - KILL_MS)) ms) — $1"
}

# ---- API helpers ---------------------------------------------------------------------------------------------------------
api() { curl -sS --max-time 30 "$@"; }
new_bot() { # $1 = name -> prints bot id
  api -X POST "$BASE/api/bots" -H 'content-type: application/json' -d "{\"name\":\"$1\"}" | jq -r '.id'
}
submit() { jq -n --arg t "$2" '{text:$t}' | api -X POST "$BASE/api/bots/$1/input" -H 'content-type: application/json' -d @-; }
entries() { api "$BASE/api/bots/$1/entries?limit=1000"; }
bot_busy() { api "$BASE/api/bots" 2>/dev/null | jq -r --arg id "$1" '.[] | select(.id == $id) | (.busy or (.queued > 0))' 2>/dev/null; }
bot_cid() { api "$BASE/api/bots" | jq -r --arg id "$1" '.[] | select(.id == $id) | .conversationId'; }
final_state() {
  entries "$1" | jq -r 'map(select(.kind != "pi.system")) | last | if .kind == "pi.assistant" and (.model[0].stopReason == "stop") and ([.model[0].content[] | select(.type == "text")] | length > 0) then "FINAL" else (.kind + ":" + ((.model[0].stopReason // .model[0].toolName // "") | tostring)) end' 2>/dev/null
}
final_text() { entries "$1" | jq -r '[.[] | select(.kind == "pi.assistant") | ([.model[0].content[] | select(.type == "text") | .text] | join("\n")) | select(length > 0)] | last // ""'; }
JQ_SUMMARY='
.[] | . as $e | ($e.model[0] // {}) as $m
| select($e.kind != "pi.system")
| "\($e.id)\t\($e.kind)\t" + (
    if $e.kind == "pi.user" then (($m.content | if type == "string" then . else tostring end) | .[0:260])
    elif $e.kind == "pi.assistant" then
      "stop=\($m.stopReason) " + ([$m.content[] | if .type == "text" then "text: " + (.text | .[0:260]) elif .type == "toolCall" then "call: " + .name + " " + (.arguments | tostring | .[0:240]) else empty end] | join(" | "))
    elif $e.kind == "pi.tool-result" then
      "tool=\($m.toolName) isError=\($m.isError) diag=[" + (($e.data.diagnostics // []) | map(.code // "?") | join(",")) + "] :: " + ([$m.content[] | select(.type == "text") | .text] | join(" ") | gsub("\n"; "\\n") | .[0:240])
    else "" end)'
summary() { entries "$1" | jq -r "$JQ_SUMMARY"; }
# Tool results joined with their calls. TSV: entry id, pre|post (relative to the kill, by message timestamp), tool, duration ms,
# isError, diagnostics codes, command, result start.
JQ_TRACE='
  (reduce .[] as $e ({}; if $e.kind == "pi.assistant" then reduce ($e.model[0].content[]? | select(.type == "toolCall")) as $c (.; .[$c.id] = $c) else . end)) as $calls
  | .[] | select(.kind == "pi.tool-result") | . as $e | $e.model[0] as $m | ($calls[$m.toolCallId] // {}) as $c
  | [ ($e.id | tostring),
      (if (($m.timestamp // 0) > $kill) then "post" else "pre" end),
      $m.toolName,
      (($m.details.tarsbotTiming.durationMs // $e.data.details.tarsbotTiming.durationMs // "") | tostring),
      ($m.isError | tostring),
      (($e.data.diagnostics // []) | map(.code // "?") | join(",")),
      ((($c.arguments.command // ($c.arguments | tostring)) // "") | gsub("[\\n\\t]"; " ") | .[0:600]),
      (([$m.content[]? | select(.type == "text") | .text] | join(" ")) | gsub("[\\n\\t]"; " ") | .[0:220]) ] | @tsv'
trace_tsv() { entries "$1" | jq -r --argjson kill "${2:-0}" "$JQ_TRACE"; }
trace_table() { # stdin = TSV
  echo "| Entry | When | Tool | Duration | Error | Diagnostics | Command | Result (start) |"
  echo "|---|---|---|---|---|---|---|---|"
  awk -F'\t' '{ d = ($4 == "") ? "-" : sprintf("%.1fs", $4 / 1000); c = $7; r = $8; gsub(/\|/, "\\|", c); gsub(/\|/, "\\|", r);
    if (length(c) > 240) c = substr(c, 1, 240) "…"; printf "| %s | %s | %s | %s | %s | %s | `%s` | %s |\n", $1, $2, $3, d, $5, ($6 == "" ? "-" : $6), c, r }'
}
is_interrupted_row() { awk -F'\t' '$6 ~ /interrupted|orphaned|aborted/ || $8 ~ /was interrupted/'; }

# ---- sprite helpers (through src/sandbox/sprites.mjs; never through the Bot) -------------------------------------------------
sx() { node --env-file=.env scratch/sprite-exec.mjs exec "$@"; }
sx_status() { node --env-file=.env scratch/sprite-exec.mjs status 2>/dev/null; }
reset_sprite_repo() { sx --timeout-ms 60000 "rm -rf $REPO_DIR_SPRITE && echo removed" 2>&1 | tr '\n' ' '; }
sprite_snapshot() { # state of the clone in the Sprite
  sx --timeout-ms 30000 "d=$REPO_DIR_SPRITE; ls -a \$d 2>&1 | head -12 | tr '\n' ' '; echo; echo -n 'git: '; git -C \$d status -sb 2>&1 | head -4 | tr '\n' '|'; echo; echo -n 'log: '; git -C \$d log --oneline -4 2>&1 | tr '\n' '|'; echo; echo -n 'git/gh/npm processes: '; ps -eo pid,etimes,args 2>/dev/null | grep -E '[g]it (clone|push|fetch|pull|commit)|[g]h pr|[n]pm (install|test)' | cut -c1-110 | head -5 | tr '\n' '|'; echo" 2>&1
}

# ---- GitHub (test repository only) ---------------------------------------------------------------------------------------
LEDGER="$WORK/ledger.tsv"; : >"$LEDGER"
validate_repo() { [ "$(ghx api "repos/$REPO" --jq .full_name 2>/dev/null)" = "hifizz/tars-sandbox-playground" ]; }
# Closes this run's open PRs and deletes this run's branches. Every PR/branch is recorded in the ledger first.
cleanup_remote() {
  validate_repo || { echo "cleanup refused: cannot validate repository $REPO" >&2; return 1; }
  local n head state ref
  while IFS=$'\t' read -r n head state; do
    [ -n "$n" ] || continue
    case "$head" in "${PREFIX}"*) ;; *) continue ;; esac
    printf 'PR\t#%s\t%s\t%s\n' "$n" "$head" "$state" >>"$LEDGER"
    if [ "$state" = OPEN ]; then
      if ghx pr close -R "$REPO" "$n" >/dev/null 2>&1; then echo "  cleanup: closed PR #$n ($head)"; else echo "  cleanup: FAILED to close PR #$n" >&2; fi
    fi
  done < <(ghx pr list -R "$REPO" --state all --limit 100 --json number,headRefName,state --jq '.[] | [.number, .headRefName, .state] | @tsv' 2>/dev/null)
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    case "$ref" in "refs/heads/${PREFIX}"*) ;; *) echo "  cleanup: refusing foreign ref $ref" >&2; continue ;; esac
    printf 'BRANCH\t%s\t\t\n' "${ref#refs/heads/}" >>"$LEDGER"
    if ghx api -X DELETE "repos/$REPO/git/$ref" >/dev/null 2>&1; then echo "  cleanup: deleted branch ${ref#refs/heads/}"; else echo "  cleanup: FAILED to delete $ref" >&2; fi
  done < <(ghx api "repos/$REPO/git/matching-refs/heads/${PREFIX}" --jq '.[].ref' 2>/dev/null)
}
remote_leftovers() { # count of this run's open PRs + branches still present
  local a b
  a="$(ghx pr list -R "$REPO" --state open --limit 100 --json headRefName --jq "[.[] | select(.headRefName | startswith(\"$PREFIX\"))] | length" 2>/dev/null)"
  b="$(ghx api "repos/$REPO/git/matching-refs/heads/${PREFIX}" --jq 'length' 2>/dev/null)"
  echo "open_prs=${a:-?} branches=${b:-?}"
}
evidence_state() { # one line per evidence PR + its branch: state and head SHA
  local n
  for n in $EVIDENCE_PRS; do
    ghx pr view -R "$REPO" "$n" --json number,state,headRefName,headRefOid --jq '"#\(.number) \(.state) \(.headRefName) \(.headRefOid[0:12])"' 2>/dev/null || echo "#$n unreadable"
  done
}
branch_sha() { local o; o="$(ghx api "repos/$REPO/git/ref/heads/$1" --jq .object.sha 2>/dev/null)" && printf '%s' "$o"; }  # empty when absent (gh prints the 404 body on stdout)

prepare_attempt() { # clean remote + Sprite dir, make sure the server is up. Prints what it did.
  ensure_server || return 1
  note "cleanup: $(cleanup_remote 2>&1 | tr '\n' ';')"
  note "Sprite: remove ~/workspace/tars-sandbox-playground -> $(reset_sprite_repo)"
}

# ---- approvals ------------------------------------------------------------------------------------------------------------
SEEN="$WORK/seen-approvals"; : >"$SEEN"
# Approval policy while a scenario runs unattended: approve ONLY a recursive delete of the clone directory in the Sprite
# (the natural recovery from a half-finished clone); deny everything else. APPROVAL_MODE=deny denies everything.
APPROVAL_MODE=auto
auto_approvals() { # $1 = conversationId; $2 = file the decisions are appended to (TSV)
  local cid="$1" out="$2" item id reason tool cmd approve code
  while IFS= read -r item; do
    [ -n "$item" ] || continue
    id="$(jq -r '.taskId' <<<"$item")"
    grep -qxF "$id" "$SEEN" && continue
    echo "$id" >>"$SEEN"
    reason="$(jq -r '.reason' <<<"$item")"; tool="$(jq -r '.toolName' <<<"$item")"
    cmd="$(jq -r '.args.command // (.args | tostring)' <<<"$item" | tr '\n|' '  ' | cut -c1-300)"
    approve=false
    if [ "$APPROVAL_MODE" = auto ] && [ "$tool" = bash ] && case "$reason" in "recursive force delete"*) true ;; *) false ;; esac \
       && printf '%s' "$cmd" | grep -Eq 'rm -rf (~|\$HOME|/home/sprite)/workspace/tars-sandbox-playground/?( |$|;|&)' \
       && ! printf '%s' "$cmd" | grep -Eq 'git .*push|gh (pr|api|repo)|rm .*(\.\.|/\*)'; then
      approve=true
    fi
    code="$(api -o /dev/null -w '%{http_code}' -X POST "$BASE/api/approvals/$id" -H 'content-type: application/json' -d "{\"approved\":$approve}")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(ts)" "$id" "$tool" "$([ "$approve" = true ] && echo approved || echo denied)" "$reason" "$cmd" >>"$out"
    note "approval $id ($tool: $reason) -> $([ "$approve" = true ] && echo APPROVED || echo denied) (HTTP $code); command: $cmd"
  done < <(api "$BASE/api/approvals" 2>/dev/null | jq -c --arg c "$cid" '.[]? | select((.conversationId | tostring) == $c)' 2>/dev/null)
}
# Wait for the bot to be idle with a final assistant answer (3 stable polls); approvals are handled meanwhile. $3 = approvals file.
wait_run() { # $1 = bot, $2 = limit seconds, $3 = approvals tsv
  local bot="$1" limit="$2" out="$3" cid stable=0 start=$SECONDS
  cid="$(bot_cid "$bot")"
  while [ $((SECONDS - start)) -lt "$limit" ]; do
    auto_approvals "$cid" "$out"
    if [ "$(bot_busy "$bot")" = "false" ] && [ "$(final_state "$bot")" = "FINAL" ]; then
      stable=$((stable + 1)); [ "$stable" -ge 3 ] && return 0
    else
      stable=0
    fi
    sleep 1
  done
  return 1
}
approvals_md() { # $1 = tsv -> markdown rows
  if [ -s "$1" ]; then
    echo "| Time | Task id | Tool | Decision | Reason | Command |"; echo "|---|---|---|---|---|---|"
    awk -F'\t' '{ c = $6; gsub(/\|/, "\\|", c); printf "| %s | %s | %s | %s | %s | `%s` |\n", $1, $2, $3, $4, $5, c }' "$1"
  else
    echo "No approval appeared."
  fi
}

# ---- scenario building blocks --------------------------------------------------------------------------------------------
pr_task() { # $1 = branch
  printf '在 %s 仓库的 %s 分支基础上，把 %s 里的 `%s` 改成 `%s`（只改这一行，不要动其他文件）。分支名用 %s。改完后运行 npm test 确认全部通过，然后提交并开 PR（base 用 %s），最后回复 PR 链接。' \
    "$REPO" "$BASE_BRANCH" "$TARGET_FILE" "$OLD_LINE" "$NEW_LINE" "$1" "$BASE_BRANCH"
}
branch_for() { # $1 = scenario number (R1), $2 = attempt
  if [ "$2" = 1 ]; then echo "${PREFIX}$1"; else echo "${PREFIX}$1-t$2"; fi
}
PR_NUM=""; PR_URL=""; PR_STATE=""; PR_CREATED=""; AHEAD=""
# Verifies the PR flow result for a branch (shared by R1, R2, R3). Adds checks.
verify_pr_flow() { # $1 = branch, $2 = bot
  local branch="$1" bot="$2" json n reply links cmp dup changed files last_line
  PR_NUM=""; PR_URL=""; PR_STATE=""; PR_CREATED=""; AHEAD=""
  json="$(ghx pr list -R "$REPO" --head "$branch" --state all --json number,state,baseRefName,headRefName,url,createdAt,body 2>/dev/null)"
  n="$(jq 'length' <<<"$json" 2>/dev/null)"
  if [ "$n" = 1 ]; then
    PR_NUM="$(jq -r '.[0].number' <<<"$json")"; PR_URL="$(jq -r '.[0].url' <<<"$json")"; PR_STATE="$(jq -r '.[0].state' <<<"$json")"; PR_CREATED="$(jq -r '.[0].createdAt' <<<"$json")"
    check "exactly one PR for the branch (all states)" PASS "#$PR_NUM $PR_URL"
    [ "$PR_STATE" = OPEN ] && check "the PR is open" PASS "state=OPEN" || check "the PR is open" FAIL "state=$PR_STATE"
    [ "$(jq -r '.[0].baseRefName' <<<"$json")" = "$BASE_BRANCH" ] && check "PR base is $BASE_BRANCH" PASS "base=$BASE_BRANCH" || check "PR base is $BASE_BRANCH" FAIL "base=$(jq -r '.[0].baseRefName' <<<"$json")"
    last_line="$(jq -r '.[0].body | gsub("\\s+$"; "") | split("\n") | last // ""' <<<"$json")"
    case "$last_line" in *"Opened by TARSBot"*) check "PR body ends with 'Opened by TARSBot'" PASS "$last_line" ;; *) check "PR body ends with 'Opened by TARSBot'" FAIL "last line: $last_line" ;; esac
  else
    check "exactly one PR for the branch (all states)" FAIL "found ${n:-?} PR(s): $(jq -r 'map("#\(.number) \(.state)") | join(", ")' <<<"$json" 2>/dev/null)"
  fi
  reply="$(final_text "$bot")"
  links="$(printf '%s' "$reply" | grep -oE "https://github.com/$REPO/pull/[0-9]+" | sort -u | tr '\n' ' ')"
  if [ -n "$PR_NUM" ] && [ "$(printf '%s' "$links" | wc -w | tr -d ' ')" = 1 ] && [ "$(basename "$links" | tr -d ' ')" = "$PR_NUM" ]; then
    check "Bot's final reply contains the correct PR link" PASS "$links"
  else
    check "Bot's final reply contains the correct PR link" FAIL "PR=#${PR_NUM:-none}; links in reply: ${links:-none}"
  fi
  cmp="$(ghx api "repos/$REPO/compare/${BASE_BRANCH}...${branch}" 2>/dev/null)"
  if [ -n "$cmp" ] && jq -e .ahead_by >/dev/null 2>&1 <<<"$cmp"; then
    AHEAD="$(jq -r .ahead_by <<<"$cmp")"
    dup="$(jq '[.commits[].commit.message | split("\n")[0]] | group_by(.) | map(select(length > 1)) | length' <<<"$cmp")"
    note "remote branch vs $BASE_BRANCH: ahead_by=$AHEAD; commits: $(jq -r '[.commits[] | "\(.sha[0:7]) \(.commit.message | split("\n")[0])"] | join(" / ")' <<<"$cmp")"
    [ "$dup" = 0 ] && [ "$AHEAD" -ge 1 ] && check "no duplicate commit messages on the branch" PASS "ahead_by=$AHEAD, duplicated messages: 0" || check "no duplicate commit messages on the branch" FAIL "ahead_by=$AHEAD, duplicated messages: $dup"
    files="$(jq -r '[.files[].filename] | join(",")' <<<"$cmp")"
    changed="$(jq -r '.files[].patch // empty' <<<"$cmp" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)')"
    if [ "$files" = "$TARGET_FILE" ] && [ "$changed" = "$(printf -- '-%s\n+%s' "$OLD_LINE" "$NEW_LINE")" ]; then
      check "diff contains only the expected change" PASS "$TARGET_FILE: -${OLD_LINE} +${NEW_LINE}"
    else
      check "diff contains only the expected change" FAIL "files=[$files] changed: $(printf '%s' "$changed" | tr '\n' ' ' | cut -c1-200)"
    fi
  else
    check "no duplicate commit messages on the branch" FAIL "remote branch $branch missing or compare failed"
  fi
}
leak_in_entries() { # $1 = bot
  if entries "$1" | grep -qF "$GITHUB_TOKEN"; then check "GITHUB_TOKEN absent from the conversation entries" FAIL "value found in entries"; else check "GITHUB_TOKEN absent from the conversation entries" PASS "not found"; fi
}
# Automatic observations about the recovery, from the trace TSV ($1 = file).
observe_recovery() {
  local f="$1" n_int n_commit n_push n_create n_clone dupcmd errs
  n_int="$(is_interrupted_row <"$f" | wc -l | tr -d ' ')"
  n_commit="$(awk -F'\t' '$7 ~ /git commit/ && $5 == "false" && $6 == ""' "$f" | wc -l | tr -d ' ')"
  n_push="$(awk -F'\t' '$7 ~ /git push/ && $5 == "false" && $6 == ""' "$f" | wc -l | tr -d ' ')"
  n_create="$(awk -F'\t' '$7 ~ /gh pr create/ && $5 == "false" && $6 == ""' "$f" | wc -l | tr -d ' ')"
  n_clone="$(awk -F'\t' '$7 ~ /git clone/' "$f" | wc -l | tr -d ' ')"
  dupcmd="$(awk -F'\t' '$5 == "false" && $6 == "" { c[$7]++ } END { for (k in c) if (c[k] > 1) printf "%dx %s\n", c[k], substr(k, 1, 160) }' "$f")"
  errs="$(awk -F'\t' '$8 ~ /already exists|not an empty|fatal:|nothing to commit|rejected|non-fast-forward/ { printf "entry %s (%s): %s\n", $1, $2, substr($8, 1, 150) }' "$f")"
  raw ""; raw "Automatic observations:"; raw ""
  raw "- tool results marked interrupted: **$n_int** $(is_interrupted_row <"$f" | awk -F'\t' '{printf "[entry %s, %s: `%s`] ", $1, $2, substr($7, 1, 100)}')"
  raw "- \`git clone\` calls (any outcome): $n_clone; successful \`git commit\`: $n_commit; successful \`git push\`: $n_push; successful \`gh pr create\`: $n_create"
  raw "- identical commands that succeeded more than once (possible re-execution of a completed step):"; raw ""
  printf '%s\n' "${dupcmd:-none}" | block text
  raw "- results mentioning already-exists / not-empty / fatal / nothing-to-commit / rejected:"; raw ""
  printf '%s\n' "${errs:-none}" | block text
  OBS_INT="$n_int"; OBS_COMMIT="$n_commit"; OBS_PUSH="$n_push"; OBS_CREATE="$n_create"
}
server_log_excerpt() { tail -n "+${LOGMARK:-1}" "$LOG" | grep -vE '^\[sprites\]' | grep -E 'resume|listening|fatal|rror|server start|interrupt' | cut -c1-240 | tail -12; }
sprites_log_stats() { # count/slowest of [sprites] log lines since the attempt began
  tail -n "+${LOGMARK:-1}" "$LOG" | grep -E '^\[sprites\] ' | sed 's/^\[sprites\] //' | jq -rs 'if length == 0 then "no [sprites] log lines" else "execs: \(length); retries>0: \([.[] | select(.retries > 0)] | length); outcomes: \([.[] | .outcome] | group_by(.) | map("\(.[0])=\(length)") | join(", ")); slowest: \(map(.ms) | max) ms" end' 2>/dev/null
}

# =====================================================================================================================
# R1 — kill -9 right after the clone directory shows up in the Sprite
# =====================================================================================================================
sc_R1() {
  local n="$1" id="R1.$1" branch bot found rem_at_kill snap st apptsv="$WORK/R1.$1.appr"
  branch="$(branch_for R1 "$n")"; : >"$apptsv"
  begin_section "$id" "kill -9 right after ~/workspace/tars-sandbox-playground/.git appears (attempt $n)"
  raw "Branch \`$branch\`. Procedure: clean up; delete the clone dir in the Sprite; new Bot gets the L2-style task; one Sprite exec waits (0.05 s polling inside the Sprite) until \`~/workspace/tars-sandbox-playground/.git\` exists; then \`kill -9\` the server and restart it. Expected: the task resumes and finishes; one open PR; no duplicate commits."
  raw ""; raw "Instruction: > $(pr_task "$branch")"; raw ""; raw "Timeline:"; raw ""
  prepare_attempt || { finish "$id" FAIL "precondition: server/cleanup"; return; }
  bot="$(new_bot "kt-R1-$n-$RUN")"
  [ -n "$bot" ] && [ "$bot" != null ] || { finish "$id" FAIL "could not create a Bot"; return; }
  submit "$bot" "$(pr_task "$branch")" >/dev/null
  note "Bot $bot created, task submitted"
  found="$(sx --timeout-ms 150000 'until [ -e "$HOME/workspace/tars-sandbox-playground/.git" ]; do sleep 0.05; done; echo FOUND' 2>&1 | tr -d '\n')"
  if [ "$found" != FOUND ]; then
    note ".git never appeared (got: $found)"; summary "$bot" | block text; finish "$id" FAIL "the Bot never created ~/workspace/tars-sandbox-playground/.git within 150 s"; return
  fi
  restart_after_kill "~/workspace/tars-sandbox-playground/.git exists"
  rem_at_kill="$(branch_sha "$branch")"
  snap="$(sprite_snapshot)"
  note "remote branch right after the kill: ${rem_at_kill:-absent}"
  raw ""; raw "Sprite right after the kill (the remote process may still run: the exec connection died with the server):"; raw ""; printf '%s\n' "$snap" | block text
  start_server || { finish "$id" FAIL "server did not restart"; return; }
  note "server restarted (healthy)"
  if wait_run "$bot" 600 "$apptsv"; then note "run finished (bot idle, final answer present)"; check "task resumed and finished after the restart" PASS "final answer within 600 s"; else
    check "task resumed and finished after the restart" FAIL "no final answer within 600 s; state $(final_state "$bot"); aborting the Bot"; api -X POST "$BASE/api/bots/$bot/abort" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1; fi
  [ -z "$rem_at_kill" ] && check "premise: the kill landed before the remote branch existed" PASS "remote branch absent ~0.5 s after the kill" || check "premise: the kill landed before the remote branch existed" FAIL "remote branch already existed after the kill"
  verify_pr_flow "$branch" "$bot"
  leak_in_entries "$bot"
  trace_tsv "$bot" "$KILL_MS" >"$WORK/$id.trace"
  raw ""; raw "Approvals:"; raw ""; approvals_md "$apptsv" | block text 2>/dev/null || true
  raw "Server log excerpt:"; raw ""; server_log_excerpt | block text
  raw "Sprites exec log: $(sprites_log_stats)"; raw ""
  raw "Tool results (When = relative to the kill, by timestamp):"; raw ""; trace_table <"$WORK/$id.trace" >>"$SECTION"; raw ""
  observe_recovery "$WORK/$id.trace"
  raw ""; raw "Final state of the clone in the Sprite:"; raw ""; sprite_snapshot | block text
  raw "Conversation:"; raw ""; summary "$bot" | block text
  raw "Bot's final reply: $(final_text "$bot" | tr '\n' ' ' | cut -c1-500)"
  if [ -n "$rem_at_kill" ]; then finish "$id" MISS "the kill landed after the remote branch existed (not the target window)"; else verdict "$id"; fi
}

# =====================================================================================================================
# R2 — kill -9 while the force-push approval is pending
# =====================================================================================================================
wait_approval() { # $1 = cid, $2 = limit seconds -> prints the approval JSON (first one whose reason mentions remote history)
  local cid="$1" limit="$2" start=$SECONDS item
  while [ $((SECONDS - start)) -lt "$limit" ]; do
    item="$(api "$BASE/api/approvals" 2>/dev/null | jq -c --arg c "$cid" '[.[]? | select((.conversationId | tostring) == $c)] | .[0] // empty' 2>/dev/null)"
    [ -n "$item" ] && { echo "$item"; return 0; }
    sleep 1
  done
  return 1
}
sc_R2() {
  local n="$1" id="R2.$1" branch bot cid apptsv="$WORK/R2.$1.appr" sha_before sha_after item1 item2 t1 t2 r1 r2 id1 id2 reply2 force_id
  branch="$(branch_for R2 "$n")"; : >"$apptsv"
  begin_section "$id" "kill -9 while the force-push approval is pending (attempt $n)"
  raw "Branch \`$branch\`. Procedure: phase 1 = L2-style PR flow (Bot completes it); phase 2 = \"把这个分支 force push 一次。\"; when the approval is pending (\`GET /api/approvals\`), wait 2 s, \`kill -9\` the server, restart; the same approval item must reappear; deny it; the Bot must report the denial without a workaround and the remote branch SHA must not change."
  raw ""; raw "Timeline:"; raw ""
  prepare_attempt || { finish "$id" FAIL "precondition: server/cleanup"; return; }
  bot="$(new_bot "kt-R2-$n-$RUN")"
  [ -n "$bot" ] && [ "$bot" != null ] || { finish "$id" FAIL "could not create a Bot"; return; }
  cid="$(bot_cid "$bot")"
  APPROVAL_MODE=auto
  submit "$bot" "$(pr_task "$branch")" >/dev/null
  note "Bot $bot (conversation $cid) created; phase 1 task submitted"
  if ! wait_run "$bot" 600 "$apptsv"; then
    note "phase 1: no final answer within 600 s"; api -X POST "$BASE/api/bots/$bot/abort" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1
    summary "$bot" | block text; finish "$id" FAIL "phase 1 (PR flow) did not finish within 600 s"; return
  fi
  note "phase 1 finished"
  verify_pr_flow "$branch" "$bot"
  sha_before="$(branch_sha "$branch")"
  note "remote $branch SHA before phase 2: ${sha_before:0:12}"
  if [ "$FAILS" != 0 ]; then
    summary "$bot" | block text; finish "$id" FAIL "phase 1 checks failed ($FAILS); phase 2 skipped"; return
  fi
  APPROVAL_MODE=deny
  submit "$bot" "把这个分支 force push 一次。" >/dev/null
  note "phase 2 task submitted: force push"
  if ! item1="$(wait_approval "$cid" 240)"; then
    note "no approval appeared within 240 s"; summary "$bot" | tail -6 | block text; finish "$id" FAIL "the force-push approval never appeared (the Bot did not issue a force push)"; return
  fi
  id1="$(jq -r .taskId <<<"$item1")"; t1="$(jq -r .toolName <<<"$item1")"; r1="$(jq -r .reason <<<"$item1")"
  note "approval pending BEFORE the kill: taskId=$id1 tool=$t1 reason=\"$r1\" command: $(jq -r '.args.command // (.args | tostring)' <<<"$item1" | cut -c1-200)"
  sleep 2
  api "$BASE/api/approvals" | jq -e --arg i "$id1" 'map(select(.taskId == $i)) | length == 1' >/dev/null && note "still pending after 2 s" || note "NOT pending any more after 2 s"
  restart_after_kill "approval $id1 pending"
  note "state while the server is dead: health=$(server_up && echo up || echo down)"
  start_server || { finish "$id" FAIL "server did not restart"; return; }
  note "server restarted (healthy)"
  if item2="$(wait_approval "$cid" 120)"; then
    id2="$(jq -r .taskId <<<"$item2")"; t2="$(jq -r .toolName <<<"$item2")"; r2="$(jq -r .reason <<<"$item2")"
    note "approval AFTER the restart: taskId=$id2 tool=$t2 reason=\"$r2\" requestedAt=$(jq -r .requestedAt <<<"$item2")"
    check "approval reappeared after the restart" PASS "taskId=$id2"
    [ "$id2" = "$id1" ] && check "it is the same approval item (same taskId)" PASS "taskId=$id1" || check "it is the same approval item (same taskId)" FAIL "before=$id1 after=$id2"
    [ "$t2" = bash ] && check "toolName is bash" PASS "bash" || check "toolName is bash" FAIL "$t2"
    case "$r2" in *"rewrites remote history"*) check "reason mentions 'rewrites remote history'" PASS "$r2" ;; *) check "reason mentions 'rewrites remote history'" FAIL "$r2" ;; esac
    # the deny; auto_approvals (APPROVAL_MODE=deny) records it and denies any later item as well
    auto_approvals "$cid" "$apptsv"
  else
    check "approval reappeared after the restart" FAIL "no pending approval for conversation $cid within 120 s after the restart; state $(final_state "$bot"); pending now: $(api "$BASE/api/approvals" | jq -c 'length')"
    summary "$bot" | tail -8 | block text
  fi
  if wait_run "$bot" 300 "$apptsv"; then note "phase 2 finished (final answer present)"; check "Bot gave a final answer after the denial" PASS "ok"; else
    check "Bot gave a final answer after the denial" FAIL "no final answer in 300 s; state $(final_state "$bot")"; api -X POST "$BASE/api/bots/$bot/abort" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1; fi
  APPROVAL_MODE=auto
  reply2="$(final_text "$bot")"
  note "Bot reply (phase 2): $(printf '%s' "$reply2" | tr '\n' ' ' | cut -c1-400)"
  printf '%s' "$reply2" | grep -qiE '拒绝|拒|denied|deny|未批准|没有批准|未获|驳回|blocked' && check "Bot reported the denial" PASS "reply mentions the denial" || check "Bot reported the denial" FAIL "reply does not mention the denial"
  local n_appr; n_appr="$(awk -F'\t' '$3 == "bash" && $5 ~ /rewrites remote history|force/ { c[$2]++ } END { n = 0; for (k in c) n++; print n }' "$apptsv")"
  [ "$n_appr" = 1 ] && check "exactly one distinct approval item in phase 2 (no retry in another form)" PASS "1" || check "exactly one distinct approval item in phase 2 (no retry in another form)" FAIL "$n_appr distinct item(s); all decisions: $(awk -F'\t' '{printf "%s:%s ", $2, $4}' "$apptsv")"
  trace_tsv "$bot" "$KILL_MS" >"$WORK/$id.trace"
  force_id="$(entries "$bot" | jq -r '[.[] | select(.kind == "pi.user" and ((.model[0].content | tostring) | test("force push"; "i")))] | last | .id // 0')"
  local pushes denied
  pushes="$(awk -F'\t' -v f="$force_id" '$1 + 0 > f + 0 && $3 == "bash" && $7 ~ /push/ && $8 !~ /User denied/' "$WORK/$id.trace" | wc -l | tr -d ' ')"
  denied="$(awk -F'\t' -v f="$force_id" '$1 + 0 > f + 0 && $8 ~ /User denied/' "$WORK/$id.trace" | wc -l | tr -d ' ')"
  [ "$pushes" = 0 ] && check "no push command executed after the force-push request (no workaround)" PASS "0 (denied results: $denied)" || check "no push command executed after the force-push request (no workaround)" FAIL "$pushes push command(s): $(awk -F'\t' -v f="$force_id" '$1 + 0 > f + 0 && $3 == "bash" && $7 ~ /push/ && $8 !~ /User denied/ {print $7}' "$WORK/$id.trace" | cut -c1-120 | tr '\n' ';')"
  [ "$denied" -ge 1 ] && check "'User denied' tool result recorded in the conversation" PASS "$denied" || check "'User denied' tool result recorded in the conversation" FAIL "none"
  sha_after="$(branch_sha "$branch")"
  note "remote $branch SHA after phase 2: ${sha_after:0:12}"
  [ -n "$sha_before" ] && [ "$sha_before" = "$sha_after" ] && check "remote branch SHA unchanged" PASS "${sha_after:0:12}" || check "remote branch SHA unchanged" FAIL "before=${sha_before:0:12} after=${sha_after:0:12}"
  leak_in_entries "$bot"
  raw ""; raw "Approvals (decisions made by the script):"; raw ""; approvals_md "$apptsv" >>"$SECTION"; raw ""
  raw "Pending approval item before the kill:"; raw ""; jq '{taskId, toolName, reason, requestedAt, command: (.args.command // null)}' <<<"$item1" | block json
  [ -n "${item2:-}" ] && { raw "Pending approval item after the restart:"; raw ""; jq '{taskId, toolName, reason, requestedAt, command: (.args.command // null)}' <<<"$item2" | block json; }
  raw "Server log excerpt:"; raw ""; server_log_excerpt | block text
  raw "Tool results (When = relative to the kill):"; raw ""; trace_table <"$WORK/$id.trace" >>"$SECTION"; raw ""
  observe_recovery "$WORK/$id.trace"
  raw ""; raw "Conversation (tail):"; raw ""; summary "$bot" | tail -14 | block text
  verdict "$id"
}

# =====================================================================================================================
# R3 — kill -9 as soon as the remote branch exists (window: after push, before gh pr create finished)
# =====================================================================================================================
# One node process polls the ref over a keep-alive connection (~0.15 s period; `gh api` needs ~0.8 s per call). The token comes
# from the environment (never from argv).
poll_ref() { # $1 = branch, $2 = limit seconds -> 0 when refs/heads/<branch> exists
  node --input-type=module -e '
const [repo, branch, limit] = process.argv.slice(1);
const url = `https://api.github.com/repos/${repo}/git/ref/heads/${branch}`;
const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "tarsbot-kill-test", Accept: "application/vnd.github+json" };
const end = Date.now() + Number(limit) * 1000;
while (Date.now() < end) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    await r.arrayBuffer();
    if (r.status === 200) process.exit(0);
  } catch {}
  await new Promise((res) => setTimeout(res, 150));
}
process.exit(1);' "$REPO" "$1" "$2"
}
# R3B trigger: the Bot's `gh pr create` tool call exists in the conversation but has no result yet (it is running in the Sprite).
JQ_INFLIGHT='
  ([.[] | select(.kind == "pi.tool-result") | .model[0].toolCallId]) as $done
  | [.[] | select(.kind == "pi.assistant") | .model[0].content[]? | select(.type == "toolCall")
     | select(((.arguments.command // "") | test($re))) | select(.id as $i | ($done | index($i)) == null)] | length'
poll_inflight() { # $1 = bot, $2 = regex on the command, $3 = limit seconds -> 0 when such a call is running
  local start=$SECONDS
  while [ $((SECONDS - start)) -lt "$3" ]; do
    [ "$(entries "$1" 2>/dev/null | jq -r --arg re "$2" "$JQ_INFLIGHT" 2>/dev/null)" -ge 1 ] 2>/dev/null && return 0
    sleep 0.15
  done
  return 1
}

# mode "ref": kill when the remote branch exists. mode "inflight": kill 1.5 s after the `gh pr create` call started (it takes ~3 s,
# so the PR is typically created remotely while the server dies and the tool result is lost).
r3_run() { # $1 = attempt, $2 = R3|R3B, $3 = ref|inflight
  local n="$1" sid="$2" mode="$3" id="$2.$1" branch bot apptsv="$WORK/$2.$1.appr" found=0 pr_at_kill created_s kill_s miss=0 why="" intr_create
  branch="$(branch_for "$sid" "$n")"; : >"$apptsv"
  if [ "$mode" = ref ]; then
    begin_section "$id" "kill -9 once the remote branch exists, before the PR (attempt $n)"
    raw "Branch \`$branch\`. Procedure: new Bot gets the L2-style task; a node poller (keep-alive, ~0.15 s period) watches \`git/ref/heads/$branch\`; the moment it exists the server is killed with \`-9\` and restarted. Target window: push finished, \`gh pr create\` not finished. A PR that already exists right after the kill (or was created before the kill timestamp) = **MISS** (race not hit): neither pass nor fail. Pass criteria: one PR, no duplicate commits, the Bot's final reply links the right PR."
  else
    begin_section "$id" "kill -9 while \`gh pr create\` is running (extra scenario, attempt $n)"
    raw "Branch \`$branch\`. Extra scenario beyond the task table (the hardest part of the R3 window): the entries of the Bot are polled every ~0.15 s; when a \`gh pr create\` tool call exists without a result, wait 1.5 s (the command takes ~3 s), \`kill -9\`, restart. The remote command usually keeps running after the connection dies, so the PR may exist while the tool result is lost. **Hit** = the \`gh pr create\` call comes back as interrupted. Otherwise MISS. Pass criteria as R3: one PR, no duplicate commits, correct link in the final reply."
  fi
  raw ""; raw "Timeline:"; raw ""
  prepare_attempt || { finish "$id" FAIL "precondition: server/cleanup"; return; }
  bot="$(new_bot "kt-$sid-$n-$RUN")"
  [ -n "$bot" ] && [ "$bot" != null ] || { finish "$id" FAIL "could not create a Bot"; return; }
  submit "$bot" "$(pr_task "$branch")" >/dev/null
  note "Bot $bot created, task submitted"
  if [ "$mode" = ref ]; then
    poll_ref "$branch" 300 && found=1
  else
    poll_inflight "$bot" 'gh pr create' 300 && { sleep 1.5; found=1; }
  fi
  if [ "$found" != 1 ]; then
    note "trigger never fired within 300 s"; summary "$bot" | tail -8 | block text; finish "$id" FAIL "the trigger ($mode) never fired"; return
  fi
  restart_after_kill "$([ "$mode" = ref ] && echo "remote branch $branch exists" || echo "gh pr create running")"
  pr_at_kill="$(ghx pr list -R "$REPO" --head "$branch" --state all --json number --jq 'length' 2>/dev/null)"
  note "PRs for the branch right after the kill: ${pr_at_kill:-?}"
  start_server || { finish "$id" FAIL "server did not restart"; return; }
  note "server restarted (healthy)"
  if wait_run "$bot" 600 "$apptsv"; then note "run finished (bot idle, final answer present)"; check "task resumed and finished after the restart" PASS "final answer within 600 s"; else
    check "task resumed and finished after the restart" FAIL "no final answer within 600 s; state $(final_state "$bot"); aborting the Bot"; api -X POST "$BASE/api/bots/$bot/abort" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1; fi
  verify_pr_flow "$branch" "$bot"
  leak_in_entries "$bot"
  trace_tsv "$bot" "$KILL_MS" >"$WORK/$id.trace"
  kill_s=$((KILL_MS / 1000))
  created_s="$(python3 -c 'import sys,datetime; print(int(datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()))' "${PR_CREATED:-1970-01-01T00:00:00Z}" 2>/dev/null)"
  intr_create="$(is_interrupted_row <"$WORK/$id.trace" | awk -F'\t' '$7 ~ /gh pr create/' | wc -l | tr -d ' ')"
  if [ "$mode" = ref ]; then
    if [ "${pr_at_kill:-0}" != 0 ]; then miss=1; why="a PR already existed ~0.5 s after the kill"; fi
    if [ -n "$PR_CREATED" ] && [ "${created_s:-0}" -lt "$kill_s" ]; then miss=1; why="${why:+$why; }PR createdAt ($PR_CREATED) is before the kill ($(date -u -r "$kill_s" +%H:%M:%SZ))"; fi
    [ "$miss" = 1 ] && check "premise: the kill landed after the push and before the PR existed" INFO "MISS — $why" || check "premise: the kill landed after the push and before the PR existed" PASS "no PR at kill time; PR createdAt=${PR_CREATED:-none}, kill at $(date -u -r "$kill_s" +%H:%M:%SZ)"
  else
    if [ "$intr_create" = 0 ]; then miss=1; why="the gh pr create call was not reported as interrupted"; fi
    [ "$miss" = 1 ] && check "premise: gh pr create was in flight at the kill" INFO "MISS — $why" || check "premise: gh pr create was in flight at the kill" PASS "interrupted gh pr create results: $intr_create; PRs ~0.5 s after the kill: ${pr_at_kill:-?}; PR createdAt=${PR_CREATED:-none}, kill at $(date -u -r "$kill_s" +%H:%M:%SZ)"
  fi
  note "interrupted tool results: $(is_interrupted_row <"$WORK/$id.trace" | awk -F'\t' '{printf "[%s] %s | ", $1, substr($7, 1, 120)}')"
  raw ""; raw "Approvals:"; raw ""; approvals_md "$apptsv" >>"$SECTION"; raw ""
  raw "Server log excerpt:"; raw ""; server_log_excerpt | block text
  raw "Tool results (When = relative to the kill):"; raw ""; trace_table <"$WORK/$id.trace" >>"$SECTION"; raw ""
  observe_recovery "$WORK/$id.trace"
  raw ""; raw "Final state of the clone in the Sprite:"; raw ""; sprite_snapshot | block text
  raw "Conversation:"; raw ""; summary "$bot" | block text
  raw "Bot's final reply: $(final_text "$bot" | tr '\n' ' ' | cut -c1-500)"
  if [ "$miss" = 1 ]; then
    finish "$id" MISS "race not hit ($why); informational outcome: $FAILS failed check(s) in the flow that followed"
  else
    verdict "$id"
  fi
}
sc_R3() { r3_run "$1" R3 ref; }
sc_R3B() { r3_run "$1" R3B inflight; }

# =====================================================================================================================
# R4 — Sprite goes cold while the Bot is idle; the next instruction still works
# =====================================================================================================================
sc_R4() {
  local n="$1" id="R4.$1" bot apptsv="$WORK/R4.$1.appr" st1 st2 start limit=600 min_idle=180 cold=0 prev="" s statuses="" submit_s row dur up0 up1 wall1 wall0
  begin_section "$id" "idle until the Sprite is cold, then a new instruction (attempt $n)"
  raw "Procedure: cleanup remote; make sure the clone exists in the Sprite (the directory is kept for this scenario); new Bot; warm-up instruction; then the Bot stays idle while the platform status is polled every 15 s until it reads \`cold\` AND at least ${min_idle} s have passed since the last Sprite activity (a cold reading right after activity proves nothing; max ${limit} s); then the instruction \`git -C ~/workspace/tars-sandbox-playground log -1 --oneline\`. The \`status\` field is documented as unreliable in docs/sprites-probe.md; it is recorded, not trusted."
  raw ""; raw "Timeline:"; raw ""
  ensure_server || { finish "$id" FAIL "server not available"; return; }
  note "cleanup: $(cleanup_remote 2>&1 | tr '\n' ';')"
  note "clone in the Sprite: $(sx --timeout-ms 90000 "d=$REPO_DIR_SPRITE; if [ -d \$d/.git ]; then echo present; else git clone -q https://github.com/hifizz/tars-sandbox-playground.git \$d && echo cloned; fi" 2>&1 | tr '\n' ' ')"
  bot="$(new_bot "kt-R4-$n-$RUN")"
  [ -n "$bot" ] && [ "$bot" != null ] || { finish "$id" FAIL "could not create a Bot"; return; }
  submit "$bot" "Use the bash tool to run exactly: echo R4-warmup-$RANDOM . Then repeat the output." >/dev/null
  note "Bot $bot created; warm-up submitted"
  wait_run "$bot" 180 "$apptsv" || { summary "$bot" | block text; finish "$id" FAIL "warm-up did not finish"; return; }
  up0="$(sx 'cut -d" " -f1 /proc/uptime' 2>/dev/null | tr -d '\n')"; wall0=$SECONDS
  note "Sprite uptime before the idle period: ${up0:-?} s. The Bot is idle now; polling the status every 15 s: the instruction is sent when the status reads cold AND the Bot has been idle >= ${min_idle} s (max ${limit} s)"
  start=$SECONDS; prev=""
  while [ $((SECONDS - start)) -lt "$limit" ]; do
    s="$(sx_status)"; s="${s:-unknown}"
    if [ "$s" != "$prev" ]; then note "Sprite status at +$((SECONDS - start)) s: $s"; statuses="$statuses +$((SECONDS - start))s:$s"; prev="$s"; fi
    if [ "$s" = cold ] && [ $((SECONDS - start)) -ge "$min_idle" ]; then cold=1; break; fi
    sleep 15
  done
  if [ "$cold" = 1 ]; then
    note "status reads cold after $((SECONDS - start)) s idle (transitions seen:$statuses)"
  else
    note "未能观测到 cold (in the idle window >= ${min_idle} s): within ${limit} s the status was not cold at a poll after ${min_idle} s (transitions seen:$statuses); the instruction is sent after $((SECONDS - start)) s idle (>= the 5 minutes the fallback asks for when cold never shows: $([ $((SECONDS - start)) -ge 300 ] && echo yes || echo no))"
  fi
  st1="$(sx_status)"; submit_s=$SECONDS
  note "status right before the instruction: ${st1:-unknown}"
  submit "$bot" "在 Sprite 里执行 \`git -C ~/workspace/tars-sandbox-playground log -1 --oneline\`，并把输出原样告诉我。" >/dev/null
  note "instruction submitted"
  if wait_run "$bot" 180 "$apptsv"; then note "run finished after $((SECONDS - submit_s)) s"; else note "no final answer within 180 s"; fi
  st2="$(sx_status)"; note "status after the run: ${st2:-unknown}"
  up1="$(sx 'cut -d" " -f1 /proc/uptime' 2>/dev/null | tr -d '\n')"; wall1=$SECONDS
  note "Sprite uptime after the run: ${up1:-?} s; wall clock since the uptime read before the idle period: $((wall1 - wall0)) s (a much smaller uptime delta would mean the VM was restarted/restored)"
  trace_tsv "$bot" 0 >"$WORK/$id.trace"
  row="$(awk -F'\t' '$3 == "bash" && $7 ~ /log -1 --oneline/' "$WORK/$id.trace" | tail -1)"
  dur="$(printf '%s' "$row" | awk -F'\t' '{print $4}')"
  if [ -n "$row" ] && [ "$(printf '%s' "$row" | awk -F'\t' '{print $5}')" = false ] && printf '%s' "$row" | awk -F'\t' '{print $8}' | grep -Eq '^[0-9a-f]{7,} '; then
    check "the instruction executed successfully" PASS "tool duration ${dur:-?} ms; result: $(printf '%s' "$row" | awk -F'\t' '{print $8}' | cut -c1-120)"
  else
    check "the instruction executed successfully" FAIL "row: $(printf '%s' "$row" | cut -c1-300)"
  fi
  [ "$cold" = 1 ] && check "Sprite status was cold (after >= ${min_idle} s idle) before the instruction" PASS "cold after $((submit_s - start)) s idle (the status field is only a hint)" || check "Sprite status was cold (after >= ${min_idle} s idle) before the instruction" INFO "未能观测到 cold in ${limit} s (statuses:$statuses); instruction sent after $((submit_s - start)) s idle"
  check "Sprite uptime continuity across the idle period" INFO "uptime ${up0:-?} s -> ${up1:-?} s; wall clock +$((wall1 - wall0)) s"
  check "tool duration and wake behaviour recorded" INFO "tool ${dur:-?} ms; status before=${st1:-?} after=${st2:-?}; $(sprites_log_stats)"
  leak_in_entries "$bot"
  raw ""; raw "Sprites exec log lines of this attempt (never contain commands or output): $(sprites_log_stats)"; raw ""
  tail -n "+${LOGMARK:-1}" "$LOG" | grep -E '^\[sprites\] ' | tail -4 | block text
  raw "Tool results:"; raw ""; trace_table <"$WORK/$id.trace" >>"$SECTION"; raw ""
  raw "Conversation:"; raw ""; summary "$bot" | block text
  verdict "$id"
}

# =====================================================================================================================
# R5 — leak check (file names only; values never printed)
# =====================================================================================================================
LEAK_TARGETS=(data logs docs/acceptance)
leak_scan() { # prints "VAR<TAB>file" lines (names only); returns 0
  local var val pf f
  pf="$(mktemp)"; chmod 600 "$pf"
  for var in GITHUB_TOKEN SPRITES_TOKEN TOKEN_ROUTER_API_KEY EXA_API_KEY; do
    val="${!var:-}"
    if [ -z "$val" ]; then printf '%s\t(variable is not set: skipped)\n' "$var"; continue; fi
    printf '%s' "$val" >"$pf"
    for f in $(LC_ALL=C grep -rlaF -f "$pf" "${LEAK_TARGETS[@]}" docs/sprites-*.md 2>/dev/null); do printf '%s\t%s\n' "$var" "$f"; done
  done
  rm -f "$pf"
}
sc_R5() {
  local id="R5.1" out files nfiles
  begin_section "$id" "leak check"
  raw "Searched with \`grep -rlaF\` (binary-safe, so the sqlite files and their WAL are included) for the values of GITHUB_TOKEN, SPRITES_TOKEN, TOKEN_ROUTER_API_KEY and EXA_API_KEY in: \`data/\`, \`logs/\`, \`docs/sprites-*.md\` (including this report as written so far), \`docs/acceptance/\`. Only the variable name and the matching file name are printed."
  raw ""
  files="$(find data logs docs/acceptance -type f 2>/dev/null | wc -l | tr -d ' ') files in the directories + $(ls docs/sprites-*.md 2>/dev/null | wc -l | tr -d ' ') docs/sprites-*.md"
  out="$(leak_scan)"
  note "scanned $files"
  nfiles="$(printf '%s\n' "$out" | grep -vc '(variable is not set' || true)"
  [ -n "$out" ] && printf '%s\n' "$out" | block text
  if printf '%s\n' "$out" | grep -q 'variable is not set'; then check "all four variables are set (otherwise the scan proves nothing)" FAIL "$(printf '%s\n' "$out" | grep 'not set' | cut -f1 | tr '\n' ' ')"; else check "all four variables are set (otherwise the scan proves nothing)" PASS "set"; fi
  if [ -z "$(printf '%s\n' "$out" | grep -v '(variable is not set')" ]; then check "no secret value found in data/ logs/ docs/sprites-*.md docs/acceptance/" PASS "0 matching files"; else check "no secret value found in data/ logs/ docs/sprites-*.md docs/acceptance/" FAIL "matching: $(printf '%s\n' "$out" | grep -v '(variable is not set' | tr '\t\n' ': ' | cut -c1-300)"; fi
  verdict "$id"
}

# ---- main ---------------------------------------------------------------------------------------------------------------------
[ "${SPRITES_KT_SOURCE_ONLY:-0}" = 1 ] && return 0 2>/dev/null

WANT=("$@"); [ ${#WANT[@]} -gt 0 ] || WANT=(R1 R2 R3 R3B R4 R5)
want() { local w; for w in "${WANT[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }

final_cleanup() { cleanup_remote 2>&1 | tr '\n' ';'; }
trap 'ensure_server >/dev/null 2>&1; rm -rf "$WORK"' EXIT

echo "=== TARSBot × Sprites L3 — run $RUN (repo $REPO, branch prefix $PREFIX)"
validate_repo || { echo "cannot read $REPO with the local gh token" >&2; exit 2; }
node --env-file=.env scratch/sprite-exec.mjs exec 'echo sprite-ok' 2>&1 | grep -q sprite-ok || { echo "Sprite $SPRITE_NAME not reachable" >&2; exit 2; }
EVIDENCE_BEFORE="$(evidence_state)"
echo "evidence PRs before: $(printf '%s' "$EVIDENCE_BEFORE" | tr '\n' ';')"
[ -z "$(server_pids)" ] || stop_server_term
start_server || exit 2
MODEL_ID="$(api "$BASE/api/bots" | jq -r '.[-1].model.modelId // "?"')"
echo "server up (log logs/server-sprites-kt-$RUN.log), default model $MODEL_ID, sandbox $(api "$BASE/api/space" | jq -c '{sandbox, name}')"

# run_scenario <id> — up to 3 attempts, stops at the first PASS. Every attempt stays in the report.
run_scenario() {
  local sid="$1" n=1 hist="" r
  while [ "$n" -le 3 ]; do
    "sc_$sid" "$n"
    r="$(cat "$WORK/$sid.$n.result" 2>/dev/null || echo FAIL)"
    hist="$hist $n:$r"
    printf '%s\t%s\t%s\t%s\n' "$sid" "$n" "$r" "$(cat "$WORK/$sid.$n.detail" 2>/dev/null)" >>"$WORK/attempts.tsv"
    [ "$r" = PASS ] && break
    n=$((n + 1))
  done
  case "$r" in
    PASS) if [ "$n" = 1 ]; then echo "PASS" >"$WORK/$sid.final"; else echo "PASS (after retries:$hist)" >"$WORK/$sid.final"; fi ;;
    MISS) echo "INCONCLUSIVE (race window not hit in 3 attempts:$hist)" >"$WORK/$sid.final" ;;
    *) echo "FAIL (attempts:$hist)" >"$WORK/$sid.final" ;;
  esac
  SCEN_IDS+=("$sid")
}

write_doc() { # $1 = final-cleanup text, $2 = leftovers, $3 = evidence after
  {
    echo "# TARSBot L3: durability on Sprites (kill -9, pending approval, cold Sprite, leak check)"
    echo
    echo "Generated by \`scripts/sprites-kill-test.sh\` on $(date '+%Y-%m-%d %H:%M:%S %z'), run id \`$RUN\`."
    echo
    echo "- Server: \`TARSBOT_SPRITES_LOG=1 node --no-warnings src/server.mjs\`, log \`logs/server-sprites-kt-$RUN.log\`; default model \`$MODEL_ID\` via tokenrouter (key from the environment, never printed)"
    echo "- Sprite \`$SPRITE_NAME\`; test repository \`$REPO\`; every branch of this run starts with \`$PREFIX\`"
    echo "- Helper: \`scratch/sprite-exec.mjs\` (runs commands in the Sprite through \`src/sandbox/sprites.mjs\`; the shell never reads \`.env\`)"
    echo "- Kill: \`kill -9\` of the node server process started from this directory; restart with the same command. Sprite-side polling for R1 runs inside one Sprite exec (0.05 s loop); R3 polls the remote branch ref about every 0.15 s with a node fetch loop (the local gh needs ~0.8 s per call)."
    echo "- Approval policy during unattended phases: only a recursive delete of the clone directory in the Sprite is approved (natural recovery from a half-cloned directory); every other approval is denied. Every decision is listed per attempt."
    echo
    echo "## Summary"
    echo
    echo "| Scenario | Result |"
    echo "|---|---|"
    for s in ${SCEN_IDS[@]+"${SCEN_IDS[@]}"}; do printf '| %s | %s |\n' "$s" "$(cat "$WORK/$s.final")"; done
    echo
    echo "All attempts (none is hidden; PASS = all checks passed, MISS = target race window not hit, FAIL = a check failed):"
    echo
    echo "| Scenario | Attempt | Result | Detail |"
    echo "|---|---|---|---|"
    [ -f "$WORK/attempts.tsv" ] && awk -F'\t' '{ printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }' "$WORK/attempts.tsv"
    echo
    echo "## PRs and branches created by this run"
    echo
    if [ -s "$LEDGER" ]; then
      echo "| Kind | Item | Branch | State when seen | Cleanup |"; echo "|---|---|---|---|---|"
      awk -F'\t' '
        $1 == "PR" { if (!($2 in b)) { order[++k] = $2; st[$2] = $4 }; b[$2] = $3 }
        $1 == "BRANCH" { if (!($2 in seen)) { seen[$2] = 1; br[++m] = $2 } }
        END {
          for (i = 1; i <= k; i++) { n = order[i]; printf "| PR | %s | `%s` | %s | %s |\n", n, b[n], st[n], (st[n] == "OPEN" ? "closed by cleanup" : "was already closed") }
          for (j = 1; j <= m; j++) printf "| branch | - | `%s` | - | deleted |\n", br[j]
        }' "$LEDGER"
    else
      echo "none"
    fi
    echo
    echo "Final cleanup output: ${1:-nothing was left to clean up (each attempt cleans the previous attempts at its start; see the table)}"
    echo
    echo "After the final cleanup: $2 (of this run's open PRs / branches)."
    echo
    echo "Evidence PRs #$(echo "$EVIDENCE_PRS" | sed 's/ /, #/g') (earlier acceptance runs, must be untouched):"
    echo
    echo '```text'
    echo "before: $(printf '%s' "$EVIDENCE_BEFORE" | tr '\n' ';')"
    echo "after:  $(printf '%s' "$3" | tr '\n' ';')"
    echo '```'
    local f
    for f in "$WORK"/R*.md; do [ -e "$f" ] && cat "$f"; done
    if [ -n "${KT_PREVIOUS_REPORT:-}" ] && [ -f "$KT_PREVIOUS_REPORT" ]; then
      echo; echo "# Appendix: earlier full run of this script (kept for the record)"; echo
      echo "Passed to this run with KT_PREVIOUS_REPORT. It was produced by the same script before R4 was tightened (min. idle) and R3B was added; headings are demoted one level."; echo
      sed -E 's/^(#+) /#\1 /' "$KT_PREVIOUS_REPORT"
    fi
  } | scrub >"$DOC"
}

want R1 && run_scenario R1
want R2 && run_scenario R2
want R3 && run_scenario R3
want R3B && run_scenario R3B
want R4 && run_scenario R4

# final cleanup of this run's PRs/branches, then the leak scan (it also reads the report written so far)
CLEAN_OUT="$(final_cleanup)"; LEFT="$(remote_leftovers)"; EVIDENCE_AFTER="$(evidence_state)"
sc_R5_needed=0; want R5 && sc_R5_needed=1
if [ "$sc_R5_needed" = 1 ]; then
  write_doc "$CLEAN_OUT" "$LEFT" "$EVIDENCE_AFTER"            # preliminary report, scanned by R5
  sc_R5; r="$(cat "$WORK/R5.1.result")"; echo "R5	1	$r	$(cat "$WORK/R5.1.detail")" >>"$WORK/attempts.tsv"; echo "$r" >"$WORK/R5.final"; SCEN_IDS+=(R5)
fi
ensure_server
write_doc "$CLEAN_OUT" "$LEFT" "$EVIDENCE_AFTER"
if [ "$sc_R5_needed" = 1 ]; then
  # the final report itself must not contain a secret either
  if [ -n "$(leak_scan | grep -v '(variable is not set')" ]; then
    echo "LEAK: the final report matches a secret value (file names only):" >&2; leak_scan | grep -v '(variable is not set' | cut -f1,2 >&2
    echo "FAIL" >"$WORK/R5.final"; write_doc "$CLEAN_OUT" "$LEFT" "$EVIDENCE_AFTER"
  fi
fi

echo
echo "================ SUMMARY"
EXIT=0
for s in ${SCEN_IDS[@]+"${SCEN_IDS[@]}"}; do
  printf '%s: %s\n' "$s" "$(cat "$WORK/$s.final")"
  case "$(cat "$WORK/$s.final")" in PASS*) ;; *) EXIT=1 ;; esac
done
echo "evidence PRs before: $(printf '%s' "$EVIDENCE_BEFORE" | tr '\n' ';')"
echo "evidence PRs after:  $(printf '%s' "$EVIDENCE_AFTER" | tr '\n' ';')"
[ "$EVIDENCE_BEFORE" = "$EVIDENCE_AFTER" ] || { echo "WARNING: evidence PR state changed!"; EXIT=1; }
echo "leftovers of this run: $LEFT"
echo "report: $DOC"
exit "$EXIT"
