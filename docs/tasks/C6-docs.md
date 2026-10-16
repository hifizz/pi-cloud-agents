# Cloud / C6-docs：仓库文档改为 pi-cloud-agents

依赖：无（与 C1–C5 并行）。按 `docs/CLOUD-PLAN.md` 描述的**目标状态**写文档，不必等代码完成。

先读：`docs/CLOUD-PLAN.md`（全文）；现有 `README.md`、`AGENTS.md`、`docs/CONTRACTS.md`、`.gitignore`；`docs/` 目录列表。

## 你只能创建/修改/移动

- `README.md`、`AGENTS.md`、`docs/CONTRACTS.md`
- 移动到 `docs/archive/`（用 `git mv`）：根目录 `DurableBot 系统设计文档（Pi Durable + Cua Spaces） .md`、`DurableBot 产品技术规范（ASD-STE100） .md`；`docs/PLAN.md`、`docs/driver-tools.txt`、`docs/gui-success.md`、`docs/recovery-test.md`、`docs/fail-web-features.md`、`docs/tasks/B*.md`（整体移到 `docs/archive/tasks/`）。新建 `docs/archive/README.md` 一段话说明这些是 TARSBot/Cua 时期的历史文档。
- `docs/SPRITES-PLAN.md`、`docs/sprites-*.md`、`docs/tasks/S*.md`、`docs/acceptance/**`：保留原位（Sprites 验证历史），只在 `docs/SPRITES-PLAN.md` 顶部加一行"历史文档：在 TARSBot 本地运行阶段完成；云端方案见 `docs/CLOUD-PLAN.md`"。
- 失败时 `docs/fail-C6-docs.md`

**不要碰**：代码、`docs/CLOUD-PLAN.md`、`docs/tasks/C*.md`、`docs/DEPLOY.md`（C4）、`docs/sprite-cloud.md`（C5）。

## 要求

1. `README.md`（中文）：项目定位（云端运行 Pi Durable Bot + 可插拔云沙箱，目前为 Fly.io Sprites）；线上地址 `https://pi.zilin.im`（白名单登录）；架构图（取自 CLOUD-PLAN §3）；本地开发（Node 24、`npm install`、`cd web && npm install && npm run build`、`.env` 需要的键名列表、本地用 `scripts/set-password.mjs` 设置密码或 `TARSBOT_AUTH_DISABLED=1`、`npm start` → `http://127.0.0.1:8090`、Vite dev 5183）；测试命令；部署指向 `docs/DEPLOY.md`；安全说明（白名单、无注册、Sprite 内 bash 即完全信任边界、密钥只在 Fly secrets / `.env`）。删除所有 Cua、OrbStack、viewer、:3211、FSL 许可相关内容。说明代码中 `TARSBOT_*` / "TARSBot" 命名是历史遗留、暂不改名。
2. `AGENTS.md`：重写为 pi-cloud-agents 的 agent 指南。保留并改写：技术栈与约定（Node ≥ 24、纯 ESM、精确锁版本、web 技术栈、以 `.d.ts` 为准、模型列表与 `TARSBOT_MODEL` 段落原样保留）、目录结构（去掉 space/viewer/desktop，加入 `src/sandbox/`、`src/auth.mjs`、`src/routes/auth.mjs`、`Dockerfile`、`fly.toml`、`docs/DEPLOY.md`）、常用命令（去掉 orb/space-up；加 `fly deploy`、`fly logs`、`fly ssh console`）、开发规则（扩展 / 路由插件 / runtime.mjs 唯一集成点 / 离线测试模板 / 单写进程）、安全红线（改写：API 必须经鉴权；`TARSBOT_AUTH_DISABLED` 仅限 loopback；密钥规则；Sprite 信任边界；不删 `/data` volume 与 Sprite `pi-cloud-agents`；只操作 `pi-cloud-agents` Sprite 与测试仓库 `hifizz/tars-sandbox-playground`，不得改动 org 下其他 Sprite）。保留"每个大任务完成后用 EGO 浏览器验收、截图存 `docs/acceptance/<任务ID>/`、截图不得出现 token"的规则，并补充：并行 worker 不做浏览器验收，由编排者统一做。删除全部 Cua 术语、分层、许可、"Sprites 分支工作约定"中与旧分支相关的内容。
3. `docs/CONTRACTS.md`：删除 Cua Space 事实（§2 等）、desktop 扩展与 viewer 相关条目；加入 sandbox 原语契约（CLOUD-PLAN §3）和鉴权契约摘要（指向 CLOUD-PLAN §4，不重复全文）。pi-durable 关键契约部分保持不变。
4. 文档中只写密钥键名，不写任何值；不写真实 token、cookie、连接串。

## 验收

- `grep -rn -i "cua\|orbstack\|spacesd\|3211\|viewer" README.md AGENTS.md docs/CONTRACTS.md` 无结果（若有必要的历史说明，汇报中逐条列出理由）。
- 所有相对链接指向存在的文件（`docs/DEPLOY.md`、`docs/sprite-cloud.md` 由 C4/C5 并行创建，允许此时尚不存在，汇报中注明）。

最后输出：改动/移动文件列表、grep 结果、未验证项。
