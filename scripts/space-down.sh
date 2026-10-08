#!/usr/bin/env bash
# Stop the persistent Space container (keeps the container and the tarsbot-space-home volume).
# Pass --purge to also remove the container, the volume and data/space.json (destroys /home/cua!).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${TARSBOT_SPACE_CONTAINER:-tarsbot-space}"
VOLUME="${TARSBOT_SPACE_VOLUME:-tarsbot-space-home}"
STATE="${TARSBOT_DATA_DIR:-$ROOT/data}/space.json"

if [ "${1:-}" = "--purge" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$STATE"
  echo "space-down: purged $NAME, volume $VOLUME and $STATE"
else
  docker stop "$NAME" >/dev/null 2>&1 || true
  echo "space-down: stopped $NAME (volume $VOLUME kept; rerun scripts/space-up.sh)"
fi
