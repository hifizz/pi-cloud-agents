#!/usr/bin/env bash
# Import Fly secrets from .env (allow-listed keys only). Never prints values.
# Parsing uses Node's util.parseEnv — the same parser as process.loadEnvFile in src/config.mjs — so quoting and
# trailing whitespace are handled exactly as in local runs.
# Usage: scripts/fly-secrets.sh [--stage] [app]   (default app: from fly.toml; without --stage the machine restarts)
set -euo pipefail
cd "$(dirname "$0")/.."
STAGE=""
if [ "${1:-}" = "--stage" ]; then STAGE="--stage"; shift; fi
APP="${1:-$(sed -n 's/^app *= *"\(.*\)"/\1/p' fly.toml | head -1)}"
[ -f .env ] || { echo "no .env" >&2; exit 1; }

KEYS="TOKEN_ROUTER_BASE_URL TOKEN_ROUTER_API_KEY EXA_API_KEY SPRITES_TOKEN E2B_API_KEY INSTABOX_API_KEY GITHUB_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET"
# Node writes KEY=value lines to stdout (piped straight into flyctl) and the key report to stderr.
KEYS="$KEYS" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
const env = parseEnv(readFileSync(".env", "utf8"));
const imported = [], missing = [];
for (const k of process.env.KEYS.split(" ")) {
  const v = (env[k] ?? "").trim();
  if (!v || /[\r\n]/.test(v)) { missing.push(k); continue; }
  process.stdout.write(`${k}=${v}\n`);
  imported.push(k);
}
process.stderr.write(`imported: ${imported.join(" ") || "none"}\nmissing: ${missing.join(" ") || "none"}\n`);
' | fly secrets import ${STAGE} --app "$APP" >/dev/null
echo "app: $APP${STAGE:+ (staged)}"
