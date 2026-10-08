# TARSBot

自托管的常驻 AI 队友：pi-durable 做主脑（持久对话、崩溃恢复、定时例程），Cua Space 容器做它的 Linux 电脑（桌面、浏览器、shell）。计划见 `docs/PLAN.md`，接口契约见 `docs/CONTRACTS.md`。

## 本地运行（macOS + OrbStack）

```bash
orb start                       # Docker 运行时
npm install && (cd web && npm install && npm run build)
scripts/space-up.sh             # 带持久卷的 Space 容器 tarsbot-space（127.0.0.1:3211）
npm start                       # http://127.0.0.1:8080
```

`.env`（不提交）需要：`TOKEN_ROUTER_BASE_URL`、`TOKEN_ROUTER_API_KEY`（OpenAI 兼容模型网关），`EXA_API_KEY`（web_search）。默认模型 `glm-5.3-flash`，可用 `TARSBOT_MODEL` 改；已有 Bot 换模型：停掉 server 后运行 `node scripts/set-model.mjs <bot> <modelId>`。

- Web UI：左边是 Bot 列表和例程，中间是聊天（思考、工具卡片、steer/queue/abort、审批条、从任意消息 fork），右边是实时桌面（通过 127.0.0.1:3299 的 viewer 代理，链接带签名 ticket）。
- 命令行：`npm run repl`（与 server 共用 `data/alice.sqlite`，**不要和 server 同时运行**，存储只允许一个写进程）。
- 测试：`npm test`（后端，离线）、`npx vitest run test/vitest`（ExecutionEnv 一致性测试，需要 Space）、`cd web && npm test`。
- 验收脚本：`scripts/ask.mjs`、`scripts/kill-test.sh`、`scripts/approval-test.sh`、`scripts/routine-test.sh`、`scripts/gui-bench.mjs`。

## 安全

- API（8080）和 viewer 代理（3299）**没有鉴权**，只绑定 127.0.0.1。部署到云主机之前必须先加鉴权，并且只通过 Tailscale 或私网暴露。
- 密钥只存在于宿主机 server 进程的环境变量里，不会写进 Space。Space 内的登录态视为完全信任边界。
- `rm -rf`、`git push`、`curl -X POST` 这类 bash 命令，以及 send/deploy 类工具，都会先进入审批（`src/ext/approval.mjs`）。

## 数据

`data/alice.sqlite`（全部对话与状态，不要删除）、`data/bots.json`、`data/space.json`（Space 地址与 token，权限 600）、Docker 卷 `tarsbot-space-home`（/home/cua，包括浏览器登录态）。
