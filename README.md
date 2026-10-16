# pi-cloud-agents

**English** | [简体中文](README.zh-CN.md)

![pi-cloud-agents web UI: bots on the left, a conversation in the middle, and the Changes panel with a diff on the right](docs/images/pi-cloud-agents.jpeg)

Self-hosted cloud coding agents, in the spirit of [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent): you give a Bot a task in the browser, it works on its own remote Linux machine — clones the repo, edits, runs the tests, pushes a branch and opens a PR — and you watch, steer and approve from the web UI.

Built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) (`@earendil-works/pi-durable`): every Bot is one durable conversation that survives crashes and restarts. The execution environment is a pluggable cloud sandbox: [Fly.io Sprites](https://sprites.dev) (default, used in production) or [E2B](https://e2b.dev).

Live at `https://pi.zilin.im` (allow-listed emails only, no sign-up).

> Naming: the `TARSBOT_*` environment variables and the "TARSBot" strings in the code are historical and kept for now.

## Features

- **Agents with their own machine** — bash, read / write / edit and web search tools; all commands run in the cloud sandbox, never on the server host.
- **Git / PR workflow** — git and `gh` are pre-authenticated in the sandbox; the Bot works on a `tarsbot/*` branch and replies with the PR link.
- **Durable by design** — conversations, running tool calls and pending approvals survive `kill -9` and redeploys; interrupted steps are checked before they are retried, so no duplicate PRs or commits (see [`docs/acceptance/L3`](docs/acceptance/L3/README.md)).
- **Human in the loop** — dangerous operations (`rm -rf`, force push, deleting remote branches, pushing to `main` / `dev`, merging or closing PRs, write calls to the GitHub API…) stop at an approval bar; verdicts are stored durably.
- **Live web UI** — streamed messages and tool cards with timings and diffs; steer, queue or abort a run; fork a conversation from any message; compact / reset; token usage.
- **Routines** — scheduled prompts per Bot, durable across restarts.
- **Pluggable sandboxes** — a sandbox is two primitives, `bash()` and `info()`; Sprites and E2B both pass pi-durable's `ExecutionEnv` conformance suite.
- **Multiple models** through an OpenAI-compatible gateway (default `swe-2`; also `glm-5.3-flash`, `glm-5.3`, `claude-sonnet-5-5`, `gpt-5.6-terra`, …).

### Compared with Cursor Cloud Agents

Same idea — an agent that works in a remote machine and hands back a PR — with different trade-offs:

- **Cursor** runs each agent in an isolated cloud VM with a managed, reusable environment (repos, dependencies, secrets, network controls), usually hosted by Cursor ([docs](https://cursor.com/docs/cloud-agent)).
- **pi-cloud-agents** is a small self-hosted stack for one user: one Fly Machine with sqlite, Bots sharing one long-lived sandbox (Sprite or E2B), a durable conversation per Bot that resumes after crashes, and an explicit approval step for destructive git / shell operations.

## Architecture

```
Browser ──HTTPS──▶ Fly Proxy (pi.zilin.im)
                     │
                     ▼
         Fly Machine `pi-cloud-agents` (sin, shared-cpu-1x 512 MB)
         node src/server.mjs  0.0.0.0:8080
          ├─ auth guard (src/routes/auth.mjs + src/auth.mjs) → /data/auth.sqlite
          ├─ Pi Durable harness → /data/alice.sqlite, /data/bots.json
          └─ SandboxEnv ── bash() ──▶ TARSBOT_SANDBOX
                                       ├─ sprites: Sprite `pi-cloud-agents` (/home/sprite/workspace)
                                       └─ e2b:     E2B sandbox `pi-cloud-agents` (/home/user/workspace)
                                                     └─ git / gh ──▶ GitHub
```

- Sandbox interface: `src/sandbox/<provider>.mjs`, selected by `src/sandbox/index.mjs`; see [`docs/CONTRACTS.md`](docs/CONTRACTS.md).
- All state is sqlite / JSON on the Fly volume `/data`. Storage allows a single writer, so exactly one Machine runs.

## Local development

Requires Node ≥ 24 (`.nvmrc` in the repo root).

```bash
npm install && (cd web && npm install && npm run build)
npm start                      # http://127.0.0.1:8090
TARSBOT_SANDBOX=e2b npm start  # same, on the E2B sandbox
cd web && npm run dev          # Vite dev server, http://127.0.0.1:5183
```

Keys in `.env` (never committed):

- `TOKEN_ROUTER_BASE_URL`, `TOKEN_ROUTER_API_KEY` — OpenAI-compatible model gateway
- `EXA_API_KEY` — web search
- `SPRITES_TOKEN`, `TARSBOT_SPRITE_NAME` — Sprites sandbox
- `E2B_API_KEY` (optional `TARSBOT_E2B_NAME`, `TARSBOT_E2B_IDLE_MS`) — E2B sandbox
- `GITHUB_TOKEN` (fine-grained PAT limited to the test repository), `TARSBOT_GIT_EMAIL`
- `TARSBOT_ALLOWED_EMAILS` — login allow-list (comma separated)
- Optional: `TARSBOT_SANDBOX` (`sprites` | `e2b`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TARSBOT_PUBLIC_URL`, `TARSBOT_MODEL`

Sandbox setup (idempotent): `scripts/sprite-setup.sh` or `scripts/e2b-setup.sh`.

Logging in locally:

- Password: `node scripts/set-password.mjs <email>` (reads the password from stdin; allow-listed emails only).
- Local development only: `TARSBOT_AUTH_DISABLED=1` skips auth; the server refuses to start with it when `TARSBOT_HOST` is not loopback.

Change the model of an existing Bot: stop the server, then `node scripts/set-model.mjs <bot> <modelId>`.

CLI alternative: `npm run repl` — shares the sqlite file with the server, **do not run both at once**.

## Tests

```bash
TARSBOT_NO_DOTENV=1 npm test                         # backend unit tests, offline
cd web && npm test && npm run typecheck && npm run build
set -a; . ./.env; set +a; npm run test:env           # ExecutionEnv conformance on the real sandbox
```

## Deployment

Fly.io deployment (`fly deploy`, secrets, volume, domain, GitHub auto-deploy): [`docs/DEPLOY.md`](docs/DEPLOY.md). Sandbox setup records: [`docs/sprite-cloud.md`](docs/sprite-cloud.md), [`docs/e2b-cloud.md`](docs/e2b-cloud.md). Plan and decisions: [`docs/CLOUD-PLAN.md`](docs/CLOUD-PLAN.md), [`docs/E2B-PLAN.md`](docs/E2B-PLAN.md).

## Security

- Only allow-listed emails can log in; there is no sign-up. Every `/api/*` route and WebSocket needs a valid session, and non-GET requests are Origin-checked (`docs/CLOUD-PLAN.md` §4).
- `bash` in the sandbox is a full trust boundary: whoever can run bash there has every credential in the sandbox. Dangerous operations go through `src/ext/approval.mjs`.
- Secrets live only in Fly secrets and the local `.env`; they are passed to the sandbox per command and never written to the sandbox disk, logs, test snapshots or screenshots.

## Data

| Location | Contents |
|---|---|
| `/data/alice.sqlite` (locally `data/`) | All conversations and state — **never delete** |
| `/data/bots.json` | Bot registry |
| `/data/auth.sqlite` | Users and sessions |

## Docs

- Plan: [`docs/CLOUD-PLAN.md`](docs/CLOUD-PLAN.md) · Contracts: [`docs/CONTRACTS.md`](docs/CONTRACTS.md) · Agent guide: [`AGENTS.md`](AGENTS.md)
- History: [`docs/archive/`](docs/archive/README.md), `docs/SPRITES-PLAN.md`

## Known limitations

- The pi-durable API is experimental (dependencies are confined to `env.mjs`, `ext/` and `server.mjs`).
- Single writer: server and repl cannot run together; one Fly Machine only.
- The sandbox is chosen per process (`TARSBOT_SANDBOX`), not per Bot; all Bots share one sandbox.
- E2B `base` template is small (2 vCPU / ~470 MB, setup adds 1 GB swap); Hobby accounts cap the sandbox lifetime at 1 h between auto-pauses. No outbound network allow-list on E2B yet.
