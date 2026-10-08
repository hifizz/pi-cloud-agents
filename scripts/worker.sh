#!/usr/bin/env bash
# Run one Sonnet 5.5 worker headlessly on a task brief. Usage: scripts/worker.sh <task-id>
# Brief: docs/tasks/<task-id>.md  Log: logs/workers/<task-id>.log
set -euo pipefail
cd "$(dirname "$0")/.."
id="$1"
brief="docs/tasks/${id}.md"
[ -f "$brief" ] || { echo "missing $brief" >&2; exit 1; }
mkdir -p logs/workers
log="logs/workers/${id}.log"
echo "[$(date -u +%FT%TZ)] start ${id}" > "$log"
kiro-cli chat --no-interactive --agent tarsbot-worker --model claude-sonnet-5.5 --trust-all-tools \
  "请完成任务文件 ${brief} 中描述的任务。先完整阅读该文件和 docs/CONTRACTS.md，然后实现、测试、汇报。" >> "$log" 2>&1
code=$?
echo "[$(date -u +%FT%TZ)] exit ${code} ${id}" >> "$log"
exit $code
