# pi-cloud-agents 云端化方案（Spec）

> 起草：2026-10-16。来源：`tarsbot` 仓库 `feat/sprites-shell` 分支（`2e14827`）拆出的独立仓库 `hifizz/pi-cloud-agents`（私有）。

## 1. 目标

在云端常驻运行 Pi Durable（`@earendil-works/pi-durable`）Bot，执行环境是可插拔的云沙箱；第一个也是目前唯一的沙箱实现是 Fly.io Sprites。服务部署在 Fly Machine，经 `https://pi.zilin.im` 访问，只有白名单邮箱能登录。

不做：Cua / 桌面操控、多用户隔离、开放注册、邮箱验证、Postgres。

## 2. 已确认的决策（用户，2026-10-16）

| # | 决策 |
|---|---|
| D1 | 全部状态存 sqlite（Pi Durable 对话 `alice.sqlite` + 登录 `auth.sqlite` + `bots.json`），放在 Fly Volume `/data`。不用 Neon |
| D2 | 不开放注册。白名单：`stackfizztailan@gmail.com`、`fizzstack@gmail.com` |
| D3 | 单用户：所有 Bot 共用一个 Sprite，不做按用户隔离 |
| D4 | GitHub 私有仓库 `hifizz/pi-cloud-agents`；用 Fly 原生 GitHub 集成（Fly.io GitHub App）在 push `main` 时自动部署，**不用 GitHub Actions** |
| D5 | `TARSBOT_*` 环境变量与代码里的 "TARSBot" 字样暂不改名 |
| D6 | 旧 `data/`（alice）丢弃，不迁移 |
| D7 | 新建 Sprite（不复用 `tarsbot-dev`），期望 4 CPU / 4 GB；费用可控 |
| D8 | Fly Machine：`shared-cpu-1x` + 512 MB，常驻（不 auto-stop），region `sin`，单机 + 1 GB volume |
| D9 | 登录自实现（`node:crypto` + `node:sqlite`），不引入新依赖：Google OAuth + 邮箱密码；密码由运维脚本设置，无注册接口 |

## 3. 架构

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

- 沙箱接口：`src/sandbox/<provider>.mjs` 导出 `bash(command, {timeoutMs}) -> {stdout, stderr, exitCode, timedOut}` 与 `info() -> {sandbox, name}`。`src/env.mjs` 的 `SandboxEnv` 只依赖这个原语。现在只有 `sprites.mjs`。
- 存储只允许单写进程 → Fly 只能 1 台 Machine；volume 绑定该机器，重新部署时同一 volume 重新挂载，数据保留。部署期间短暂停机，进行中的 run 由 Pi Durable 恢复。

## 4. 鉴权契约（C2 实现，C3 前端消费）

### 4.1 配置（全部从 `process.env` 读，由 `src/auth.mjs` 自己读取，不改 `config.mjs`）

| 变量 | 用途 |
|---|---|
| `TARSBOT_ALLOWED_EMAILS` | 逗号分隔白名单，比较前 trim + 小写。为空时拒绝所有登录 |
| `TARSBOT_PUBLIC_URL` | 外部访问基址，如 `https://pi.zilin.im`；用于 OAuth `redirect_uri` 与 Origin 校验。本地默认 `http://127.0.0.1:8090` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth Web 客户端；缺失时 `/api/auth/google` 返回 503，密码登录仍可用 |
| `TARSBOT_AUTH_DISABLED=1` | 仅本地开发跳过鉴权；当 `TARSBOT_HOST` 不是 loopback（`127.0.0.1`/`localhost`/`::1`）时**启动即抛错** |

### 4.2 存储：`<dataDir>/auth.sqlite`（`node:sqlite`，独立于 pi-durable 的 sqlite 文件）

- `users(email TEXT PRIMARY KEY, password_hash TEXT, created_at INTEGER)`；`password_hash` 为 `scrypt$N$r$p$saltB64$hashB64`。
- `sessions(token_hash TEXT PRIMARY KEY, email TEXT, created_at INTEGER, expires_at INTEGER)`；token 为 32 字节随机数（base64url），库里只存 sha256。有效期 30 天。
- dataDir 与 `config.dataDir` 一致（`TARSBOT_DATA_DIR`，默认 `data/`）。

### 4.3 HTTP 接口

