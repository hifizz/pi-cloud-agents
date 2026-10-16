#!/usr/bin/env bash
# Idempotent creation + initialisation of the shared E2B sandbox "pi-cloud-agents" (docs/E2B-PLAN.md). Safe to rerun.
#   scripts/e2b-setup.sh [--no-npm] [--recreate]
#     --no-npm     skip the clone / npm ci / npm test self-check
#     --recreate   kill the existing sandbox named pi-cloud-agents (metadata app+name only) and create a fresh one
# Optional: TARSBOT_E2B_TEMPLATE (base), TARSBOT_E2B_IDLE_MS (600000). TARSBOT_E2B_NAME, if set, must be "pi-cloud-agents".
# Needs in .env (or the environment if .env is absent): E2B_API_KEY, GITHUB_TOKEN, TARSBOT_GIT_EMAIL. Secrets are never
# printed or written to the sandbox. Exit status 1 if any step reports FAIL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Without .env the required variables must already be in the environment.
if [ -f .env ]; then
  exec node --env-file=.env scratch/e2b-setup.mjs "$@"
fi
exec node scratch/e2b-setup.mjs "$@"
