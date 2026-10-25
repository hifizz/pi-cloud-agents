# instabox 接入验收（离线 + 真实沙箱 + 真实开源 PR）

日期：2026-10-25 · 分支：`feat/instabox-sandbox`（worktree `/Users/zilin/side/pca-instabox`）· 结果：**PASS**

## 真实开源 PR（swe-2 全流程，2026-10-25 追加）

任务：在公开仓库 `hifizz/jev-readability` 找一个真实改进并提 PR。结果：**PR #1 已创建** —
<https://github.com/hifizz/jev-readability/pull/1>（`fix: validate <ol start> in Markdown renderer to prevent NaN/hex numbering`，`src/render.ts` +6/-2、新增 `test/render.test.mjs` +31，沙箱内 `npm test` 63 pass / 0 fail，body 末行 `Opened by TARSBot`）。

- bot（swe-2）自主完成：clone → 读代码/测试/文档/issues → 定位真实 bug（`renderMarkdown` 用 `Number(attr||1)`，`start="abc"`→NaN、`0x10`→16、`3e2"`→300，与 `renderHtml` 的正则白名单分叉）→ 修复 + 3 个新测试 → 分支 `tarsbot/ol-start-markdown-fix`（提交 `dfb0aad`）→ push → `gh pr create`，全程 19 分钟 58 步。
- 审批流实测：`gh api -X POST` 被审批条拦截；bot 试图用 `title=test` 占位标题建 PR 被**拒绝**并引导回规范流程（preamble 的 stop-and-report 行为符合设计）。
- 认证演进（环境问题，记入 INSTABOX-PLAN 已知事项）：`.env` 的 fine-grained PAT 无写权限且 GitHub 已禁 PAT 走 git HTTPS → `git push` 与 `gh api` 建 ref 均失败；改用 thread-chatbot 的 GitHub App `tc-workbench-acceptance`（用户授权借用）铸 1 小时 installation token（`contents:write` + `pull_requests:write`），经 `gh auth setup-git` + `git push` 完成。
- 借用的 App token 用后已删除（`/tmp`，且本身 1 小时过期）；探测用 `pca-perm-probe` ref 已删。

## 操作步骤

1. 离线：`TARSBOT_NO_DOTENV=1 npm test` → **196 pass / 0 fail**（`test/instabox.test.mjs` 29 项）；`cd web && npm run typecheck && npm test && npm run build` → 0 错 / 96 pass / build OK。
2. 真实 API 探测：`node --env-file=.env scratch/instabox-probe.mjs` → **14/14 PASS**（自建 `pca-probe-*` 机器，结束自动删除）。关键实测：
   - create 需要 `templateId`（文档页的 `template: "universal"` 被拒）；free plan 只允许 `agent-browser` 模板；
   - 202 响应是裸 Operation 对象；`GET /v1/machines/{name}` 支持按名字查询；404 码是 `not_found`；
   - exec 超时 kill 且 `exitCode=124`；suspended/stopped 的机器 exec 一律 `409 machine_not_running`（不会自动唤醒）→ provider 的 start 兜底路径覆盖，P10b 验证 start 恢复 suspended 后 exec 正常；
   - `/data` 跨 stop/start 持久。
3. 真实 setup：`node --env-file=.env scripts/instabox-setup.mjs` → 6 步全 OK，机器 `pi-cloud-agents`（id `m_agqw6y6o6xdga33z553nhaltiy`，agent-browser 模板自带 git 2.47 / gh 2.102 / node 22 / python3 / jq，guest 用户 `user`）。
4. 端到端：worktree 内 `TARSBOT_SANDBOX=instabox TARSBOT_AUTH_DISABLED=1 TARSBOT_PORT=8099 TARSBOT_DATA_DIR=data-instabox-live node src/server.mjs`，EGO 浏览器给 tars bot 发任务「执行 uname -sr && pwd && ls -la /data/home/workspace」。
5. 观察结果：Bot 5 秒完成 1 步 exec，回复 `Linux 6.18.54-instabox /data/home/workspace total 8 drwxrwxr-x 2 user user 4096 ...`——命令真实跑在 InstaBox 机器里（内核签名 `6.18.54-instabox` 与 setup 自检一致）。UI 三处显示 InstaBox（IB 徽标 / 环境条 / Environment 面板）。server 日志无错误。

## 截图

- `01-environment-pane.png` / `02-environment-panel.png`：离线验收（UI 显示链路）
- `03-main-view.png` / `04-environment-open.png`：UI 效果（IB 徽标 + InstaBox 环境条 + Environment 面板）
- `05-live-bot-exec.png`：**Bot 在 InstaBox 真实执行 bash 的对话**（含工具调用与原始输出）
- `06-swe2-coding.png`：swe-2 写并运行 primes.js（写文件 + exec 混合）
- `07/08-oss-pr-*.png`：开源 PR 任务过程（探索、审批条、blocked-on-push 报告）
- `09-oss-pr-created.png`：**PR #1 创建成功的对话与链接**

截图与日志中无任何 token（探测/setup 输出经 redact 处理；UI 不显示密钥）。

## 资源说明

- 测试 key 为用户临时提供（org free plan，5 沙箱上限）。为腾配额，经用户确认删除了其旧沙箱 `agent-browser-spdi`；其余 4 个（pi-agent / claude / devin / kiro）未动。
- 探测自建的 `pca-probe-*` 已删除；正式机器 `pi-cloud-agents`（metadata `app=pi-cloud-agents`）保留供后续使用，空闲 30 分钟自动 suspend，下次命令自动经 start 恢复。
