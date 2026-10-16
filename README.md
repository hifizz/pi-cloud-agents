# pi-cloud-agents

在云端常驻运行 [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)（`@earendil-works/pi-durable`）Bot，执行环境是可插拔的云沙箱；目前唯一的沙箱实现是 Fly.io Sprites。

每个 Bot 拥有一条持久对话（崩溃、重启后自动恢复），所有 Bot 共用一个 Sprite（单用户）。你可以在网页上观察 Bot 工作、steer / 排队 / 中止、从任意消息 fork，危险操作会先停在审批条。

线上地址：`https://pi.zilin.im`（仅白名单邮箱可登录，不开放注册）。

> 命名说明：代码中的 `TARSBOT_*` 环境变量与 "TARSBot" 字样是历史遗留，暂不改名。

## 架构

```
浏览器 ──HTTPS──▶ Fly Proxy (pi.zilin.im, force_https)
                    │
                    ▼
        Fly Machine `pi-cloud-agents` (sin, shared-cpu-1x 512MB)
        node src/server.mjs  0.0.0.0:8080
         ├─ auth guard（src/routes/auth.mjs + src/auth.mjs）→ /data/auth.sqlite
         ├─ Pi Durable harness → /data/alice.sqlite, /data/bots.json
         └─ SpritesEnv ──WSS exec──▶ Sprite `pi-cloud-agents`（/home/sprite/workspace）
                                        └─ git / gh ──▶ GitHub
```

- 沙箱接口：`src/sandbox/<provider>.mjs`，见 [`docs/CONTRACTS.md`](docs/CONTRACTS.md)。
- 全部状态存 sqlite / JSON，位于 Fly Volume `/data`；存储只允许单写进程，因此只跑 1 台 Machine。

## 本地开发

前置：Node ≥ 24（仓库根有 `.nvmrc`，`nvm use` 或 `fnm use`）。

```bash
npm install && (cd web && npm install && npm run build)
npm start                      # http://127.0.0.1:8090
cd web && npm run dev          # Vite dev，http://127.0.0.1:5183
```

`.env`（不提交）所需键名：

- `TOKEN_ROUTER_BASE_URL`、`TOKEN_ROUTER_API_KEY`：OpenAI 兼容模型网关
- `EXA_API_KEY`：web_search
- `SPRITES_TOKEN`、`TARSBOT_SPRITE_NAME`：Sprite 沙箱
- `GITHUB_TOKEN`（仅限测试仓库的 fine-grained PAT）、`TARSBOT_GIT_EMAIL`
- `TARSBOT_ALLOWED_EMAILS`：登录白名单（逗号分隔）
- 可选：`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`（Google 登录）、`TARSBOT_PUBLIC_URL`、`TARSBOT_MODEL`

本地登录：

- 密码登录：`node scripts/set-password.mjs <email>`（stdin 读密码；只接受白名单邮箱），再用邮箱 + 密码登录。
- 仅本地开发可设 `TARSBOT_AUTH_DISABLED=1` 跳过鉴权；`TARSBOT_HOST` 不是 loopback 时服务会拒绝启动。

默认模型 `glm-5.3-flash`，用 `TARSBOT_MODEL` 覆盖；已有 Bot 换模型：停掉 server 后 `node scripts/set-model.mjs <bot> <modelId>`。

命令行替代：`npm run repl` —— 与 server 共用 sqlite，**不能和 server 同时运行**。

## 测试

```bash
TARSBOT_NO_DOTENV=1 npm test                       # 后端单元测试，离线
cd web && npm test && npm run typecheck && npm run build
```

## 部署

部署到 Fly.io（`fly deploy`、secrets、volume、域名、GitHub 自动部署）见 [`docs/DEPLOY.md`](docs/DEPLOY.md)；Sprite 的初始化与维护见 [`docs/sprite-cloud.md`](docs/sprite-cloud.md)。完整方案与决策见 [`docs/CLOUD-PLAN.md`](docs/CLOUD-PLAN.md)。

## 安全

- 只有白名单邮箱能登录，无注册接口；所有 `/api/*` 与 WebSocket 需有效 session，非 GET 请求还会校验 Origin。契约见 `docs/CLOUD-PLAN.md` §4。
- Sprite 内的 `bash` 即完全信任边界：能执行 bash 的主体拥有 Sprite 内的全部权限与登录态。危险操作走 `src/ext/approval.mjs` 审批。
- 密钥只存在于 Fly secrets 与本地 `.env`，不写入 Sprite、日志、测试快照或截图。

## 数据

| 位置 | 内容 |
|---|---|
| `/data/alice.sqlite`（本地为 `data/`） | 全部对话与状态，**禁止删除** |
| `/data/bots.json` | Bot 配置 |
| `/data/auth.sqlite` | 用户与 session |

## 文档

- 云端方案：[`docs/CLOUD-PLAN.md`](docs/CLOUD-PLAN.md)；接口契约：[`docs/CONTRACTS.md`](docs/CONTRACTS.md)；Agent 指南：[`AGENTS.md`](AGENTS.md)
- 历史文档：[`docs/archive/`](docs/archive/README.md)、`docs/SPRITES-PLAN.md`

## 已知限制

- pi-durable API 处于实验阶段（依赖收敛在 `env.mjs`/`ext/`/`server.mjs` 三处）。
- 单写进程：server 与 repl 不能同时开；Fly 只能 1 台 Machine。
