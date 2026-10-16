#!/usr/bin/env bash
# Stage Fly secrets from .env (allow-listed keys only). Never prints values.
# Usage: scripts/fly-secrets.sh [app]   (default: app name from fly.toml)
set -euo pipefail
cd "$(dirname "$0")/.."
APP="${1:-$(sed -n 's/^app *= *"\(.*\)"/\1/p' fly.toml | head -1)}"
KEYS=(TOKEN_ROUTER_BASE_URL TOKEN_ROUTER_API_KEY EXA_API_KEY SPRITES_TOKEN GITHUB_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET)
[ -f .env ] || { echo "no .env" >&2; exit 1; }

payload=""; imported=(); missing=()
for k in "${KEYS[@]}"; do
  line="$(grep -E "^(export )?${k}=" .env | tail -1 || true)"
  val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  if [ -n "$val" ]; then
    payload+="${k}=${val}"$'\n'; imported+=("$k")
  else
    missing+=("$k")
  fi
done
if [ ${#imported[@]} -gt 0 ]; then
  printf '%s' "$payload" | fly secrets import --stage --app "$APP" >/dev/null
fi
echo "app: $APP"
echo "imported (staged): ${imported[*]:-none}"
echo "missing: ${missing[*]:-none}"
