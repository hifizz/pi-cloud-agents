# TARSBot

TARSBot 是**基于 Pi Durable 核心开发的自托管常驻 AI 队友系统**。

[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)（`@earendil-works/pi-durable`）是系统的基础，负责持久对话、任务恢复与定时例程编排。TARSBot 在此基础上提供多 Bot 管理、Web 交互与 Cua Space 桌面操作能力。

每个 Bot 拥有一条持久对话，多个 Bot 共享一台容器化的 Linux 电脑（桌面、浏览器、shell、登录态）。你可以在网页上观察它工作，随时接管或纠偏。

> **License 提示**：本仓库未附带许可证。其依赖 Cua Spaces 采用 FSL-1.1-MIT —— 自用与内部部署不受限，但禁止用本产品构建与 Cua 竞争的商业产品。

## 快速开始（macOS + OrbStack）

前置：**Node ≥ 24**（本分支 `feat/sprites-shell` 依赖 `@fly/sprites`，要求 Node 24；仓库根目录有 `.nvmrc`）、OrbStack（Docker 运行时）。

切换 Node 24（只影响当前 shell，不改全局默认）：

```bash
nvm install 24 && nvm use      # 或：fnm install 24 && fnm use
node -v                        # v24.x
```

```bash
orb start                                   # 启动 Docker
npm install && (cd web && npm install && npm run build)
scripts/space-up.sh                         # 起 Space 容器 tarsbot-space（127.0.0.1:3211）
npm start                                   # http://127.0.0.1:8090
```

`.env`（不提交）必填：`TOKEN_ROUTER_BASE_URL`、`TOKEN_ROUTER_API_KEY`（OpenAI 兼容模型网关）、`EXA_API_KEY`（web_search）。默认模型 `glm-5.3-flash`，用 `TARSBOT_MODEL` 覆盖；已有 Bot 换模型：停掉 server 后 `node scripts/set-model.mjs <bot> <modelId>`。

## 使用

打开 `http://127.0.0.1:8090`（本分支端口：API 8090、viewer 3309、Vite dev 5183，与 main 的 8080/3299/5173 错开）：

- **左栏**：Bot 列表与定时例程（routines，跨重启定时任务）。
- **中栏**：聊天。可以看到思考与工具调用卡片；Bot 忙时可 `steer`（当前工具轮结束后生效）、`queue` 或 abort；可从任意消息 **fork** 出新 Bot（继承分叉点之前的历史）。
- **右栏**：实时桌面（经 127.0.0.1:3309 viewer 代理，带签名 ticket）。你的光标和 Bot 的光标相互独立，可随时接管（比如手动登录）再交还。
- 危险操作（`rm -rf`、`git push`、send/deploy 类工具等）会先停在**审批条**，批准一次后随任务持久化，重启不再重复询问。

命令行替代：`npm run repl` —— 与 server 共用 `data/alice.sqlite`，**不能和 server 同时运行**（存储只允许一个写进程）。

## 测试与验收脚本

| 命令 | 用途 |
|---|---|
| `npm test` | 后端单元测试，离线 |
| `npm run test:env` | ExecutionEnv 一致性测试，需要 Space 在跑 |
| `cd web && npm test` | 前端测试 |
| `scripts/ask.mjs` | 冒烟：发一条问答 |
| `scripts/kill-test.sh` | 验证 kill 后恢复 |
| `scripts/approval-test.sh` | 验证审批流 |
| `scripts/routine-test.sh` | 验证定时例程 |
| `scripts/gui-bench.mjs` | GUI 操控成功率基准 |

## 安全（部署前必读）

- API（8090）与 viewer 代理（3309）**没有鉴权**，只绑定 127.0.0.1。上云主机前必须先加鉴权，并且只经 Tailscale 或私网暴露。**禁止把 Space 的 3211 端口暴露在公网。**
- 密钥只存在于宿主机 server 进程环境变量，不写进 Space。Space 内的登录态视为完全信任边界 —— 能用 `bash` 的主体即拥有全部已登录应用。
- 审批规则见 `src/ext/approval.mjs`。

## 数据

| 位置 | 内容 |
|---|---|
| `data/alice.sqlite` | 全部对话与状态，**禁止删除** |
| `data/bots.json` | Bot 配置 |
| `data/space.json` | Space 地址与 token（权限 600） |
| Docker 卷 `tarsbot-space-home` | Space 的 `/home/cua`，含浏览器登录态 |

备份：停 server → 备份 `data/` → 需要保留登录态时保留该卷。

## 文档

- 产品技术规范（需求/验收 REQ/TEST 编号）：[`DurableBot 产品技术规范（ASD-STE100） .md`](DurableBot%20产品技术规范（ASD-STE100）%20.md)
- 系统设计（架构与工作包）：[`DurableBot 系统设计文档（Pi Durable + Cua Spaces） .md`](DurableBot%20系统设计文档（Pi%20Durable%20+%20Cua%20Spaces）%20.md)
- 开发计划：[`docs/PLAN.md`](docs/PLAN.md)；接口契约：[`docs/CONTRACTS.md`](docs/CONTRACTS.md)

## 已知限制

- pi-durable API 处于实验阶段（依赖收敛在 `env.mjs`/`ext/`/`server.mjs` 三处）。
- GUI 操控成功率依赖模型能力；无障碍树优先，必要时降级为 shell 型 Bot。
- 单写进程：server 与 repl 不能同时开。
