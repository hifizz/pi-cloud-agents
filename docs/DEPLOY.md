# 部署（Fly.io）

## 架构

- Fly app `pi-cloud-agents`，region `sin`，单台 Machine（`shared-cpu-1x` / 512 MB），常驻（不 auto-stop）。
- Volume `pi_data`（1 GB）挂载到 `/data`：`alice.sqlite`、`auth.sqlite`、`bots.json`。存储只允许单写进程，所以只能 1 台 Machine；`fly.toml` 的 `[deploy] strategy = "immediate"` 原地替换机器（rolling / bluegreen 需要第二台机器，与单 volume 冲突）。
- 镜像：`node:24-slim` 多阶段（`Dockerfile`）。入口脚本以 root 启动，`chown` `/data` 后用 `setpriv` 降权到 `node` 用户。
- 非密钥配置在 `fly.toml` `[env]`；密钥在 Fly secrets（键名：`TOKEN_ROUTER_BASE_URL`、`TOKEN_ROUTER_API_KEY`、`EXA_API_KEY`、`SPRITES_TOKEN`、`GITHUB_TOKEN`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`）。
- 健康检查：`GET /api/health`（grace 30s）。

## 首次上线

```bash
fly config validate --config fly.toml
fly apps create pi-cloud-agents --org personal          # 已创建则跳过
fly volumes create pi_data --region sin --size 1 --app pi-cloud-agents --yes   # 已创建则跳过
scripts/fly-secrets.sh                                   # 从 .env 暂存白名单键（只打印键名）
fly deploy --app pi-cloud-agents                         # 同时发布已暂存的 secrets
fly scale count 1 --app pi-cloud-agents                  # 确认只有 1 台
fly certs add pi.zilin.im --app pi-cloud-agents          # 然后在 Cloudflare 手动加 DNS 记录（DNS only）
fly certs show pi.zilin.im --app pi-cloud-agents
fly ssh console --app pi-cloud-agents
# 进入后以 node 用户执行（以 root 执行可能让 /data 下 sqlite 的 -wal/-shm 变成 root 所有，server 将无法写入）：
setpriv --reuid=node --regid=node --init-groups node /app/scripts/set-password.mjs <email>
```

Google OAuth 客户端创建后补充：把 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 写入本地 `.env`，再运行 `scripts/fly-secrets.sh` 和 `fly deploy`。回调地址：`https://pi.zilin.im/api/auth/google/callback`。

## 日常发布

在 Fly 控制台启用 GitHub 集成（Fly.io GitHub App），选择仓库 `hifizz/pi-cloud-agents` 与分支 `main`；push `main` 即自动部署（不使用 GitHub Actions）。手动发布：`fly deploy`。

## 运维

```bash
fly logs --app pi-cloud-agents
fly status --app pi-cloud-agents
fly ssh console --app pi-cloud-agents
```

## Volume 快照与恢复

```bash
fly volumes list --app pi-cloud-agents
fly volumes snapshots list <volume-id>
fly volumes snapshots create <volume-id>
# 恢复：从快照新建 volume，再让 Machine 使用它
fly volumes create pi_data --snapshot-id <snapshot-id> --region sin --app pi-cloud-agents
```

恢复前先停 Machine；不要删除原 volume，直到确认新 volume 数据无误。

## 回滚

```bash
fly releases --app pi-cloud-agents --image
fly deploy --image registry.fly.io/pi-cloud-agents:<tag> --app pi-cloud-agents
```

## 费用

按 Fly 官方定价计费，见 <https://fly.io/docs/about/pricing/>。主要项目：1 台 shared-cpu-1x 512 MB Machine、1 GB volume 及快照、出网流量；另有 Sprite 的用量。
