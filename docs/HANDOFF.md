# Handoff（2026-10-16）

新会话请在 `~/side/pi-cloud-agents` 打开，先读本文件，再按需读 `AGENTS.md`、`docs/CLOUD-PLAN.md`。

## 现状

- 仓库：私有 `hifizz/pi-cloud-agents`，分支 `main`。它从 `hifizz/tars` 的 `feat/sprites-shell` 分支拆出。旧 worktree `~/side/tarsbot-sprites` 已删除，原分支仍保留在 `~/side/tarsbot`。
- 线上：`https://pi.zilin.im`。
  - 部署在 Fly app `pi-cloud-agents`：region `sin`，1 台常驻 `shared-cpu-1x` 512MB。
  - 数据在 volume `pi_data`（挂载 `/data`）：sqlite 文件 `alice.sqlite` 和 `auth.sqlite`，外加 `bots.json`。
- 执行环境：Sprite `pi-cloud-agents`，实际 8 核 8GB（请求的 4 核 4GB 被服务端忽略），带 checkpoint `v-setup`。同一 org 下其他 Sprite 不能动。
- 登录：只允许两个白名单邮箱，没有注册入口；登录密码已由用户设置。Google 登录代码已写好但未配置也未验证，`/api/auth/google` 返回 503。
- 发布：push `main` 后，Fly 原生 GitHub 集成自动部署（不用 GitHub Actions），已验证。只改文档的提交也会触发部署。
- 验收：V0–V3 全部 PASS，记录见 `docs/acceptance/cloud/README.md`。
- E2B（第二种沙箱，2026-10-16 跑通，未上线）：`TARSBOT_SANDBOX=e2b` 切换；沙箱 `pi-cloud-agents`（ID `i5aamq59qgxgvxovg5ww5`，模板 `base`，2 vCPU / 473 MB + 1 GB swap，空闲 10 分钟自动暂停、下次命令透明恢复）。方案 `docs/E2B-PLAN.md`，探测 `docs/e2b-probe.md`，初始化 `docs/e2b-cloud.md`，验收 `docs/acceptance/E2B/README.md`。线上仍用 Sprites，Fly 上没有 `E2B_API_KEY`。

## 关键文件

| 文件 | 内容 |
|---|---|
| `docs/CLOUD-PLAN.md` | 决策 D1–D9、架构、鉴权契约、部署契约 |
| `docs/tasks/C*.md` | 本轮并行任务 brief，可用 `scripts/worker.sh <id>` 派给 Sonnet 5.5 |
| `docs/DEPLOY.md` | 上线、发布、回滚、设置密码 |
| `docs/sprite-cloud.md` | Sprite 初始化记录 |
| `src/routes/auth.mjs`、`src/auth.mjs` | 登录与全局守卫 |
| `src/sandbox/sprites.mjs` | 沙箱原语，接新沙箱时从这里抽象 |
| `scripts/fly-secrets.sh` | 从 `.env` 导入白名单内的密钥到 Fly，只打印键名 |

外部运维手册：`/Users/zilin/side/anything-work/.agents/memos/pi-cloud-agents-fly-runbook.md`。

## 注意事项

- 单写进程，Fly 上只能有 1 台 Machine。线上设置密码必须以 `node` 用户运行：`setpriv --reuid=node --regid=node --init-groups node /app/scripts/set-password.mjs <email>`。
- 鉴权会校验 `Origin`，只能经 `pi.zilin.im` 登录，`*.fly.dev` 登录不了。
- `TOKEN_ROUTER_API_KEY` 已换成本项目专用的 New API key（已导入 Fly），用量可单独统计。GLM-5.3 Flash 走 ZCode 上游，5 小时额度仍按整个账号计算，被其他调用方用满时会返回 429（1308）。
- `TARSBOT_*` 环境变量和代码里的 "TARSBot" 字样暂不改名（D5）。

## 待办 / 可选下一步

1. Google 登录（用户暂缓）：建 OAuth Web 客户端，回调地址 `https://pi.zilin.im/api/auth/google/callback`，把 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET` 写入 `.env` 后导入 Fly。
2. E2B 后续（可选）：线上切换需把 `E2B_API_KEY` 加入 `scripts/fly-secrets.sh` 白名单并导入、在 `fly.toml` 设 `TARSBOT_SANDBOX=e2b`（已有 Bot 的 cwd 是 `/home/sprite/workspace`，需迁移或新建 Bot）；base 模板内存小，可做自定义模板（更大内存、预装 node 24 / gh / rg）；E2B 未做网络白名单；Hobby 账户沙箱 timeout 上限 1 h。
3. 未验证项：单条 exec 的时长上限、Sprite 真正暂停后的行为、Sprite 的实际 region；E2B 命令执行中途被自动暂停的行为。
