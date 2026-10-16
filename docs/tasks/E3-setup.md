# E2B / E3-setup：创建并初始化正式 E2B 沙箱 `pi-cloud-agents`

依赖：E1 已完成（`src/sandbox/e2b.mjs`、`scratch/e2b-exec.mjs`、`docs/e2b-probe.md` 已存在）。E2 可能在并行修改 `src/config.mjs` 等文件，与你无关。

先读：`docs/E2B-PLAN.md`（全文）、`docs/e2b-probe.md`（E1 的探测结论：用户、HOME、缺哪些工具、sudo、暂停恢复行为）、`src/sandbox/e2b.mjs`（`findE2bSandbox`、`createE2bBash` 的用法）、`scripts/sprite-setup.sh` 与 `scratch/sprite-setup.mjs`（全文；步骤结构、`report()` 输出格式、gh 安装方式、`CRED_HELPER`、verify 步骤照此实现）、`docs/sprite-cloud.md`（记录格式）。E2B API 以 `node_modules/e2b/dist/index.d.ts` 为准。

## 你只能创建/修改

- `scripts/e2b-setup.sh`、`scratch/e2b-setup.mjs`（新建）
- `docs/e2b-cloud.md`（新建，结果记录）
- `scripts/pr-e2e.sh`：仅把 `/api/space` 的 `sandbox` 检查放宽为 `sprites` 或 `e2b`，并在提示/报告里显示实际沙箱；不要改别的逻辑
- 失败时 `docs/fail-E3-setup.md`

**不要碰**：`src/`、`test/`、`web/`、`.env`、其他脚本。远端：E2B 只操作 metadata `{ app: "pi-cloud-agents", name: "pi-cloud-agents" }` 的沙箱（以及验证中你自己创建、结束前删除的东西）；不得 kill/暂停其他沙箱（包括 E1 可能残留的 `probe-*`——发现时只在汇报里列出）。GitHub 只读测试仓库 `hifizz/tars-sandbox-playground`（clone / ls-remote / `gh repo view`），不推送。

## 要求

1. `scripts/e2b-setup.sh [--no-npm] [--recreate]`：与 `sprite-setup.sh` 同形（有 `.env` 时 `node --env-file=.env scratch/e2b-setup.mjs`，否则只用环境变量）。需要 `E2B_API_KEY`、`GITHUB_TOKEN`、`TARSBOT_GIT_EMAIL`；`TARSBOT_E2B_NAME`（默认 `pi-cloud-agents`）**必须**等于 `pi-cloud-agents`，否则拒绝运行。幂等，可重复执行；任一步 FAIL 时退出码 1。密钥不打印、不写入沙箱。
2. 步骤（每步一行 `OK|SKIP|FAIL <步骤> <说明>`）：
   1. 查找/创建：用 `findE2bSandbox` 查找；不存在则 `Sandbox.create(template, { metadata: { app: "pi-cloud-agents", name }, timeoutMs: idle, lifecycle: { onTimeout: "pause" } })`（`autoResume` 等取值按 `docs/e2b-probe.md` 的结论，写明理由）。若找到多个同名沙箱 → FAIL 并列出 ID，不自动删除。`--recreate`：kill 现有的同名沙箱后重建（仅此名）。记录模板、沙箱 ID、规格（`nproc`、`free -m`、`df -h ~`）。
   2. 工具：确保 git、gh、node、npm、python3、curl、jq 可用（按探测结论：apt 需要 sudo 就用免密 sudo；gh 照 sprite-setup 的 release tarball 方式装到 `~/.local/bin`）。确保 `~/.local/bin` 在非交互 `sh -c` 与 `bash -c` 的 PATH 里（E2B 用什么 shell 启动命令以 E1 结论为准；`SandboxEnv` 默认用 `/bin/bash -c` 跑 LLM 命令，外层是 `sh -c`）。用 `which gh` 经生产原语 `e2bBash` 验证，而不是只在交互 shell 里验证。
   3. git：与 sprite-setup 相同的 credential helper（读 `$GH_TOKEN`）、`user.name = TARSBot`、`user.email = $TARSBOT_GIT_EMAIL`（只在命令 envs 里传入，不落盘到沙箱以外的位置——写进 `~/.gitconfig` 的 email 可以）。
   4. 工作目录 `~/workspace`。
   5. verify（全部经 `src/sandbox/e2b.mjs` 的生产原语，即 Bot 实际走的路径）：
      - 版本：`git --version`、`gh --version`、`node --version`、`npm --version`、`python3 --version`、`jq --version`。
      - `git ls-remote https://github.com/hifizz/tars-sandbox-playground.git` 成功（GH_TOKEN 注入）；`gh repo view hifizz/tars-sandbox-playground --json name`。
      - 除非 `--no-npm`：clone 测试仓库到 `~/workspace/tars-sandbox-playground`（已存在则 `git fetch` + `git status`），`npm ci`（或 `npm install`）+ `npm test`，记录耗时与通过数。
      - 确认沙箱磁盘上没有 token：`grep -rIl` 在 `~` 下（排除 `node_modules`）搜 `GITHUB_TOKEN` 的值；搜索时值只经 envs 传入并在命令中引用变量，输出只报是否命中。
      - 暂停/恢复：写入 `~/.e2b-setup-marker`（内容为时间戳）→ `Sandbox.pause(id)` → 确认 `Sandbox.list` 状态为 paused → 经生产原语执行 `cat ~/.e2b-setup-marker && which gh` → 应透明恢复并读出同一时间戳；记录恢复耗时。
   6. 结束：不 kill 沙箱。打印最终状态与剩余超时（如可得）。
3. `docs/e2b-cloud.md`：沙箱名、ID、模板、规格、lifecycle 设置、每步结果、verify 输出摘要（脱敏）、npm test 结果、暂停/恢复耗时、验证日期 2026-10-16、已知限制（例如网络白名单未做、账户最大 timeout、暂停保留期）。只写键名，不写任何密钥或访问 token。

## 验收

- `scripts/e2b-setup.sh` 退出码 0；再运行一次仍为 0（幂等，主要是 SKIP）。
- 运行后用 `node --env-file=.env scratch/e2b-exec.mjs exec 'echo ok && ls ~/workspace && gh --version | head -1 && git config --global user.name'` 冒烟，输出（脱敏）贴进汇报。
- `bash -n scripts/pr-e2e.sh` 通过。

最后输出：改动文件、创建的远端资源（沙箱 ID）、规格、命令与结果摘要、未验证项、需要编排者注意的事。
