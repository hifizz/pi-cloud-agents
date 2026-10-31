# Phase2 父级复查与自动化验证

时间2026-10-30T22:21Z，分支feat/loops-phase-2，基线0fd371f，尚未commit/PR。

Worker改为bundle→干净bare仓库→固定URL/ref推送。父级发现并直接修复：
- 实际steps全用有凭据bash，和“前两阶段无token”说明不符。现在先要求supportsEnv，export/init/fetch/cleanup显式传GH_TOKEN和GITHUB_TOKEN空值，仅最后clean-context push沿用provider凭据；真实git adversarial测试现在断言并实际应用options.env。
- 原stage使用单引号内$$，不会展开且目录可预测/复用。改randomUUID路径，mkdir非-p且umask077。
- UI只聚合issueLoop，导致新Loop产物不显示。总览增加loopRun executionResult.issue路径，Environment显示Loop result；PR触发号不得当同号Issue关联。
- 保持共享Sprite同一信任域事实：干净配置上下文不等于进程/凭据强隔离。不得宣称regex能防全部shell绕过。

父级独立命令（不是转述worker）：
- TARSBOT_NO_DOTENV=1 npm test：443 total，442 pass，1既有skip，0fail。
- web npm test -- --run：160 pass。
- typecheck与build到/tmp/loops-phase2-parent-dist通过。
- git diff --check通过。
日志/tmp/loops-phase2-parent-{backend,web,build}.log。

仍未验收：真实GitHub webhook/poll跨通道、实际批准push/PR、产物总览与deep link的EGO组合操作。浏览器space8通知权限等待用户确认，不得绕过或新开space规避。Phase2仍不标完成，不进入Phase3，不真实推送。
