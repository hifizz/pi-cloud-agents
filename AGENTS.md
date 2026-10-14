# TARSBot — Agent Guide

TARSBot 是基于 Pi Durable（`@earendil-works/pi-durable`）的自托管常驻 AI 队友系统：每个 Bot 一条持久对话，多个 Bot 共享一台运行在 Cua 容器里的 Linux 桌面（桌面、浏览器、shell、登录态），用户可在 Web UI 上观察、接管、审批。

## 术语约定（务必遵守）

- **Cua**（`/ˈkuːə/`，"cua"）是 trycua 公司出品的计算机使用（computer-use）技术栈与 SDK 的**专有名称**。它是一个专业术语，指代整个产品体系，不是普通名词。
  - 书写形式：**`Cua`**（首字母大写，其余小写）。不要写成 `CUA` / `cua`（作为名词时）/ `C.U.A.`。
  - 例外：包名、环境变量、代码标识符按其原有大小写：`@trycua/cua`、`CUA_SPACE_URL`、`CUA_ENV_TOKEN`、`cua-spacesd`。
- **Cua Space**：Cua 体系中的一个资源类型（在 sandbox 之上叠加桌面 / driver / presence 等能力）。它是一个具体概念，**不等于 Cua 技术本身**。
- 不要以"Cua Space"指代 Cua 整体；讨论部署形态时应先明确走的是 SDK 哪条路径（见下文分层）。
- **Pi Durable**：持久对话、任务恢复、定时例程的底座（`@earendil-works/pi-durable` 1.0.4，API 处于实验阶段）。

## Cua 技术栈分层

Cua SDK（`@trycua/cua`，Rust core + Node/Browser 绑定）的导出面可按接入路径分层：

```
Cua（总入口：embedded() / connect() / http() / tcp()）
├── sandboxes()      → Sandbox —— 沙箱，跑镜像的最小单位
│   ├── runtime: "runc"    → 本地 Linux 容器（如 ghcr.io/trycua/linux:24.04）
│   ├── omarchy            → macOS Apple Container / amd64 VM（Arch Linux + Hyprland）
│   └── cloud / fleet      → trycua 托管沙箱与池化调度
├── spaces()         → Space —— 在 sandbox 之上叠加桌面操控、presence、drive、viewer
│   └── 底层宿主进程：cua-spacesd（Space daemon，HTTP :3211，/viewer/ 桌面串流）
├── driver / tools   → space.callTool(name, args, "driver") —— 桌面操控工具
│   （desktop_screenshot / click / type / key / elements 等，见 docs/driver-tools.txt）
├── mcp              → connectMcp / mcpConnect —— MCP 客户端接入
├── agents / routines→ AgentRun、PersistentAgent、RoutineInfo —— 托管 agent 运行
├── fleet            → 池化容量管理（warm floor、claim token、fleetResolveRuntime）
└── media / teleport / relay / presence / drive —— 串流、文件传输、协同等周边能力
```

### 各路径的宿主机器需求

| 接入路径 | 需要什么机器 |
|---|---|
| `runc` 本地容器 | 任何能跑 Docker 的 Linux：VPS、裸金属、Fly Machine、CI runner。**不需要 KVM / 嵌套虚拟化**（Xvfb 软渲染） |
| `omarchy` VM | macOS（Apple Container）或支持嵌套虚拟化的 amd64 裸金属 |
| `cloud` / `fleet` | 无需自有机器，trycua 托管 |
| `spacesd` over HTTP（`spaces.add(url, token)`） | 客户端侧只需网络可达；宿主需求转移给跑 spacesd 的那台机器 |

### 本仓库当前使用的路径

`src/space.mjs` 的 `getSpaceConfig()` 按优先级选择连接方式：

1. `CUA_SPACE_URL`（+ `CUA_ENV_TOKEN`）环境变量 → `spaces.add(url, token)` 直连已有 `cua-spacesd`；
2. `data/space.json`（由 `scripts/space-up.sh` 写入）→ 同上，连本机 `tarsbot-space` 容器；
3. 否则 `embedded().spaces().create()` 由 SDK 拉起/复用本地容器（无持久卷）。

