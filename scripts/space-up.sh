#!/usr/bin/env bash
# Idempotent: start the persistent Cua Space container `tarsbot-space`
# (named volume tarsbot-space-home mounted at /home/cua) and write data/space.json.
# The spacesd token is generated once, stored only in data/space.json (mode 600), never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${TARSBOT_SPACE_CONTAINER:-tarsbot-space}"
VOLUME="${TARSBOT_SPACE_VOLUME:-tarsbot-space-home}"
PORT="${TARSBOT_SPACE_PORT:-3211}"
IMAGE="${TARSBOT_SPACE_IMAGE:-ghcr.io/trycua/linux:24.04}"
DATA_DIR="${TARSBOT_DATA_DIR:-$ROOT/data}"
STATE="$DATA_DIR/space.json"
URL="http://127.0.0.1:$PORT"
WAIT_S="${TARSBOT_SPACE_WAIT_S:-180}"

mkdir -p "$DATA_DIR"

exists() { docker inspect "$NAME" >/dev/null 2>&1; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" = "true" ]; }

# Token of an already existing container (so a lost data/space.json can be rebuilt).
container_token() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | sed -n 's/^CUA_ENV_TOKEN=//p' | head -n1
}

read_state_token() {
  [ -s "$STATE" ] || return 0
  node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token||"")}catch{}' "$STATE"
}

write_state() { # $1 = token
  local tmp
  tmp="$(mktemp "$DATA_DIR/.space.json.XXXXXX")"
  chmod 600 "$tmp"
  TOKEN="$1" URL="$URL" NAME="$NAME" node -e 'process.stdout.write(JSON.stringify({url:process.env.URL,token:process.env.TOKEN,container:process.env.NAME},null,2)+"\n")' >"$tmp"
  mv "$tmp" "$STATE"
  chmod 600 "$STATE"
}

TOKEN="$(read_state_token)"

if exists; then
  CTOKEN="$(container_token)"
  if [ -z "$TOKEN" ] || { [ -n "$CTOKEN" ] && [ "$TOKEN" != "$CTOKEN" ]; }; then
    TOKEN="$CTOKEN" # the container is the source of truth
  fi
  [ -n "$TOKEN" ] || { echo "space-up: container $NAME exists without CUA_ENV_TOKEN; remove it (docker rm -f $NAME) and rerun" >&2; exit 1; }
  if ! running; then
    echo "space-up: starting existing container $NAME"
    docker start "$NAME" >/dev/null
  else
    echo "space-up: container $NAME already running"
  fi
else
  [ -n "$TOKEN" ] || TOKEN="$(openssl rand -hex 32)"
  # Image: prefer the requested tag; else reuse the digest-pinned copy the SDK pulled; else pull.
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    DIGEST_REF="$(docker inspect -f '{{.Config.Image}}' tarsbot-probe 2>/dev/null || true)"
    if [ -n "$DIGEST_REF" ] && docker image inspect "$DIGEST_REF" >/dev/null 2>&1; then
      echo "space-up: $IMAGE not tagged locally, using $DIGEST_REF"
      IMAGE="$DIGEST_REF"
    else
      echo "space-up: pulling $IMAGE"
      docker pull "$IMAGE" >/dev/null
    fi
  fi
  echo "space-up: creating container $NAME (volume $VOLUME -> /home/cua, 127.0.0.1:$PORT)"
  # Flags mirror what the Cua SDK's create() uses (see `docker inspect tarsbot-probe`): 2 GiB shm, 4 GiB RAM, 2 CPUs,
  # Xvfb, audio. The token is passed by name so it never appears in `ps` output.
  CUA_ENV_TOKEN="$TOKEN" docker run -d \
    --name "$NAME" \
    --restart unless-stopped \
    --shm-size 2g --memory 4g --cpus 2 \
    -p "127.0.0.1:$PORT:3211" \
    -v "$VOLUME:/home/cua" \
    -e CUA_ENV_TOKEN \
    -e DISPLAY=:1 -e CUA_X_SERVER=xvfb -e CUA_AUDIO=true \
    --label tarsbot.space=true \
    "$IMAGE" >/dev/null
fi

write_state "$TOKEN"

echo "space-up: waiting for $URL/viewer/ (max ${WAIT_S}s)"
deadline=$((SECONDS + WAIT_S))
until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$URL/viewer/" || true)" = "200" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "space-up: timeout waiting for viewer" >&2
    docker logs --tail 20 "$NAME" >&2 || true
    exit 1
  fi
  sleep 2
done

# Working directory for Bots (lives on the persistent volume).
until docker exec -u cua "$NAME" mkdir -p /home/cua/work >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || { echo "space-up: cannot create /home/cua/work" >&2; exit 1; }
  sleep 1
done

echo "space-up: ready: $URL/viewer/ (container=$NAME, state=$STATE)"
