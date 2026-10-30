# 工作区总览验收

2026-10-30，正常路径 PASS。开发模型 Devin SWE-2（magpie/devin/swe-2），未用 Haiku。

## 实际操作

1. 点击左侧工作区大条目，中央打开总览，显示真实未解决 Issues 与开放未合并 PR。初始 Issue #12，PR #11/#3/#2/#1。截图 `01-overview.png`。
2. 确认总览没有聊天输入框、usage 或 Session 侧栏。
3. 点击 Issue #12，打开原讨论 `14a4c184`。点击前后全局 Session 数都是 8，讨论 entries 都是 23，没有重复会话或重发起始消息。记录 `existing-issue-check.json`，截图 `02-existing-discussion.png`。
4. 在测试仓库创建真实演示 issue #13，返回工作区总览，点击新 issue。自动创建并打开讨论 `1d9ee8cd`，目录 `discussion-38a28d2f`，同一空间与 Sprite。Agent 实际运行 pwd/Git 检查并读取 README，未修改代码。截图 `03-new-discussion.png`，记录 `new-issue-check.json`。
5. PR 条目为指向该测试仓库真实 PR 的外链。无 Review 占位按钮；后续 Review Demo 在另一个 worker 的独立工作树开发，不算本次已完成内容。

## 关键范围

空间 `ws_e168e5f97244a35b`，Sprite `pca-eae56f671c`，不创建新沙箱。总览通过该空间 repo 查询，讨论匹配只认同空间；执行 Session 不误认为讨论。

只在打开总览与手动刷新读取 GitHub，不接入 3 秒 Session 轮询。分页行为由 101 个 issues + 101 个 PR 的离线测试验证；当前读取上限 issues 500 条（GitHub 混合项计数后过滤 PR）、PR 200 条，共享 MAX_PAGES 上限，不声称无限。

## 自动化

worker 最终：后端 356 项，355 pass、1 既有 skip、0 fail；前端 144 项通过；typecheck/build 通过。父级 diff --check 通过，并检查跨工作区匹配已删除宽泛 fallback、总览正确隐藏 Session 界面。

未提交、推送、合并或部署。测试仓库新增演示 issue #13 保留，未关闭或删除任何远端资源。
