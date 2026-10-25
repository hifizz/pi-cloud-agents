# pi-cloud-agents — Agent Guide

pi-cloud-agents 在云端常驻运行基于 Pi Durable（`@earendil-works/pi-durable`）的 Bot：每个 Bot 一条持久对话，属于一个工作区（一个 GitHub 仓库 + 分支），每个工作区一台自己的 Fly.io Sprite（`pca-*`），用户在 Web UI 上观察、审批。方案见 `docs/M1-PLAN.md`。服务部署在 Fly Machine，经 `https://pi.zilin.im` 访问，仅白名单邮箱可登录。方案与决策见 `docs/CLOUD-PLAN.md`。

代码中的 `TARSBOT_*` 环境变量与 "TARSBot" 字样是历史遗留，暂不改名。

## 术语

- **Pi Durable**：持久对话、任务恢复、定时例程的底座（`@earendil-works/pi-durable` 1.4.0，API 处于实验阶段）。
- **Sprite**：Fly.io Sprites 云沙箱，Bot 的 bash / 文件操作都在其中执行（工作区的 `cwd`，默认在 `/home/sprite/workspace` 下）。
- **工作区（workspace）**：一个仓库 + 分支 + 一台 Sprite + 控制库里的一组记录；会话必须属于工作区。
- **runner**：`src/runner/runner.sh`，装在 Sprite 里，让命令在服务重启、页面关闭后仍可接续。
- **沙箱原语**：`bash(command, {timeoutMs})`，由 `src/providers/<provider>.mjs` 按 runtime 提供，见 `docs/CONTRACTS.md`。

## 技术栈与约定

- 后端：Node ≥ 24，纯 ESM `.mjs`，**不用 TypeScript**；依赖版本全部精确锁定。
- 前端：`web/`，React 19 + Vite + Tailwind 4 + TypeScript，生产构建产物 `web/dist/` 由 server 托管。
- API 类型真相以 `node_modules/**/*.d.ts` 为准，不凭记忆猜：
  - pi-durable：`node_modules/@earendil-works/pi-durable/dist/**/*.d.ts`
  - Sprites：`node_modules/@fly/sprites/` 下的类型
- 参考源码：`vendor-ref/durable-examples/`、`vendor-ref/coding-agent-durable/`（gitignored，仅本地）。
- 接口契约：`docs/CONTRACTS.md`。与代码冲突时以代码为准并回报。
- 默认模型：**SWE-2**（`swe-2`，经 tokenrouter），定义在 `src/config.mjs`，可用 `TARSBOT_MODEL` 覆盖。这只是默认值：`glm-5.3-flash`、`glm-5.3`、`claude-sonnet-5-5`、`gpt-5.6-terra` 都是正常可选的模型（见 `src/models.mjs`），可以在新建 Bot、fork、bench 时指定，不要当作已废弃模型去替换。已有 Bot 换模型用 `node scripts/set-model.mjs <bot> <modelId>`（先停 server）。

## 目录结构

| 路径 | 作用 |
|---|---|
| `src/server.mjs` | 生产入口：harness + bots + API + 静态 UI，自动加载 `src/routes/*.mjs` |
| `src/runtime.mjs` | **唯一集成点**：`productionExtensions()` 扩展顺序（Approval 必须最后）、`productionEnv()` |
| `src/harness.mjs` / `bots.mjs` / `models.mjs` / `config.mjs` | harness 打开、Bot 注册表（`bots.json`）、模型网关（OpenAI 兼容）、集中配置 |
| `src/env.mjs` | `ExecutionEnv` 实现（`SandboxEnv`，只依赖传入的 `bash` 原语） |
| `src/workspace-env.mjs` | 会话 → 工作区 → 绑定 → provider.bash → `SandboxEnv` 的 env 工厂 |
| `src/control/` | 控制库（`control.sqlite`）：项目、工作区、步骤、绑定、会话关联、意图日志、检查点 |
| `src/providers/` | 运行环境供应商（`sprites.mjs`：每个工作区一台 Sprite；`instabox.mjs`：每个工作区一台 InstaBox 机器，`TARSBOT_PROVIDER` 选择，见 `docs/INSTABOX-PLAN.md`） |
| `src/runner/` | Sprite 内的 runner（`runner.sh`）与 Node 客户端（`client.mjs`） |
| `src/workspaces.mjs` / `workspace-rebuild.mjs` / `checkpoint.mjs` / `github.mjs` | 工作区服务、重建、手动检查点、GitHub 薄封装 |
| `src/sandbox/sprites.mjs` | Sprites exec 原语（`createSpritesBash`、`redactMessage`），由供应商使用 |
| `src/sandbox/instabox.mjs` | InstaBox REST exec 原语（`createInstaboxBash`、`instaboxApi`、`waitOperation`），由供应商使用 |
| `src/auth.mjs` | 登录核心：白名单、scrypt 密码、session、Google OAuth（`node:crypto` + `node:sqlite`） |
| `src/routes/auth.mjs` | 鉴权路由与全局守卫；其余 `src/routes/*.mjs` 为路由插件，导出 `register(app)`，**不改 `api.mjs` 本体** |
| `src/ext/*.mjs` | pi-durable 扩展：preamble、search、history、routines、approval |
| `scripts/` | 运维与验收脚本（`set-password.mjs`、`set-model.mjs`、Sprite 初始化等） |
| `test/*.test.mjs` | 后端 `node --test` |
| `web/` | 前端 |
| `Dockerfile` / `fly.toml` | Fly 部署镜像与配置 |
| `docs/` | 方案（`CLOUD-PLAN.md`）、契约（`CONTRACTS.md`）、部署（`DEPLOY.md`）、任务 brief（`tasks/`）、验收记录（`acceptance/`）、历史归档（`archive/`） |
| `data/` | 本地运行时状态（gitignored），**禁止删除**；线上为 Fly Volume `/data` |

