# Loops Phase1 现场验收（进行中）

独立worktree /Users/zilin/side/pi-cloud-agents-loops，独立数据 /tmp/pca-loops-acceptance。
control/auth通过SQLite VACUUM INTO复制；harness/registry新建空白，不读写原data会话。仅复用已有sandbox workspace和Sprite。服务切换后同一时刻8090只有一个进程。

- [x] 父级完整后端/前端/typecheck/build通过（日志 /tmp/loops-parent-*.log）。
- [x] EGO 从工作区总览打开Loops，创建 Acceptance read-only，high reasoning，读README指令。
- [x] Run now 实际建 detached worktree，Pi调用read，报告README首行 # TARSBot。历史已完成，Session待确认，来源Loop回链可返回。截图01-run-history.png、02-readonly-session.png。
- [x] 编辑描述，version升2；UI停用后API Run now 409。
- [x] 删除UI：两步确认删除仅本次Webhook UI acceptance定义成功。
- [x] Webhook：secret隐藏展示门保留编辑器，显式显示/确认后跳转，未截图secret；Bearer202/重复同run/错误401/轮换旧值401，见webhook-check.json。
- [x] 定时：UI hourly创建，约一分钟首slot自动运行成功，截图04-schedule-run.png。关闭定时后编辑保留原毫秒startAt和本地时区，禁用状态不被PATCH重置，disabled-edit.json。
- [x] 实际队列：5run中3占槽2排队，取消queued不建bot；kill-9服务恢复原3run，随后剩余run启动，全部对应唯一bot，queue-*.json与recovery-progress.json。
- [x] 实际取消：run_eb2165c8e881b41e已发起sleep120后UI取消，canceled并清空队列，截图05-cancel-running.png。
- [x] code none（Webhook回复）/read（README）/readwrite（队列独立loops分支）均实际创建并执行。
- [x] Standard Webhooks现场：随机密钥仅环境变量注入独立验收server，真实HTTP签名202，重复同run，过期10分钟401；standard-webhook.json。密钥未记录/输出。DST/月年边界只确定性单测，不伪称墙钟全覆盖。
- [x] 新发现修复：datetime-local从UTC转本机时间且未改时保留毫秒，避免历史startAt误判；PATCH描述不再把disabled loop重新启用，已单测和现场重验。

独立review复现取消starting后复活，worker修复后增加真实harness回归；父级同时要求read模式去除任意bash，worker已修。不能仅以无write/edit声称read-only。

验收入口读写分离：不是将Loops混入Issue13分支；后续组合体验集成需另有明确记录。
