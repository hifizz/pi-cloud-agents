# Cloud / C4-deploy：Fly.io 部署配置（准备，不上线）

依赖：无（与 C1–C3、C5、C6 并行）。**本任务不得执行 `fly deploy`**（鉴权与 Cua 删除合入前不能暴露到公网），上线在 C7 由编排者完成。

先读：`docs/CLOUD-PLAN.md` §3、§5、§7；`package.json`、`web/package.json`、`src/server.mjs`、`src/config.mjs`、`.gitignore`。Fly 配置语法以官方文档为准（`fly.toml` reference、volumes、http_service、checks、secrets import），不要凭记忆。本机已登录 `flyctl`（org `personal`）。

## 你只能创建/修改

- 新建 `Dockerfile`、`.dockerignore`、`fly.toml`
- 新建 `scripts/fly-secrets.sh`
- 新建 `docs/DEPLOY.md`
- 失败时 `docs/fail-C4-deploy.md`

**不要碰**：`src/`、`web/`、`test/`、`package*.json`、`.env`（只能通过脚本按键名读取，不得打印）、README / AGENTS（C6）。

## 要求

1. `Dockerfile`（多阶段）：
   - build 阶段 `node:24-slim`：`web/` 下 `npm ci && npm run build`。
   - runtime 阶段 `node:24-slim`：`npm ci --omit=dev`；拷贝 `src/`、`scripts/`、`package*.json`、build 阶段的 `web/dist/`；非 root 用户运行（`node` 用户），`/data` 由 volume 提供（确保运行用户可写：可用 entrypoint 在启动时 `chown`，或 fly.toml `[mounts]` 配合 `uid`，选官方文档支持的方式）；`ENV NODE_ENV=production`；`EXPOSE 8080`；`CMD ["node", "src/server.mjs"]`。
   - 镜像中不得包含 `.env*`、`data/`、`logs/`、`docs/acceptance/`、`vendor-ref/`。
2. `.dockerignore`：至少排除 `.env*`、`data`、`logs`、`node_modules`、`web/node_modules`、`web/dist`、`.git`、`docs/acceptance`、`vendor-ref`、`scratch`、`bench`。
3. `fly.toml`：按 §5 表格。另加 `kill_signal = "SIGTERM"`、`kill_timeout = 30`；`[deploy] strategy` 选适合"单机 + volume"的策略并注释原因；`[[http_service.checks]]` 用 `GET /api/health`（grace period 足够 harness 恢复，如 30s）。
4. 创建 Fly 资源（允许，这些不会暴露服务）：
   - `fly apps create pi-cloud-agents --org personal`（名称被占用则用 `pi-cloud-agents-zilin`，并同步改 `fly.toml` 与 §5 中 `TARSBOT_*` 不受影响）。
   - `fly volumes create pi_data --region sin --size 1 --app <app> --yes`（已存在则跳过）。
5. `scripts/fly-secrets.sh`：从 `.env` 中只挑 §5 的密钥名单（存在才导入），通过管道 `fly secrets import --stage --app <app>` 导入；**不得 echo / 打印任何值**，只打印导入了哪些键名、缺失哪些键名。执行一次（`GOOGLE_CLIENT_*` 此时可能还没有，属正常缺失）。用 `fly secrets list --app <app>` 确认键名（该命令只显示 digest）。
6. 验证构建：`fly deploy --build-only --remote-only --app <app>`（只构建镜像，不创建 Machine、不发布）。若 build-only 在当前 flyctl 版本不可用，改用 `docker build`（需 `orb start`）并说明。构建时当前工作树可能处于 C1/C3 改动中途，构建失败若来自 `src/`/`web/` 的半成品，记录后在汇报中注明。
7. 镜像检查：确认镜像内无 `.env`（可在 build 日志中用 `RUN test ! -e .env` 之类的守卫步骤断言）。
8. `docs/DEPLOY.md`：部署架构、首次上线步骤（C7 用）、日常发布（Fly 原生 GitHub Auto-Deploy）、`fly ssh console -C "node scripts/set-password.mjs <email>"`、查看日志、volume 快照与恢复、回滚（`fly releases` / `fly deploy --image`）、费用说明（链接 Fly 定价页，不写死价格）。只写键名，不写任何密钥值。

## 验收

- `fly config validate --config fly.toml` 通过。
- 远端 build-only 成功（或说明原因）。
- `fly apps list`、`fly volumes list --app <app>`、`fly secrets list --app <app>` 结果（只贴键名）。
- `fly machines list --app <app>` 为空（证明没有上线）。

最后输出：创建的文件、创建的 Fly 资源、命令与结果摘要、未验证项、C7 上线时需要的具体命令。