持久化 Space 的规格（见 `scripts/space-up.sh`）：镜像 `ghcr.io/trycua/linux:24.04`，`--shm-size 2g --memory 4g --cpus 2`，卷挂 `/home/cua`，`CUA_X_SERVER=xvfb`。

Space 实测事实（用户 `cua`、HOME `/home/cua`、driver 工具签名等）以 `docs/CONTRACTS.md` §2 和 `docs/driver-tools.txt` 为准。

## 技术栈与约定

- 后端：Node ≥ 22，纯 ESM `.mjs`，**不用 TypeScript**；依赖版本全部精确锁定。
- 前端：`web/`，React 19 + Vite + Tailwind 4 + TypeScript，生产构建产物 `web/dist/` 由 server 在 :8080 托管。
- API 类型真相以 `node_modules/**/*.d.ts` 为准，不凭记忆猜：
  - pi-durable：`node_modules/@earendil-works/pi-durable/dist/**/*.d.ts`
  - Cua：`node_modules/@trycua/cua/dist/index.d.ts`、`dist/native/cua_sdk.d.ts`
- 参考源码：`vendor-ref/durable-examples/`、`vendor-ref/coding-agent-durable/`（gitignored，仅本地）。
- 接口契约：`docs/CONTRACTS.md`（扩展注册、API 路由约定、pi-durable 关键契约）。与代码冲突时以代码为准并回报。
- 默认模型：**GLM 5.3 Flash**（`glm-5.3-flash`，经 tokenrouter），定义在 `src/config.mjs`，可用 `TARSBOT_MODEL` 覆盖。这只是默认值：`glm-5.3`、`claude-sonnet-5-5`、`gpt-5.6-terra` 都是正常可选的模型（见 `src/models.mjs`），可以在新建 Bot、fork、bench 时指定，不要当作已废弃模型去替换。已有 Bot 换模型用 `node scripts/set-model.mjs <bot> <modelId>`（先停 server）。

## 目录结构

| 路径 | 作用 |
|---|---|
| `src/server.mjs` | 生产入口：harness + bots + API + 静态 UI，自动加载 `src/routes/*.mjs` |
| `src/runtime.mjs` | **唯一集成点**：`productionExtensions()` 扩展顺序（Approval 必须最后）、`productionEnv()` |
| `src/harness.mjs` / `bots.mjs` / `models.mjs` / `config.mjs` | harness 打开、Bot 注册表（`data/bots.json`）、模型网关（OpenAI 兼容）、集中配置 |
| `src/space.mjs` | Space 连接单例、重连预算（`RECONNECT_BUDGET_MS = 60s`）、`callDriver` / `spaceBash` |
| `src/env.mjs` | `ExecutionEnv` 实现（read/write/edit/bash 跑在 Space 内），`DEFAULT_HOME = /home/cua` |
| `src/ext/*.mjs` | pi-durable 扩展：preamble、desktop、search、history、routines、approval |
| `src/routes/*.mjs` | 路由插件，导出 `register(app)`；**不改 `api.mjs` 本体** |
| `src/viewer-proxy.mjs` | 桌面 viewer 代理（127.0.0.1:3299，签名 ticket） |
| `scripts/` | Space 生命周期（`space-up.sh` / `space-down.sh`）与验收脚本 |
| `test/*.test.mjs` | 后端 `node --test`；`test/vitest/` 是需要真实 Space 的一致性测试 |
| `docs/` | 计划、契约、任务 brief（`docs/tasks/*.md`）、验收记录 |
| `data/` | 运行时状态（gitignored），**禁止删除** |

## 常用命令

```bash
orb start                                         # 启动 Docker 运行时（macOS + OrbStack）
npm install && (cd web && npm install && npm run build)
scripts/space-up.sh                               # 拉起持久 Space 容器并写 data/space.json
npm start                                         # server，http://127.0.0.1:8080
npm run repl                                      # 命令行；与 server 共用 sqlite，不能同时运行

TARSBOT_NO_DOTENV=1 npm test                      # 后端单元测试（node --test，离线），必须全绿
npm run test:env                                  # ExecutionEnv 一致性测试（vitest，需要 Space 在跑）
cd web && npm test                                # 前端测试（vitest）
cd web && npm run typecheck                       # 前端类型检查
```

## 开发规则

