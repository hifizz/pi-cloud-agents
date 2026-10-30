# issue-loop 现场验收

结果：正常路径 PASS。2026-10-30T16:08:58Z 停止开发。分支 `spike/issue-loop`，不合并。

## 实际操作

1. 本地 http://127.0.0.1:8090 真实密码登录。现有 UI 创建测试仓库空间，等待就绪。后续不再创建 Sprite。
2. 创建测试仓库真实 issue #12 和评论。浏览器中一次显式 POST `.../issue-loop/discuss`，正文 `{issue:12}`，返回 200。
3. 左边出现 `issue-12-discuss`，点击打开。标题栏为 detached @ 3157db0。Agent 实际执行 pwd/Git 命令，读取代码和 README，完成分析。
4. 输入带 `DISCUSSION_ONLY_7e91` 标记的续聊，Agent 回答确认。点击「发布任务」，输入区为空，没有自动填入调研。截图 `01-discussion-publish-empty.png`。
5. 输入 `published-task.txt` 的任务，点击「确认发布」。左边出现并自动打开 `issue-12-exec`。截图 `02-execution-created.png`。
6. 点击灰色「来自讨论：issue-12-discuss」，返回原讨论。截图 `03-backlink-return.png`。
7. 再打开执行 Session。Agent 在执行目录创建 DEMO-EXECUTION.txt，未提交、推送或开 PR。截图 `04-execution-complete.png`。
8. 点击 Environment，显示执行目录与执行分支，没有旧空间 PR、checkpoint 或 rebuild 操作。截图 `05-execution-environment.png`。

## 可复核证据

- `discussion.json`：真实触发响应。
- `discussion-git.json`：detached、空分支名、完整 SHA，讨论创建前后 refs 无新增功能分支。
- `final-git.json`：原目录、讨论与执行三个 worktree；后两者同 SHA、不同目录；执行文件未出现在讨论目录。
- `discussion-entries.json`、`execution-entries.json`：真实 conversation 记录。
- `message-check.json`：执行唯一用户消息逐字等于发布任务；无讨论标记；真实评论及两份宿主文档摘录确实在讨论消息中。

空间 `ws_e168e5f97244a35b`，runtime `pca-eae56f671c` v1。讨论 conversation 79，执行 conversation 130。基线 `main`，完整 commit `3157db095cb9344e5b9cf0669657bf613d036b46`。

讨论目录 `/home/sprite/issue-loop/ws_e168e5f97244a35b/discussion-e77cc0f6`。
执行目录 `/home/sprite/issue-loop/ws_e168e5f97244a35b/execution-291b5107`，分支 `tarsbot/issue-12-14a4c184`。

## 自动化

- 父级在最后补充 CLOUD-PLAN 摘录后重新运行后端：347 项，346 pass、1 既有 skip、0 fail。
- worker 最终前端：136 项通过，typecheck、build 通过。父级随后只改后端摘录及文档，没有再改前端。
- git diff --check 通过。

## 限制与过程偏差

- 测试准备阶段原来没有可用测试空间，用户授权页面操作后新建了一个。讨论和执行均复用它，未创建第二台实验沙箱。
- 准备前账户已有 6 台受管 Sprite，准备后 7 台。没有删除已有资源。项目指南的「M1 验收期间不超过 3 台」是历史 M1 限制，本次未声称满足该全局数量；本实验新增上限为 1 台。
- 同空间单可写 Session 限制由实验入口绕过。未实现并发写锁、事务补偿或崩溃恢复。
- 真实 issue、评论、Git 检出与 Session，无运行假载荷。真实密码登录，未绕过鉴权。
- 目标仓库缺少两份指定文档，因此使用明确标注为宿主项目背景的摘录。PR 材料仅为指向基线的 open PR，不是完整关联检索。
- 基线前进时仍用 pinned SHA 由离线测试覆盖。未为验收修改远端 main。
- worker 首轮 30 分钟超时，保留 diff 后续跑一次完成。浏览器原 task space 被关闭，获得用户授权后恢复验收。期间定位到一个 8765 的无关 tab，未导航或修改该 tab，立即交还空间。
- EGO 一次按按钮完整 accessible name 等待超时，实际按钮名称包含 busy 状态；通过当前 snapshot 定位后正常点击。不是产品失败。
- 本地 server 留在 8090；最终结果页面留给用户查看。不提交、不推送、不建 PR、不合并，不删除 data 或 Sprite。

## 值得保留的交互

- 点讨论条目，立即使用现有聊天继续问答。
- 点发布，看到空白任务框，明确写下要执行的内容。
- 确认发布后自动打开执行 Session。
- 点灰色来源文字，返回原讨论。
