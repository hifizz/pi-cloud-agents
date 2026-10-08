# Batch 3 / Task 11（WP5）：持久卷 + 崩溃恢复

先读：`docs/CONTRACTS.md`、`docs/PLAN.md` Task 11、规范 §4.1 F01 与 §4.4 F04、`src/space.mjs`、`src/env.mjs`、`src/server.mjs`、`scripts/ask.mjs`（验收辅助）、`vendor-ref/durable-examples/13-recovery.ts`、`node_modules/@trycua/cua/dist/native/cua_sdk.d.ts`（Spaces.add / create 的 options，`spacesd` 鉴权 token 相关字段）。

背景：当前 Space 容器 `tarsbot-probe` 由 SDK `create()` 创建，**没有持久卷**。本任务新建一个带持久卷的容器 `tarsbot-space`，并让系统改用它。**不要删除 `tarsbot-probe`**（保留作对照，可 `docker stop`）。

## 你可以创建/修改
- `scripts/space-up.sh`、`scripts/space-down.sh`、`scripts/kill-test.sh`
- `src/space.mjs`（**授权修改**：保持现有导出签名不变）
- `test/space.test.mjs`、`test/recovery.test.mjs`
- `docs/recovery-test.md`、失败时 `docs/fail-WP5.md`

## 要求
1. `scripts/space-up.sh`：幂等。
   - 研究 `ghcr.io/trycua/linux:24.04` 镜像需要的启动参数（`docker inspect tarsbot-probe` 可看到 SDK 用的 env/端口/cap/shm 等，照抄必要项），`docker run -d --name tarsbot-space --restart unless-stopped -p 127.0.0.1:3211:3211 -v tarsbot-space-home:/home/cua ...`。
   - 若 spacesd 需要 token：生成强随机 token（`openssl rand -hex 32`），只写入 `data/space.json`（`{url, token, container}`，权限 600），不打印。
   - 等待 `http://127.0.0.1:3211/viewer/` 返回 200。
2. `src/space.mjs`：连接优先级 `CUA_SPACE_URL` env > `data/space.json` > SDK create（现状）。用 `spaces.add(url, token, name)`（已注册则复用 `list()` 中同 url/name 的条目）。`/api/space` 的 viewerUrl 逻辑在 `src/routes/space.mjs`，你可以导出 `getSpaceConfig()` 供它用，但**不要改 routes/space.mjs**——在汇报里写明需要的改动。
   - 容器重启后句柄失效：`withSpace` 已有"失败重置重试一次"，确认它在 `docker restart tarsbot-space` 后真实可用（可能需要等待 spacesd 就绪：重试带退避，总时长 ≤ 60s）。
3. `scripts/kill-test.sh`：三个场景，各自打印 PASS/FAIL 并把证据写进 `docs/recovery-test.md`：
   - **F01-1**：server 运行中让 Bot 执行长任务（例：`bash` 里 `for i in $(seq 1 20); do echo $i; sleep 1; done` 后写文件），任务进行中 `kill -9` server，重启 server，确认：该 run 被 resume 并最终结束（非 safe 的 bash 得到 interrupted 结果，模型据此继续/回答），对话里可见 interrupted 工具结果，最终有 assistant 回答。
   - **F01-2**：`docker restart tarsbot-space`，之后让 Bot 执行一次 bash（如 `uname -a`）成功。
   - **F01-3**：长任务中同时 `kill -9` server 与 `docker restart` 容器 → 重启 server → 系统不崩溃，`GET /api/bots` 正常，Bot 状态最终空闲或给出明确的 interrupted/错误结果（可人工接管），无静默错乱。
   - **F04-0/1**：在 `/home/cua` 写文件 → 重启容器 → 文件仍在；（登录态）用 Chromium profile 目录持久化证明：重启前 `ls ~/.config/chromium` 记录，重启后仍在（真实网站登录无法自动化，写明这一点）。
4. server 进程管理：用 `node --no-warnings src/server.mjs` 后台启动，日志写 `logs/server-*.log`，用 `curl /api/health` 等待就绪。测试前若 8080 已有编排者的 server 在跑，先 `pkill -f "node --no-warnings src/server.mjs"` 再自行启动；**测试结束后保持一个 server 在后台运行**（连新容器），并在汇报里说明。
5. 离线单测：`space.mjs` 的连接优先级逻辑（mock SDK）。

## 验收
- `npm test` 全绿。
- `scripts/kill-test.sh` 全部 PASS，`docs/recovery-test.md` 含每个场景的命令、时间线、关键事件/条目摘录。
- `GET /api/space` 返回新容器的 viewer（如需改 routes/space.mjs，汇报给编排者）。

最后输出：改动文件、测试结果、kill-test 结果、未验证项、需要编排者的集成改动。
