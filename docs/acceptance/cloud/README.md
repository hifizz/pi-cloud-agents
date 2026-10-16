# Cloud acceptance (C7), 2026-10-16

| Level | Steps | Result | Evidence |
|---|---|---|---|
| V0 | `TARSBOT_NO_DOTENV=1 npm test` (130/130). `cd web && npm test` (73/73), `typecheck`, `build` | PASS | — |
| V1 local | Local server with a temporary data dir: password login → bot `tars` (glm-5.3-flash) creates `~/workspace/hello-cloud.txt` in Sprite `pi-cloud-agents` → read the file back through the SDK. A WS request without a cookie gets 401. A login POST without an Origin header gets 403 | PASS | `01-login-local.png`, `02-bot-sprite-bash-local.png` |
| V2 online | `https://pi.zilin.im` (Let's Encrypt certificate Ready). The user logs in with email + password. Bot `cloud-v2` (claude-sonnet-5-5) creates `~/workspace/hello-online.txt`; `cat`/`uname -a`/`nproc` return `pi.zilin.im V2` / `Linux pi-cloud-agents 6.12.105-fly` / `8`. Unauthenticated `/api/bots` gets 401 | PASS | `03-online-bot-sprite.png` |
| V3 auto-deploy | Fly native GitHub integration: repo `hifizz/pi-cloud-agents`, branch `main`, Auto-Deploy on push. Push a commit, then confirm the release SHA and that the conversation survives the redeploy | see below | `04-after-autodeploy.png` |
| Google login | Not verified (user decision 2026-10-16); `GOOGLE_CLIENT_*` are not configured, so `/api/auth/google` returns 503 | SKIP | — |

Problem found during acceptance: the first `scripts/fly-secrets.sh` used a hand-written shell parser and imported `TOKEN_ROUTER_API_KEY` from `.env` with a trailing space, so the gateway returned 401 in production. Fix: parse `.env` with Node's `util.parseEnv`, the same parser as `process.loadEnvFile`, and trim the value. After re-importing, the gateway responds normally.
