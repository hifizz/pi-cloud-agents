#!/bin/sh
# pca runner: detached, resumable command execution for a Linux sandbox (Sprite). POSIX sh; runs under dash.
# See docs/M1-PLAN.md section 4.4 and docs/m1-probe.md (A2, B2, B3, B4).
#
#   runner.sh prepare <id> --cwd <dir> --cmd-file <path> --cmd-sha256 <hex> [--env-file <path>]
#   runner.sh start   <id>
#   runner.sh wait    <id> --from <byteOffset> --max <seconds> [--encoding raw|base64]
#   runner.sh status  <id>
#   runner.sh kill    <id> [--grace <seconds>]
#   runner.sh version
#
# Output is `key=value` lines; `wait` appends `--data--` and then the log bytes (raw, or base64 with --encoding base64).
# Errors print `error=<code>` and exit 2. Every other outcome exits 0 and is described by the keys.
#
# Layout under ${PCA_HOME:-$HOME/.pca}:
#   stage/<id>/          written by the client (command bytes); never contains environment values
#   runs/<id>/cmd        the command, raw bytes          runs/<id>/cwd    working directory (one line)
#   runs/<id>/meta       id, cwd, cmd_sha256, env NAMES (never values)
#   runs/<id>/starting/  directory made by `start` BEFORE anything is launched: the atomic "start at most once" latch
#   runs/<id>/ident      pid, pgid, boot_id, start ticks of the wrapper (written by the wrapper itself, atomically)
#   runs/<id>/out.log    stdout + stderr of the command, merged
#   runs/<id>/exit       exit status; written as exit.tmp then renamed
#
# State machine (`state=`):
#   missing  no run directory
#   claimed  directory exists, no `ident` (never started, or start was attempted and its outcome is unknown: see launched=)
#   running  no `exit`, `ident` matches a live process (boot_id + /proc/<pid>/stat field 22 + not a zombie)
#   exited   `exit` exists (exit=<n>; 128+signal when the command was killed by a signal)
#   lost     `ident` exists but that process is gone and there is no `exit`
# `claimed`, `lost` and `missing` are NEVER restarted by this script. `start` launches only when there is no ident, no
# exit and it wins the mkdir of runs/<id>/starting. A crash after prepare or between that mkdir and the wrapper writing
# `ident` therefore leaves `claimed` (launched=1 when the latch exists): the caller must treat it as "outcome unknown".
#
# Known deviations / limits:
#  - stdout and stderr are merged into one log.
#  - Linux only: needs setsid, /proc (test hooks: PCA_PROC_ROOT, PCA_SETSID, PCA_SH, PCA_CMD_SH, PCA_START_TICKS). No macOS identity code.
#  - A command that escapes the process group (its own setsid / daemonize) is not reached by `kill`.
#  - The command is passed to `bash -c -- "$(cat cmd)"` (`sh` when /bin/bash is missing; see PCA_CMD_SH): no NUL bytes, trailing newlines are dropped, and one argument is
#    limited to 128 KiB by Linux (prepare rejects commands above MAX_CMD_BYTES).
#  - If the wrapper dies but the command's group lives on, `kill` cannot verify identity and does nothing (not-found).
#  - Environment values are inherited from whoever calls `start`; they are never written to any file. `meta` records only
#    the NAMES; `start` refuses (error=env-missing) when a recorded name is not set in its environment.

RUNNER_VERSION=2
MAX_DATA=32768
MAX_CMD_BYTES=126000

set -f
umask 077
PCA_HOME=${PCA_HOME:-${HOME:-/tmp}/.pca}
PCA_PROC_ROOT=${PCA_PROC_ROOT:-/proc}
PCA_SH=${PCA_SH:-sh}
# The shell that runs the USER'S command. PCA_SH only runs this script's own wrapper (it must stay a POSIX sh); the model
# writes bash (arrays, [[ ]], <(...), {1..3}), and the built-in bash tool and SandboxEnv both use /bin/bash, so the
# command runs under bash when it exists and under sh otherwise.
if [ -z "${PCA_CMD_SH:-}" ]; then
  if [ -x /bin/bash ]; then PCA_CMD_SH=/bin/bash; else PCA_CMD_SH=$PCA_SH; fi
