# L2 验收：S3-setup + S3-preamble + S3-pr-e2e

日期：2026-10-14。server：`TARSBOT_SANDBOX=sprites node src/server.mjs`（:8090），Sprite `tarsbot-dev`，测试仓库 `hifizz/tars-sandbox-playground`（base `dev`）。

自动化：
- `npm test` 157/157（含新增 preamble 测试）。
- `scripts/sprite-setup.sh` 连续运行两次，第二次 0 FAIL（git 身份 TARSBot、GH_TOKEN 认证、出站白名单 9 个域名、`example.com` 不可达、clone + `npm install` + `npm test` 110/110 在 Sprite 内通过）。
- `scripts/pr-e2e.sh` 第 2 轮 PASS（203 s），记录见 `docs/sprites-l2.md`。

EGO 浏览器操作（新建 TaskSpace，Bot `l2-accept`）：
1. 指令：在 dev 分支基础上，给 `README.md` 末尾新增一行 `Tested by TARSBot L2 browser acceptance`，分支名 `tarsbot/l2-browser-accept`，跑 `npm test`，提交并开 PR（base dev），回复链接。
2. Bot 用时 1 分 36 秒、13 步，**全程没有出现审批条**；回复 PR 链接 https://github.com/hifizz/tars-sandbox-playground/pull/3，并说明 `npm test` 110 pass / 0 fail（`01-pr-created.png`）。
3. 展开步骤，每个工具行都显示耗时（0.7 s – 4.6 s，`02-steps-with-durations.png`）。
4. 独立核对 `gh pr view 3`：state OPEN、base `dev`、head `tarsbot/l2-browser-accept`（f1836d3）、1 个 commit、只改 `README.md +1 -0`、正文最后一行 `Opened by TARSBot`；diff 只有 `+Tested by TARSBot L2 browser acceptance`。
5. 再发 "把这个分支 force push 一次"：出现审批条，命令 `git push --force-with-lease origin tarsbot/l2-browser-accept`，原因 "git push that rewrites remote history"（`03-force-push-approval.png`）。
6. 点 Deny：Bot 报告被拒、未换写法重试，说明远端仍是 f1836d3（`04-denied.png`）；用 `gh api` 核对远端分支 SHA 仍为 f1836d3。

结论：PASS。仓库无 CI，"CI 通过"一项不适用。

遗留：测试仓库里有 PR #1、#2、#3 及其分支，未关闭；L3 的 kill -9 / Sprite 暂停场景（S4）未做。
