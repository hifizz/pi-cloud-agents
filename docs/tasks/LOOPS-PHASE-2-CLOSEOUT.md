# Phase2 收尾离线检查（父级做现场与发布）
用户已确认Phase3延期Issue22，只收尾Issue13+Phase2。独占loops worktree当前未提交版本，保留父级修复：supportsEnv无token stage+UUID，String conversationId，modelTools.add工具对象，poll runtime.NextTaskState，权限checkbox和poll lifecycle，Loop结果总览，publish branch metadata。

任务：补齐便宜的完整装配回归与发现的缺陷，禁止新功能扩展。
1. 真harness GitHub-capable run ->模型可见send_git_push/send_github_open_pr ->审批前零calls ->拒绝无副作用。测试实际数字conversationId映射，防重演现场bug。真实临时SQLite poll healthy已有test。
2. 事件矩阵（issue opened/labeled/closed/assigned/commented, PR opened/ready/labeled/merged/checks_failed/review）：原始webhook和真实reader shape通过ingest，双向dedup，负transition再正transition，多loop不互吞，跨repo不串，匹配过滤缺字段fail closed。
3. 检查事件/条件语义是否错用所有labeled作为“状态条件”；有便宜可证缺陷修最小点。检查schema保存是否丢github权限。
4. UI结果和published worktree branch已有父级修复，补render测试（不是自己拼字符串断言）。Api machine delivery失败redelivery保留至少一次成功投递。
5. 有外部依赖或hard隔离做不到必须精确写限制。不要为达标新建sandbox/服务/调用模型或真实GitHub。不得更改当前branch/commit/push。

允许src/loops/*、src/routes/loops.mjs、必要test/loops*.mjs、web/test/loops.test.tsx、小范围相关UI修复。必要其他文件改动报告父级。命令90s有界，总20min checkpoint。最后完整backend+web/typecheck/build到/tmp，输出精简回执和剩余验收矩阵。父级不会同时写此worktree，主amp13 worktree另行收尾。