fi
PCA_SETSID=${PCA_SETSID:-setsid}
export PCA_HOME PCA_PROC_ROOT PCA_SH PCA_CMD_SH PCA_SETSID
RUNS=$PCA_HOME/runs
STAGE=$PCA_HOME/stage
NL=$(printf '\n_')
NL=${NL%_}

die() {
  printf 'error=%s\n' "$1"
  [ -n "$2" ] && printf 'detail=%s\n' "$2"
  exit 2
}

valid_id() {
  case $1 in
    '' | *[!A-Za-z0-9_-]*) return 1 ;;
  esac
  [ ${#1} -le 64 ]
}

valid_name() {
  case $1 in
    '' | [0-9]* | *[!A-Za-z0-9_]*) return 1 ;;
  esac
  return 0
}

is_uint() {
  case $1 in
    '' | *[!0-9]* | 0[0-9]*) return 1 ;;
  esac
  [ ${#1} -le 9 ]
}

sha256_of() {
  sha256sum < "$1" | cut -d' ' -f1
}

file_size() {
  fs_n=$(wc -c < "$1")
  echo $((fs_n))
}

# kv <file> <key>: print the value of the first `key=value` line.
kv() {
  while IFS= read -r kv_line; do
    case $kv_line in
      "$2="*)
        printf '%s' "${kv_line#*=}"
        return 0
        ;;
    esac
  done < "$1"
  return 1
}

boot_id() {
  bi=
  { read -r bi < "$PCA_PROC_ROOT/sys/kernel/random/boot_id"; } 2> /dev/null
  printf '%s' "$bi"
}

