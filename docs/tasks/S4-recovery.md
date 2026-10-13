# Sprites / S4-recovery：L3 持久性验收

依赖：S3-pr-e2e 通过、S4-keepalive。**会在测试仓库创建分支和 PR。**

先读：`docs/SPRITES-PLAN.md` §6 L3；`scripts/kill-test.sh`（server 管理、轮询函数、报告格式）；`docs/recovery-test.md`（Cua 版结论：`bash` 不是 `replay:"safe"`，进程被杀后工具结果标记为 interrupted，由模型决定是否重做）；`scripts/pr-e2e.sh`。

## 你只能创建/修改
- `scripts/sprites-kill-test.sh`（新增）
- `docs/sprites-recovery-test.md`（新增，由脚本生成）
- 失败时 `docs/fail-S4-recovery.md`

## 场景
| ID | 场景 | 通过条件 |
|---|---|---|
| R1 | 发送 L2 指令；Sprite 中出现 `~/workspace/tars-sandbox-playground/.git` 后、远端出现 `tarsbot/*` 分支之前，`kill -9` server 并重启 | 任务续上并完成；最终只有一个 open PR；该分支的提交没有重复（`git log` 中相同 message 的提交只有一个） |
| R2 | 让 Bot 执行 force push，在该审批**挂起时** `kill -9` 并重启 | 重启后审批项重新出现；拒绝后远端分支 SHA 不变，Bot 报告被拒 |
| R3 | 远端出现 `tarsbot/*` 分支后、PR 创建前 `kill -9` 并重启 | 不重复 push 产生多余提交；只有一个 PR（依赖 preamble 中 `gh pr list --head` 的检查） |
| R4 | Bot 空闲到 Sprite 暂停（按 probe 方法确认已暂停）后，发一条新指令（如 `git -C ~/workspace/tars-sandbox-playground log -1`） | 指令成功执行，日志中可见一次唤醒重试 |
| R5 | 泄漏检查 | `data/`、`logs/`、`docs/sprites-*.md` 中 `grep -F` 找不到 `GITHUB_TOKEN`、`SPRITES_TOKEN`、`TOKEN_ROUTER_API_KEY` 的原文（用变量值做 grep，输出只打印命中文件名，不打印值） |

## 要求
- 复用 `kill-test.sh` 的函数（可复制），不修改原脚本。
- 观测 Sprite 内状态一律通过 SDK/CLI exec 完成，不经过 Bot。
- 每个场景开始前清理：关闭上一个场景的 PR，删除远端 `tarsbot/*` 分支，删除 Sprite 中的仓库目录。**清理只针对测试仓库 `hifizz/tars-sandbox-playground`，脚本中写死并校验仓库名。**
- 报告格式参照 `docs/recovery-test.md`。

## 验收（L3）
- R1–R5 全部 PASS，或对 FAIL 给出根因分析（属于 TARSBot / pi-durable / Sprites 哪一层）和修复建议。

最后输出：各场景结果、报告路径、发现的问题。