## 常用命令

```bash
npm install && (cd web && npm install && npm run build)
npm start                                         # 本地 server，http://127.0.0.1:8090
node scripts/set-password.mjs <email>             # 设置白名单邮箱的登录密码

TARSBOT_NO_DOTENV=1 npm test                      # 后端单元测试（node --test，离线），必须全绿
cd web && npm test                                # 前端测试（vitest）
cd web && npm run typecheck                       # 前端类型检查

fly deploy                                        # 手动部署（push main 也会经 Fly GitHub 集成自动部署）
fly logs                                          # 线上日志
fly ssh console   # 线上设置密码：进入后执行 setpriv --reuid=node --regid=node --init-groups node /app/scripts/set-password.mjs <email>
```

## 开发规则

- 新功能以扩展（`src/ext/`）或路由插件（`src/routes/`）的形式加入，在 `src/runtime.mjs` 集成；不要把逻辑散落到 `server.mjs` / `api.mjs`。
- 对 pi-durable 的依赖收敛在 `env.mjs`、`ext/`、`server.mjs` 三处，方便 API 变动时迁移。
- 运行环境供应商（`src/providers/<name>.mjs`）提供 `ensure` / `init` / `bash` / `status` / `list` / `release`；任何创建、删除路径都必须先过 `provider.isManaged()`；文件与 exec 逻辑留在 `env.mjs`。新工作区用哪个供应商由 `TARSBOT_PROVIDER`（默认 `sprites`）决定；InstaBox 供应商需 `INSTABOX_API_KEY`，且 free plan 一个 org 最多 5 台机器。
- 离线测试模板：`test/harness.test.mjs`（`fauxProvider` + `MemoryStorage`），新测试不要依赖真实模型或真实 Sprite。
- 存储只允许一个写进程：Fly 只跑 1 台 Machine；测试用临时 `TARSBOT_DATA_DIR`。

## 安全红线

- 所有 API 与 WebSocket 必须经鉴权（`src/routes/auth.mjs` 守卫）；不要新增绕过守卫的入口。
- `TARSBOT_AUTH_DISABLED=1` 仅限本地 loopback 开发；`TARSBOT_HOST` 非 loopback 时必须启动即抛错，不得削弱这一检查。
- 所有密钥（`TOKEN_ROUTER_BASE_URL`、`TOKEN_ROUTER_API_KEY`、`EXA_API_KEY`、`SPRITES_TOKEN`、`GITHUB_TOKEN`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 等）只从 `process.env` / `.env` / Fly secrets 读取；禁止打印、写日志、写入 Sprite、测试快照或截图。不要读取或回显 `.env`。
- Sprite 内 `bash` 是完全信任边界：能执行 bash 的主体拥有 Sprite 内全部登录态。危险操作走 `src/ext/approval.mjs` 审批。
- 不要删除 Fly Volume `/data`、本地 `data/`，不要删除 Sprite `pi-cloud-agents`。
- 远端资源只操作：旧共享 Sprite `pi-cloud-agents`；本应用按工作区创建的 Sprite（名称以 `pca-` 开头**且**带标签 `app:pi-cloud-agents`，代码里由 `provider.isManaged()` 判定，任何创建、删除路径都必须先过它）；Fly app `pi-cloud-agents`；测试仓库 `hifizz/tars-sandbox-playground`。org 下其他 Sprite 与 Fly app 一律不得改动。
- 旧共享 Sprite `pi-cloud-agents`（及 `TARSBOT_SPRITE_NAME` 指向的）永远不是受管资源，不得通过 `release` 等路径删除；`pca-` Sprite 只有测试清理和明确的「释放」操作可以删除，且同时存在数量要有上限（M1 验收期间不超过 3 个）。

## 验收

每个"大任务"（`docs/tasks/` 下的一个任务文件，或一个验收级别）完成后，必须用 EGO 浏览器验收；单元测试通过不算验收完成。

1. 先跑完任务文件中的自动化验收（`npm test` 等），全部通过。
2. 启动 server：`npm start`（`http://127.0.0.1:8090`）；改了前端时先 `cd web && npm run build`，或用 Vite dev（`http://127.0.0.1:5183`）。
3. 用 EGO 浏览器（ego-browser skill）打开 UI，按任务内容实际操作一遍（登录、新建 Bot、让 Bot 在 Sprite 中执行 bash、审批条、工具调用卡片等）。
4. 截图保存到 `docs/acceptance/<任务ID>/`，截图中不得出现任何 token。
5. 汇报写明：操作步骤、观察结果、截图路径、PASS / FAIL。FAIL 时附浏览器控制台错误与 server 日志相关片段；失败则任务不算完成，先修复再验收。

**并行 worker 不做浏览器验收**（不 `npm start`、不占用 8090/5183 端口），由编排者在合入后统一做。

## 其他约定

- 并行 worker 只修改任务文件"你只能创建/修改"中列出的文件，不 `git commit`；需要改别人文件时写进汇报。
- 多 worker 并行开发流程：`scripts/worker.sh <task-id>` 按 `docs/tasks/<task-id>.md` 运行 `.kiro/agents/tarsbot-worker.json`。