| 方法 路径 | 行为 |
|---|---|
| `GET /api/auth/me` | 已登录 `200 {email}`；否则 `401 {error}` |
| `POST /api/auth/login` `{email, password}`（JSON） | 白名单内且密码正确 → 建 session、`Set-Cookie`、`200 {email}`；否则统一 `401 {error:"invalid email or password"}`。同一 email+IP 15 分钟内失败 5 次 → `429` |
| `POST /api/auth/logout` | 删 session、清 cookie、`200 {ok:true}` |
| `GET /api/auth/google` | 生成 `state` + PKCE(S256) + `nonce`，服务端内存保存 10 分钟，302 到 Google 授权页（scope `openid email profile`，`prompt=select_account`） |
| `GET /api/auth/google/callback` | 校验 state → 用 code + verifier 换 token → 调 userinfo（`https://openidconnect.googleapis.com/v1/userinfo`）→ 要求 `email_verified === true` 且 email 在白名单 → 建 session → 302 `/`。失败 302 `/?auth_error=<code>`（`denied` / `state` / `exchange`） |

- Cookie：`pca_session=<token>; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`；当 `TARSBOT_PUBLIC_URL` 是 https 或请求头 `x-forwarded-proto: https` 时加 `Secure`。
- Google 回调地址：`${TARSBOT_PUBLIC_URL}/api/auth/google/callback`。
- 无注册接口。密码账号由 `scripts/set-password.mjs <email>` 写入（stdin 读密码、不回显；只接受白名单邮箱；线上用 `fly ssh console -C "node scripts/set-password.mjs <email>"`）。

### 4.4 全局守卫

- `src/api.mjs` 增加 `app.guard(fn)`（插件注册时调用，可注册多个，按顺序执行）。
  - HTTP：在路由匹配前对**所有** `/api/*` 请求执行；`fn(req, {kind:"http", path})` 返回 `true` 放行，或抛 `HttpError(401)`。
  - WS：在 `upgrade` 时执行 `fn(req, {kind:"ws", path})`；失败写 `HTTP/1.1 401 Unauthorized` 并销毁 socket。
  - 静态文件 / SPA shell 不经过守卫（前端包里没有密钥）。
- `src/routes/auth.mjs` 的 `register(app)` 注册上述路由并调用 `app.guard(...)`：
  - 放行：`/api/auth/*`、`/api/health`。
  - 其余 `/api/*` 和全部 WS：要求有效 session cookie。
  - 非 GET/HEAD 的 HTTP 请求与 WS 还要校验 `Origin`：必须等于 `TARSBOT_PUBLIC_URL` 的 origin，或本地开发 origin（`http://127.0.0.1:8090`、`http://localhost:8090`、`http://127.0.0.1:5183`、`http://localhost:5183`，仅当 `TARSBOT_PUBLIC_URL` 未设置或为 loopback 时）。缺 Origin 的非 GET 请求拒绝。
- 生产 `server.mjs` 自动加载 `src/routes/*.mjs`，所以 auth 插件总是生效。

### 4.5 前端行为（C3）

- 启动先 `GET /api/auth/me`：401 → 渲染登录页（"使用 Google 登录"按钮跳 `/api/auth/google`；邮箱 + 密码表单 POST JSON 到 `/api/auth/login`）；200 → 渲染主界面，右上角显示 email + 退出。
- 任何 `request()` 收到 401 → 回到登录页，并停止 WS 重连（`useBotStream` / `useApprovals` 只在已登录时挂载）。
- URL 带 `?auth_error=denied` 时登录页显示"该邮箱不在允许名单"；`state` / `exchange` 显示"登录失败，请重试"。展示后用 `history.replaceState` 清掉参数。
- 无注册入口。

## 5. 部署契约（C4）

