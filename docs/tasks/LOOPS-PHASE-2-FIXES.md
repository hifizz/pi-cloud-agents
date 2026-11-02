# Phase2 阻塞修复（父级实际源码审查）

当前Phase2不能验收。以下均必须解决而不是列Phase3候选。保留已有代码，最小修复。

1. 仓库隔离：ingestGithubEvent目前global listEnabledGithub不检查workspace.repo；canonicalKey无repo前缀，issue编号仅repo内唯一。必须在摄取和每个loop投递前验证workspace repo精确匹配，key包含repo+稳定对象/event id，缺repo拒绝，跨repo不可共享dedup。测试两个repo同issue号不互吞/不串。
2. 双通道实际去重：normalizePollEvent丢commentId/reviewId/baseRef等，webhook comment key与poll key根本不同。补GitHub reader保留真实稳定id；不能仅人工构造含id的归一化fixture通过。用实际Github event原始shape从reader到ingest全链路测试。label重复取消再加、issue reopen->close不能永久去重；label/check版本需可靠eventID/时间与状态区分，不可无条件只按实体号。
3. 条件：branch/author过滤字段缺失时现在放行；fail closed或明确补取对象。事件触发与条件触发不可混淆；开始匹配的negative事件要更新matchState，例如unlabeled/reopened使后续再次匹配可触发。多事件loop state不能互相误抑制。
4. 自反馈环：PAT actor是hifizz不是[bot]，只过滤bot后缀不能防本应用comment触发自己。保存自身产出commentID并忽略/标注对应反馈，或具体loop+origin lineage门，禁止靠payload字符串猜。
5. 权限：runContext使用当前loop.capabilities而非run版本快照，正在跑的旧run可能被编辑扩权；用run创建时快照，额外收紧可行但不可扩大。scopeToTrigger/openPr=false是硬限制，人工批准bash不是允许绕过禁用capability。现有共享Sprite内任何bash本质信任边界，不宣称强隔离。至少Loop执行bash必须不注入GH_TOKEN且禁止GitHub远程写通过该入口，GitHub提交推送用服务端批准的窄工具，固定repo/own branch/base、禁force/hooks/config/external commands。允许新增provider/env/workspace-env/exec必要seam（只本worktree），不影响普通Session；避免在命令文本拼token。真正安全受控commit/push若做不了就明确BLOCKED，不声称有pushed branch。
6. publish复用原loop worktree/branch会并发写，还复制loopRun.runId到新bot破坏run->bot权限。必须fresh worktree/branch从pinnedSha起，fresh会话首条严格confirmed文本，不复制loopRun权限上下文（另source relation）。任务不能为空、超限拒绝、有独立metadata供组合面板。
7. PR产出必须可用：目前open_pr要求已push但实现无受控push工具，report说pushed branch无依据。补安全工具后才能现场开PR；title/body强限制超限失败不是静默truncate；正文含run链接并关联触发issue，run/result概览可见。

允许范围扩大至上述provider/env/exec接缝，仍不改主AMP13。不做远端/server/browser/commit/push/subagents。每测试90s有界；新测试证明实际bug，不只静态名单断言。最多25分钟先checkpoint；完成不了清楚列出不能实现的硬约束，父级决定，不偷换需求。最终简短回执+NOTES。