# proc_stat <pid>: sets P_STATE, P_PGRP, P_START from /proc/<pid>/stat (field 3, 5, 22).
proc_stat() {
  P_STATE='' P_PGRP='' P_START=''
  ps_line=
  { read -r ps_line < "$PCA_PROC_ROOT/$1/stat"; } 2> /dev/null
  [ -n "$ps_line" ] || return 1
  ps_rest=${ps_line##*) }
  [ "$ps_rest" != "$ps_line" ] || return 1
  # shellcheck disable=SC2086
  set -- $ps_rest
  [ $# -ge 20 ] || return 1
  P_STATE=$1
  P_PGRP=$3
  P_START=${20}
  return 0
}

# ident_alive <rundir>: the wrapper recorded in ident is still this very process.
ident_alive() {
  ia_pid=$(kv "$1/ident" pid)
  ia_boot=$(kv "$1/ident" boot_id)
  ia_start=$(kv "$1/ident" start)
  is_uint "$ia_pid" || return 1
  [ -n "$ia_boot" ] && [ -n "$ia_start" ] || return 1
  [ "$(boot_id)" = "$ia_boot" ] || return 1
  kill -0 "$ia_pid" 2> /dev/null || return 1
  proc_stat "$ia_pid" || return 1
  [ "$P_START" = "$ia_start" ] || return 1
  [ "$P_STATE" != Z ] || return 1
  return 0
}

# load_state <id>: sets RD, S_STATE, S_EXIT.
load_state() {
  RD=$RUNS/$1
  S_EXIT=
  if [ ! -d "$RD" ]; then
    S_STATE=missing
  elif [ -f "$RD/exit" ]; then
    S_STATE=exited
    S_EXIT=$(head -n 1 "$RD/exit" | tr -dc '0-9')
  elif [ -f "$RD/ident" ]; then
    # Order matters: the wrapper writes `exit` BEFORE it dies, so look for `exit` again after finding it dead.
    if ident_alive "$RD"; then
      S_STATE=running
    elif [ -f "$RD/exit" ]; then
      S_STATE=exited
      S_EXIT=$(head -n 1 "$RD/exit" | tr -dc '0-9')
    else
      S_STATE=lost
    fi
  else
    S_STATE=claimed
  fi
}

log_size() {
  if [ -f "$1/out.log" ]; then file_size "$1/out.log"; else echo 0; fi
}

emit_state() {
  printf 'state=%s\n' "$S_STATE"
  [ "$S_STATE" = missing ] && return 0
  [ -n "$S_EXIT" ] && printf 'exit=%s\n' "$S_EXIT"
  if [ -f "$RD/ident" ]; then
    es_pid=$(kv "$RD/ident" pid)
    printf 'pid=%s\n' "$es_pid"
  fi
  printf 'size=%s\n' "$(log_size "$RD")"
  if [ -f "$RD/meta" ]; then
    es_sha=$(kv "$RD/meta" cmd_sha256)
    printf 'cmd_sha256=%s\n' "$es_sha"
    es_cwd=$(kv "$RD/meta" cwd)
    printf 'cwd=%s\n' "$es_cwd"
  fi
  if [ -d "$RD/starting" ]; then printf 'launched=1\n'; else printf 'launched=0\n'; fi
  return 0
}

write_exit() { # <rundir> <code>: only if no exit exists yet
  [ -f "$1/exit" ] && return 0
  printf '%s\n' "$2" > "$1/exit.$$.tmp" && mv "$1/exit.$$.tmp" "$1/exit"
}

# ---------------------------------------------------------------------------------------------------------------

cmd_prepare() {
  id=$1
  shift
  valid_id "$id" || die bad-id
  cwd='' cmdf='' sha='' envf=''
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die bad-args "missing value for $1"
    case $1 in
      --cwd) cwd=$2 ;;
      --cmd-file) cmdf=$2 ;;
      --cmd-sha256) sha=$2 ;;
      --env-file) envf=$2 ;;
      *) die bad-args "unknown option $1" ;;
    esac
    shift 2
  done
  [ -n "$cwd" ] || die bad-args "--cwd is required"
  case $cwd in *"$NL"*) die bad-args "cwd contains a newline" ;; esac
  [ -n "$cmdf" ] && [ -n "$sha" ] || die bad-args "--cmd-file and --cmd-sha256 are required"
  case $sha in *[!0-9a-f]* | '') die bad-args "bad sha256" ;; esac
  [ ${#sha} -eq 64 ] || die bad-args "bad sha256"

  # Verify everything BEFORE claiming, so a bad upload never burns the id.
  [ -f "$cmdf" ] || die stage-missing
  [ "$(file_size "$cmdf")" -gt 0 ] || die empty-command
  [ "$(file_size "$cmdf")" -le $MAX_CMD_BYTES ] || die cmd-too-large
  [ "$(sha256_of "$cmdf")" = "$sha" ] || die sha-mismatch
  names=
  if [ -n "$envf" ]; then
    [ -f "$envf" ] || die stage-missing
    while IFS= read -r en_line || [ -n "$en_line" ]; do
      [ -n "$en_line" ] || continue
      case $en_line in *=*) die env-file-has-value "env files may only list names" ;; esac
      valid_name "$en_line" || die bad-env-name
      names=${names:+$names,}$en_line
    done < "$envf"
  fi

  mkdir -p "$RUNS" || die io-error
  if ! mkdir "$RUNS/$id" 2> /dev/null; then
    if [ -d "$RUNS/$id" ]; then
      # Already claimed: report, change nothing.
      load_state "$id"
      printf 'prepared=existing\n'
      emit_state
      rm -rf "${STAGE:?}/$id"
      exit 0
    fi
    die io-error
  fi
  rd=$RUNS/$id
  # We created rd a moment ago and nothing can have started in it (start needs meta), so rolling back is safe.
  fail_claim() {
    rm -rf "$rd"
    die "$1"
  }
  cp "$cmdf" "$rd/cmd.tmp" || fail_claim copy-failed
  [ "$(sha256_of "$rd/cmd.tmp")" = "$sha" ] || fail_claim sha-mismatch
  mv "$rd/cmd.tmp" "$rd/cmd" || fail_claim io-error
  printf '%s\n' "$cwd" > "$rd/cwd" || fail_claim io-error
  : > "$rd/out.log" || fail_claim io-error
  {
    printf 'id=%s\n' "$id"
    printf 'cwd=%s\n' "$cwd"
    printf 'cmd_sha256=%s\n' "$sha"
    printf 'cmd_bytes=%s\n' "$(file_size "$rd/cmd")"
    printf 'env_names=%s\n' "$names"
    printf 'runner_version=%s\n' "$RUNNER_VERSION"
    printf 'created=%s\n' "$(date +%s)"
  } > "$rd/meta.tmp" || fail_claim io-error
  mv "$rd/meta.tmp" "$rd/meta" || fail_claim io-error
  rm -rf "${STAGE:?}/$id"
  printf 'prepared=new\n'
  load_state "$id"
  emit_state
}

