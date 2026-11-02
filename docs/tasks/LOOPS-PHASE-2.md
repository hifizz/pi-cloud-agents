# Loops Phase2 GitHub 事件和产出
用户要求Issue14所有阶段与Issue13功能可组合使用。Phase1父级实际验收通过，commit0fd371f，Draft PR#21 base feat/loops。现在独立分支feat/loops-phase-2基于0fd371f；后续PR base feat/loops-phase-1，禁止直接merge/push。

阅读LOOPS-ISSUE-14.md Phase2全部要求。实现GitHub HMAC webhook+轮询规范化去重、过滤/开始匹配、作用域GitHub写工具、readwrite分支提交push开PR产出记录、用户确认任务草稿发布。不要自动merge。只offline，父级远端/EGO。

架构必须考虑Issue13当前src/github-events.mjs（主仓库只读参考）：它是已有Session订阅投递，Loops是新run。不能用全局event已处理就吞掉另一个loop应收到的事件；摄取去重与per-destination投递去重分层。不要把GitHub Events API视为包含所有Checks/Reviews的完整feed，按Issue14timeline/checks接口补齐，缺API窗口明确状态。只读参考Issue19调研，不把其所有结论当事实。保留手动已有行为。

允许修改 src/loops/*.mjs、src/routes/loops.mjs、src/routes/auth.mjs(精确GitHub机器认证)、src/github.mjs、src/runtime.mjs、src/server.mjs(最小装配)、src/bots.mjs、src/config.mjs、src/routes/workspaces.mjs(共享publish语义必要接缝)、web/src/lib/loops.ts、web/src/components/Loop*.tsx、web/src/App.tsx、web/src/types.ts、test/loops-*.test.mjs、web/test/loops.test.tsx、docs/tasks/LOOPS-PHASE-2-NOTES.md。不改Phase1data/migration除实际需要并说明，不改其他worktree。

权限硬要求：只读无bash保持。code readwrite shell不等于授权所有GitHub写能力，scope/openPr=false不得通过gh/curl/bash间接绕过。GitHub写工具由服务端持有token，工具自身校验repo/触发对象/开关；始终审批，Phase3再开放明确autoapprove。不要给loop shell注入能绕过capabilities的GitHub token（需要provider/env接缝则报告父级）。自动merge禁止是执行约束，不仅prompt和无merge工具。Webhook全局guard真正验证rawbody HMAC、常量时间、大小/重放限速；不免登录一大片路径。

父级现场安全边界允许最终在sandbox仓库真实create commit/push PR，仅父级验收且显式工具审批；worker禁止远端操作。GitHub事件由GitHub webhook/poll同一canonical event key可对应时去重，不可凭不同deliveryID宣称跨通道exactly once。编写真实输入fixtures覆盖方向互换、两个loop同时收到一个事件、self-comment事件环过滤、失败不得记录成功、disabled不触发。

测试默认真实faux harness+MemoryStorage/临时控制库，fakeGithub/fakeprovider，无模型/Sprite/网络，命令90s bounded。Build临时outDir不改web/dist。Phase1 full suite保持。25min checkpoint，如做不完列准确缺口，不把stubs当完整。先写数据流/工具权限说明后实现。最终短回执+详细NOTES， no commit/push/server/browser/subagents/credentials。
