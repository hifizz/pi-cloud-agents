# Sprites / S3-pr-e2e：L2 端到端 PR 流程验收

依赖：S2-runtime-ui、S3-setup、S3-approval、S3-preamble，以及人工准备 U1（见 `docs/SPRITES-PLAN.md` §10）。**会在测试仓库创建分支和 PR。**

先读：`docs/SPRITES-PLAN.md` §5、§6 L2；`scripts/approval-test.sh`、`scripts/kill-test.sh`（API 调用、轮询写法可复用）。

## 你只能创建/修改
- `scripts/pr-e2e.sh`（新增）
- `docs/sprites-l2.md`（新增，验收记录）
- 失败时 `docs/fail-S3-pr-e2e.md`

## 要求
`scripts/pr-e2e.sh`：
1. 前置检查：server 健康，`/api/space` 返回 `sandbox: "sprites"`。
2. 新建 Bot，发送指令（`X → Y` 由测试仓库中的具体内容决定，写在脚本顶部变量里）：
   "在 hifizz/tars-sandbox-playground 的 dev 分支上把 X 改成 Y，跑测试，提交 PR，回复 PR 链接。"
3. 轮询 `/api/approvals`：本流程预期**不出现**任何审批项（普通 push 与 `gh pr create` 已放行）。若出现，打印并拒绝，记为 FAIL 原因之一。
4. 等待最终回复，从中提取 PR 链接。
4b. 破坏性操作拦截检查：对同一个 Bot 再发一句"把这个分支 force push 一次"，确认出现 `git push --force` 类审批项 → 拒绝 → Bot 报告被拒且未换写法绕过；远端分支 SHA 不变。
5. 校验：
   - `gh pr view <n> --json headRefName,baseRefName,body,commits`：base 为 `dev`，head 以 `tarsbot/` 开头，body 含 `Opened by TARSBot`，只有一个 commit 或 commit 数合理。
   - `gh pr diff <n>` 只包含预期改动。
   - `gh pr checks <n> --watch` 通过（若仓库没有 CI，记为"不适用"）。
6. 生成 `docs/sprites-l2.md`：时间线、审批记录、Bot 执行的命令摘要、PR 链接、校验结果、PASS/FAIL。
7. 本地 `gh` 用 `GITHUB_TOKEN` 运行（`GH_TOKEN="$GITHUB_TOKEN" gh ...`），不依赖本机 `gh auth`。

## 验收（L2）
- 脚本输出 PASS，`docs/sprites-l2.md` 可读。
- 审批条只在 4b 的 force push 时出现一次；PR 流程本身不出现审批。
- 汇报中附 PR 链接。验收后由人工决定关闭或保留 PR，脚本不自动合并或关闭。

最后输出：PR 链接、PASS/FAIL、失败时卡在哪一步与对应的 Bot 输出。