- 新功能以扩展（`src/ext/`）或路由插件（`src/routes/`）的形式加入，在 `src/runtime.mjs` 集成；不要把逻辑散落到 `server.mjs` / `api.mjs`。
- 对 pi-durable 的依赖收敛在 `env.mjs`、`ext/`、`server.mjs` 三处，方便 API 变动时迁移。
- 离线测试模板：`test/harness.test.mjs`（`fauxProvider` + `MemoryStorage`），新测试不要依赖真实模型或真实 Space。
- 存储只允许一个写进程：server 与 repl 不能同时运行；测试用临时 `TARSBOT_DATA_DIR`。
- 多 worker 并行开发流程：`scripts/worker.sh <task-id>` 按 `docs/tasks/<task-id>.md` 运行 `.kiro/agents/tarsbot-worker.json`。

## 安全红线（部署前必读）

- API :8080 与 viewer 代理 :3299 **没有鉴权**，只绑 `127.0.0.1`。上云前必须加鉴权或仅经 Tailscale/私网暴露。
- **禁止把 Space 的 :3211 暴露到公网。**
- `CUA_ENV_TOKEN` 只存 `data/space.json`（mode 600），**永不打印到日志**（`space.mjs` 的 `getSpaceConfig` 注释与安全测试均覆盖）。
- 所有密钥（`TOKEN_ROUTER_BASE_URL`、`TOKEN_ROUTER_API_KEY`、`EXA_API_KEY` 等）只从 `process.env` / `.env` 读取；禁止打印、写日志、写入 Space 或测试快照。不要读取或回显 `.env`。
- Space 内登录态视为完全信任边界：能执行 `bash` 的主体即拥有全部已登录应用。危险操作走 `src/ext/approval.mjs` 审批。
- 不要删除 `data/`、Docker 卷 `tarsbot-space-home`，不要随意删除/重启 `tarsbot-space`、`tarsbot-probe` 容器。

## 许可注意

Cua Spaces 采用 FSL-1.1-MIT：自用与内部部署不受限，**禁止用本产品构建与 Cua 竞争的商业产品**（README 有同样声明）。

---

# Sprites 分支（feat/sprites-shell）工作约定

本仓库（分支 `feat/sprites-shell`）的 agent 工作约定。任务说明见 `docs/SPRITES-PLAN.md` 与 `docs/tasks/S*.md`。

## 验收：每个大任务完成后，必须用 EGO 浏览器验收

"大任务"指 `docs/tasks/` 下的一个任务文件（如 `S1-env`），或一个验收级别（L0–L3）。单元测试通过不算验收完成。

步骤：

1. 跑完任务文件中的自动化验收（`npm test` 等），全部通过后再做浏览器验收。
2. 启动 server：`npm start`（`http://127.0.0.1:8090`）；改了前端时用 `cd web && npm run build` 后再启动，或用 Vite dev（`http://127.0.0.1:5183`）。
3. 用 EGO 浏览器（ego-browser skill）打开 UI，按任务内容实际操作一遍，例如：
   - 新建 Bot，发一条与本任务相关的指令（S1/S2：在 Sprite 中建文件；S3：开 PR；S4：重启后对话续上）。
   - 检查右栏、审批条、工具调用卡片、Bot 最终回复是否符合预期。
   - 纯后端任务（如 S0、S1-bash）至少确认：UI 能打开，Bot 能完成一次 `bash` 调用且无报错。
4. 截图保存到 `docs/acceptance/<任务ID>/`（如 `docs/acceptance/S2-runtime-ui/01-sidebar.png`），截图中不得出现任何 token。
5. 在任务汇报中写明：操作步骤、观察到的结果、截图路径、PASS / FAIL。FAIL 时附浏览器控制台错误与 server 日志相关片段。

浏览器验收失败时，任务不算完成，先修复再重新验收。

## 其他约定

- 密钥只放在 `.env`（已在 `.gitignore`）；不得打印、写日志、写入 `data/`、测试快照或截图。
- 只修改任务文件"你只能创建/修改"中列出的文件。
- 远端资源只操作 `TARSBOT_SPRITE_NAME` 指定的 Sprite 和测试仓库 `hifizz/tars-sandbox-playground`；同一 org 下的其他 Sprite 不得改动。
