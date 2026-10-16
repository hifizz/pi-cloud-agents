# E2B 沙箱验收（E4，2026-10-16）

结果：**PASS**

## 自动化

| 项 | 结果 |
|---|---|
| `TARSBOT_NO_DOTENV=1 npm test` | 164/164 通过（含 `test/e2b.test.mjs` 27 条、`test/sandbox-select.test.mjs`） |
| `cd web && npm test && npm run typecheck && npm run build` | 73/73 通过，typecheck 与 build 通过 |
| pi-durable ExecutionEnv conformance（`TARSBOT_SANDBOX=e2b npx vitest run test/vitest`，真实沙箱 `pi-cloud-agents`） | 24/24 通过，70 s |
| `scripts/e2b-setup.sh`（E3，连续两次） | 退出码 0；测试仓库 `npm test` 110 通过；暂停 → 透明恢复验证通过 |

## 浏览器（EGO）

启动：`TARSBOT_MODEL=swe-2 TARSBOT_SANDBOX=e2b TARSBOT_E2B_LOG=1 TARSBOT_AUTH_DISABLED=1 TARSBOT_DATA_DIR=<临时目录> npm start`（只改沙箱，鉴权未改动，所以本地关闭鉴权；默认模型 GLM-5.3 Flash 当时 ZCode 额度用尽返回 429/1308，按用户要求换成 `swe-2`）。

1. 打开 `http://127.0.0.1:8090/`：Environment 栏显示 `E2B pi-cloud-agents`、工作目录 `/home/user/workspace`；`GET /api/space` = `{"sandbox":"e2b","name":"pi-cloud-agents","cwd":"/home/user/workspace"}`。
2. 给 Bot `tars`（`tokenrouter/swe-2`）下达：用 write 写 `~/workspace/hello-e2b.txt`，bash 执行 `whoami && pwd && uname -sr && cat …`，以及 `git ls-remote` 测试仓库。
3. 观察：15 s 内完成 3 步；Shell 输出 `user`、`/home/user/workspace`、`Linux 6.1.158+`、`hello from e2b`；`git ls-remote` 返回 `3157db0… HEAD` 与 `refs/heads/dev`（GH_TOKEN 经 envs 注入，凭据可用）。server 日志 `[e2b]` 条目显示首条命令 `resumed:true`（沙箱从暂停中恢复），后续命令 250–530 ms。

截图：`01-bot-on-e2b.png`（步骤列表）、`02-shell-output.png`（展开的 Shell 输出）。截图中无 token。