| 项 | 值 |
|---|---|
| Fly app | `pi-cloud-agents`（被占用时用 `pi-cloud-agents-zilin`，并在汇报中写明） |
| region | `sin` |
| VM | `shared-cpu-1x`，`memory = "512mb"` |
| Volume | `pi_data`，1 GB，挂载 `/data` |
| http_service | `internal_port = 8080`，`force_https = true`，`auto_stop_machines = "suspend"`，`auto_start_machines = true`，`min_machines_running = 0` |
| 健康检查 | `GET /api/health` |
| `[env]`（非密钥） | `TARSBOT_HOST=0.0.0.0`、`TARSBOT_PORT=8080`、`TARSBOT_DATA_DIR=/data`、`TARSBOT_PUBLIC_URL=https://pi.zilin.im`、`TARSBOT_ALLOWED_EMAILS=stackfizztailan@gmail.com,fizzstack@gmail.com`、`TARSBOT_SPRITE_NAME=pi-cloud-agents`、`NODE_ENV=production` |
| Fly secrets | `TOKEN_ROUTER_BASE_URL`、`TOKEN_ROUTER_API_KEY`、`EXA_API_KEY`、`SPRITES_TOKEN`、`GITHUB_TOKEN`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`（只导入名单内且 `.env` 中存在的键，`--stage`，不打印值） |
| 镜像 | `node:24-slim` 多阶段：构建 `web/dist`；运行层 `npm ci --omit=dev`，只拷 `src/`、`scripts/`、`web/dist/`、`package*.json`。`.dockerignore` 必须排除 `.env*`、`data/`、`logs/`、`node_modules/`、`docs/acceptance/` |
| 域名 | `fly certs add pi.zilin.im`；Cloudflare DNS 记录由用户手动加（DNS only） |

## 6. 任务与依赖

任务文件在 `docs/tasks/C*.md`。C1–C6 文件所有权互不重叠，可并行；C7 由编排者在全部合入后执行。

| 任务 | 内容 | 依赖 |
|---|---|---|
| [C1-backend](tasks/C1-backend.md) | 删除 Cua 后端代码/依赖/测试/脚本；Sprites 成为唯一沙箱；`TARSBOT_HOST` | — |
| [C2-auth](tasks/C2-auth.md) | 登录与全局守卫（§4.1–4.4） | — |
| [C3-web](tasks/C3-web.md) | 前端去桌面；登录页与 401 处理（§4.5） | 契约 §4 |
| [C4-deploy](tasks/C4-deploy.md) | Dockerfile、fly.toml、secrets 导入脚本；创建 app 与 volume；远端 build-only 验证；**不部署** | — |
| [C5-sprite](tasks/C5-sprite.md) | 新建并初始化 Sprite `pi-cloud-agents` | — |
| [C6-docs](tasks/C6-docs.md) | README、AGENTS.md、CONTRACTS.md 改为云端版；归档 Cua 文档 | — |
| C7（编排者） | 合并、全量测试、本地 EGO 验收 → Google OAuth 客户端（用户）→ `fly deploy` → 证书与 DNS（用户）→ Fly GitHub Auto-Deploy → 线上 EGO 验收 → 移除旧 worktree → 更新 memo | C1–C6 |

## 7. 并行工作规则

- 每个 worker 只改自己任务文件"只能创建/修改"列出的文件；需要改别人的文件时写进汇报，由编排者集成。
- worker **不** `git commit`、不 `npm start`、不占用 8090/5183 端口；浏览器验收统一在 C7 由编排者用 EGO 浏览器完成。
- 其他 worker 可能同时跑测试；失败若来自别人负责的文件，在汇报中注明后忽略。
- 不读取、打印、回显 `.env` 与任何密钥值；需要时只经 `process.env` 或 `fly secrets import` 管道使用。
- 远端资源只操作本方案点名的：Fly app `pi-cloud-agents`、Sprite `pi-cloud-agents`、测试仓库 `hifizz/tars-sandbox-playground`。不得改动 org 下其他 Sprite（包括 `tarsbot-dev`）和其他 Fly app。

## 8. 验收（C7）

| 级别 | 内容 |
|---|---|
| V0 | `TARSBOT_NO_DOTENV=1 npm test` 全绿；`cd web && npm test && npm run typecheck && npm run build` 通过；仓库内 `grep -ri "trycua\|cua space"` 只剩 `docs/archive/` 与历史任务文件 |
| V1 本地 | EGO 浏览器：密码登录 → 新建 Bot → 让 Bot 在 Sprite `~/workspace` 建文件并回读；未登录访问 `/api/bots` 返回 401 |
| V2 线上 | `https://pi.zilin.im`：Google 登录（白名单邮箱）成功、非白名单被拒；Bot 在 Sprite 中执行 bash；`fly deploy` 重新部署后对话仍在 |
| V3 自动部署 | push 一个只改文档的提交到 `main` → Fly Webhook Deployment，部署 SHA 与提交一致 |

截图存 `docs/acceptance/cloud/`，不得出现 token。