cmd_start() {
  id=$1
  valid_id "$id" || die bad-id
  load_state "$id"
  if [ "$S_STATE" = missing ]; then
    printf 'started=no\nreason=missing\n'
    emit_state
    return 0
  fi
  if [ -f "$RD/ident" ] || [ -f "$RD/exit" ]; then
    printf 'started=already\n'
    emit_state
    return 0
  fi
  if [ ! -f "$RD/meta" ] || [ ! -f "$RD/cmd" ] || [ ! -f "$RD/cwd" ]; then
    printf 'started=no\nreason=not-prepared\n'
    emit_state
    return 0
  fi
  # Required environment NAMES must be present (values are inherited from our caller, never stored).
  en=$(kv "$RD/meta" env_names)
  oldifs=$IFS
  IFS=,
  for en_name in $en; do
    IFS=$oldifs
    valid_name "$en_name" || die bad-env-name
    en_set=''
    eval "en_set=\${$en_name+x}"
    [ "$en_set" = x ] || die env-missing "$en_name"
    IFS=,
  done
  IFS=$oldifs
  command -v "${PCA_SETSID%% *}" > /dev/null 2>&1 || die setsid-missing
  if ! mkdir "$RD/starting" 2> /dev/null; then
    printf 'started=already\n'
    load_state "$id"
    emit_state
    return 0
  fi
  self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  (
    $PCA_SETSID "$PCA_SH" "$self" __wrap "$id" > /dev/null 2>&1 < /dev/null &
  )
  i=0
  st_ticks=${PCA_START_TICKS:-100}
  is_uint "$st_ticks" || st_ticks=100
  while [ ! -f "$RD/ident" ] && [ ! -f "$RD/exit" ] && [ $i -lt "$st_ticks" ]; do
    sleep 0.1
    i=$((i + 1))
  done
  load_state "$id"
  if [ -f "$RD/ident" ] || [ -f "$RD/exit" ]; then
    printf 'started=new\n'
  else
    printf 'started=unknown\n'
  fi
  emit_state
}

# Internal: the detached wrapper (runs as session and process-group leader thanks to setsid).
cmd_wrap() {
  id=$1
  valid_id "$id" || exit 2
  rd=$RUNS/$id
  trap : TERM INT HUP
  proc_stat "$$" || {
    printf 'no process identity: %s/%s/stat unreadable\n' "$PCA_PROC_ROOT" "$$" > "$rd/wrap.err"
    exit 70
  }
  {
    printf 'pid=%s\n' "$$"
    printf 'pgid=%s\n' "$P_PGRP"
    printf 'boot_id=%s\n' "$(boot_id)"
    printf 'start=%s\n' "$P_START"
  } > "$rd/ident.tmp" && mv "$rd/ident.tmp" "$rd/ident" || exit 71
  IFS= read -r wcwd < "$rd/cwd"
  umask 022 # our own files are 0600 (umask above); the user's command gets an ordinary umask
  wcmd=$(cat "$rd/cmd")
  if cd "$wcwd" 2>> "$rd/out.log"; then
    "$PCA_CMD_SH" -c -- "$wcmd" < /dev/null >> "$rd/out.log" 2>&1
    wcode=$?
  else
    printf 'pca: cannot cd to %s\n' "$wcwd" >> "$rd/out.log"
    wcode=126
  fi
  write_exit "$rd" "$wcode"
}

cmd_status() {
  valid_id "$1" || die bad-id
  load_state "$1"
  emit_state
}

