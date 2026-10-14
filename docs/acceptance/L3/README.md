# L3 验收：S4-recovery（持久性）

日期：2026-10-14。server：`TARSBOT_SANDBOX=sprites`（:8090），Sprite `tarsbot-dev`，测试仓库 `hifizz/tars-sandbox-playground`。

自动化：`scripts/sprites-kill-test.sh`，报告 `docs/sprites-recovery-test.md`（run `20261014-164840`，早先一次完整运行保留为附录）。

| 场景 | 结果 | 要点 |
|---|---|---|
| R1 kill -9：克隆目录出现后立刻杀 | PASS | 续上后只有 1 个 PR，提交无重复；clone 被标 interrupted，Bot 先 `ls` 发现已完整，没有重复 clone |
| R2 kill -9：force push 审批挂起时 | PASS | 重启后同一审批（taskId 707）重新出现；拒绝后 Bot 报告被拒、未绕过；远端 SHA 不变 |
| R3 kill -9：远端分支已存在、PR 未创建时 | PASS（命中窗口 2/2） | 只有 1 个 PR，无重复提交 |
| R3B（额外）kill 发生在 `gh pr create` 运行中 | PASS | 工具结果 interrupted，但 PR 其实已创建；Bot 先 `gh pr list --head` 发现并复用 |
| R4 空闲 ≥180 s 且状态为 cold 后发指令 | PASS | 978 ms 完成，0 次重试；**没能证明 VM 被真正暂停** |
| R5 泄漏检查 | PASS | 4 个密钥的值在 data/（含 sqlite、WAL）、logs/、docs/sprites-*.md、docs/acceptance/ 中均 0 命中，并用假密钥做了正向对照 |

测试仓库清理：脚本创建的 PR #4–#10 已关闭、分支已删除；证据 PR #1–#3 保持 OPEN，SHA 不变（编排者用 `gh` 独立核对）。

## EGO 浏览器验收（新建 TaskSpace，Bot `l3-accept`）

1. 指令：逐条执行 `mkdir -p ~/workspace/l3-scratch && echo hi > …/a.txt`、`rm -rf ~/workspace/l3-scratch`、`ls ~/workspace`。第一条直接执行（1.1 s），第二条出现审批条（`rm -rf`，原因 "recursive force delete"），`01-approval-pending.png`。
2. 审批挂起时对本仓库的 server 进程执行 `kill -9`（按工作目录匹配，不碰另一个 tarsbot 目录的 server），health 变为不可达，再用同样的命令重启。
3. 刷新页面、打开该 Bot：审批条回来了，命令与原因一致，`GET /api/approvals` 里仍是同一个 taskId（891），`02-approval-after-kill9.png`。
4. 点 Approve：Bot 继续执行并汇报，用时 1 分 04 秒、3 步，`03-completed.png`。
5. 独立核对：在 Sprite 里 `ls ~/workspace` 只剩 `hello-browser.txt`、`hello.txt`、`tars-sandbox-playground`，`l3-scratch` 已不存在。

结论：PASS。

## 局限与说明

- 没有观察到 Sprite 被真正暂停（见 `docs/sprites-probe.md`），所以"暂停后唤醒"只验证了"状态为 cold 后下一条命令正常执行"。
- 每个场景在最终运行中只有 1 个样本，模型行为的方差没有测。
- 重启后的行为：被杀时正在运行的 bash 被标记 interrupted，但远端命令不会因 server 断开而终止，可能已经执行完（R1 的 clone、R3B 的 PR）。当前靠系统提示里的"先检查仓库状态、`gh pr list --head` 再开 PR"来兜底，Bot 在 5 个场景里都做对了。
- 浏览器验收中我第一次 `kill` 命令因 zsh 不拆分变量而失败，随后启动的第二个 server 实例在加载存储（`resume done`）后因端口被占用退出；之后重新正确地 kill -9 并重启。health 与审批队列均正常，未见数据异常。
