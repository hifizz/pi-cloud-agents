#!/usr/bin/env bash
# Idempotent initialisation of the TARSBot Sprite (docs/SPRITES-PLAN.md §4.3). Safe to rerun; also repairs a bad network policy.
#   scripts/sprite-setup.sh [--no-policy] [--reset-policy] [--recheckpoint] [--no-npm]
#     --no-policy     do not touch the network policy
#     --reset-policy  remove all network rules (unrestricted) and stop; rerun without it to re-apply the allowlist
#     --recheckpoint  replace the existing "v-setup" checkpoint with a fresh one
#     --no-npm        skip the clone / npm install / npm test self-check
# Optional: TARSBOT_SPRITE_CPUS (4), TARSBOT_SPRITE_RAM_MB (4096), TARSBOT_SPRITE_REGION (unset) apply on creation only.
# Needs in .env (or the environment if .env is absent): SPRITES_TOKEN, TARSBOT_SPRITE_NAME, GITHUB_TOKEN, TARSBOT_GIT_EMAIL. Secrets are never printed or written
# to the Sprite. Only the Sprite named by TARSBOT_SPRITE_NAME is touched. Exit status 1 if any step reports FAIL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Without .env the required variables must already be in the environment (e.g. on a Fly machine).
if [ -f .env ]; then
  exec node --env-file=.env scratch/sprite-setup.mjs "$@"
fi
exec node scratch/sprite-setup.mjs "$@"