cmd_wait() {
  id=$1
  shift
  valid_id "$id" || die bad-id
  from=0 max=30 enc=raw
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die bad-args
    case $1 in
      --from) from=$2 ;;
      --max) max=$2 ;;
      --encoding) enc=$2 ;;
      *) die bad-args "unknown option $1" ;;
    esac
    shift 2
  done
  is_uint "$from" || die bad-args "--from"
  is_uint "$max" || die bad-args "--max"
  case $enc in raw | base64) ;; *) die bad-args "--encoding" ;; esac
  ticks=$((max * 2))
  i=0
  while :; do
    load_state "$id" # state FIRST, size second: once `exit` exists the log is complete
    sz=$(log_size "$RD")
    [ "$S_STATE" != running ] && break
    [ "$sz" -gt "$from" ] && break
    [ $i -ge $ticks ] && break
    sleep 0.5
    i=$((i + 1))
  done
  avail=$((sz - from))
  [ $avail -lt 0 ] && avail=0
  n=$avail
  [ $n -gt $MAX_DATA ] && n=$MAX_DATA
  printf 'state=%s\n' "$S_STATE"
  [ -n "$S_EXIT" ] && printf 'exit=%s\n' "$S_EXIT"
  printf 'offset=%s\nsize=%s\nencoding=%s\n--data--\n' $((from + n)) "$sz" "$enc"
  if [ $n -gt 0 ]; then
    if [ "$enc" = base64 ]; then
      tail -c +$((from + 1)) "$RD/out.log" | head -c $n | base64 | tr -d '\n'
    else
      tail -c +$((from + 1)) "$RD/out.log" | head -c $n
    fi
  fi
}

group_empty() {
  ! kill -s 0 -- "-$1" 2> /dev/null
}

cmd_kill() {
  id=$1
  shift
  valid_id "$id" || die bad-id
  grace=5
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die bad-args
    case $1 in
      --grace) grace=$2 ;;
      *) die bad-args "unknown option $1" ;;
    esac
    shift 2
  done
  is_uint "$grace" || die bad-args "--grace"
  load_state "$id"
  if [ "$S_STATE" != running ]; then
    printf 'killed=not-found\n'
    emit_state
    return 0
  fi
  kpid=$(kv "$RD/ident" pid)
  kpgid=$(kv "$RD/ident" pgid)
  # The wrapper must be its own group leader (setsid worked); otherwise -pgid could be OUR group.
  if ! is_uint "$kpgid" || [ "$kpgid" != "$kpid" ] || [ "$kpgid" -le 1 ]; then
    printf 'killed=not-found\nreason=bad-ident\n'
    emit_state
    return 0
  fi
  sig=15
  kill -s TERM -- "-$kpgid" 2> /dev/null
  i=0
  limit=$((grace * 10))
  while :; do
    if ! ident_alive "$RD" && group_empty "$kpgid"; then break; fi
    [ $i -ge $limit ] && break
    sleep 0.1
    i=$((i + 1))
  done
  if ! { ! ident_alive "$RD" && group_empty "$kpgid"; }; then
    # Still there. KILL only while the wrapper is still verifiably the recorded process.
    if ident_alive "$RD"; then
      sig=9
      kill -s KILL -- "-$kpgid" 2> /dev/null
      i=0
      while [ $i -lt 30 ]; do
        if ! ident_alive "$RD" && group_empty "$kpgid"; then break; fi
        sleep 0.1
        i=$((i + 1))
      done
    fi
  fi
  if ! ident_alive "$RD" && group_empty "$kpgid"; then
    write_exit "$RD" $((128 + sig))
    printf 'killed=confirmed\n'
  else
    printf 'killed=unconfirmed\n'
  fi
  load_state "$id"
  emit_state
}

cmd_version() {
  printf 'version=%s\n' "$RUNNER_VERSION"
  printf 'sha256=%s\n' "$(sha256_of "$0")"
}

sub=${1:-}
[ $# -gt 0 ] && shift
case $sub in
  version) cmd_version ;;
  prepare | start | wait | status | kill | __wrap)
    [ $# -ge 1 ] || die bad-args "missing id"
    case $sub in
      __wrap) cmd_wrap "$@" ;;
      *) "cmd_$sub" "$@" ;;
    esac
    ;;
  *) die bad-command "usage: runner.sh prepare|start|wait|status|kill|version" ;;
esac
