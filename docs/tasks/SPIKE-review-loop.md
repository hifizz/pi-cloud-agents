# SPIKE-review-loop：PR Review、Session 状态与结果回流 Demo

用户明确要求另开子代理并行探索这三项。使用 Devin SWE-2，不用 Haiku。独立工作树 `/Users/zilin/side/pi-cloud-agents-review-demo`，分支 `spike/review-loop-demo`，基于已验收 commit 703847f。不提交、不推送、不建 PR、不合并。

主工作树的另一个 worker 正在实现工作区总览。不要访问或修改主工作树文件。父级后续统一接线，不把本任务做成全新产品系统。

## 最小产品路径

### PR 一键 Review

- 一个已鉴权动作接受当前空间和 PR 编号，从该空间绑定仓库读取 PR 标题、正文、base/head SHA 和真实 diff。
- 创建普通全新 Session，复用同一 Sprite，独立 detached worktree 检出 PR head SHA。绝不新建 Sprite，不改原仓库 checkout，不建功能分支。
- 首条消息要求审查 diff 和代码，列出有证据的问题/文件位置/验证建议。只审查不改代码、不提交、不推送、不评论 GitHub、不审批或合并 PR。
- 使用已有 API client 加最小 PR 详情/diff 读取，不抽新模块。PR refs 可 fetch refs/pull/<number>/head 获取同仓库或 fork PR 的 head 对象。
- 同 workspaceId + PR number + head SHA 的 Review Session 可复用，PR 更新后新 SHA 建新 review。只做顺序重复点击，不并发锁。
- 为父级提供准确创建接口及 Session 元数据。总览上的 PR「Review」按钮由父级接入，worker 不需要复制尚未完成的总览代码。

### Session 状态

- 用户可见四个标签：讨论中、待确认、执行中、已完成。它们是业务状态，不把 busy/idle 直接当完成。
- 讨论/手动/Review Session 默认讨论中，发布的执行 Session 默认执行中。
- 在现有 Session 头部用简单控件手动设置状态。至少支持标为待确认和已完成，可继续切换。不做状态机框架或自动模型判定。
- 状态随现有注册表记录保存。已有记录没有状态时按来源显示默认，不批量迁移数据库。
- 左侧 Session 行展示状态；旧 busy/idle 小点可保留作为运行状态。

### 执行结果回流

- 在执行 Session 里提供小表单，用户明确填写“结果摘要”“测试记录”“PR 编号（可选）”，提交后回流到来源 Issue 的总览卡片。
- 测试记录必须标记为人工填写的文本，不自动变成通过标签，不虚构测试执行。无记录就显示未记录。待审批来自现有审批状态或 Session 的待确认状态，不新增审批系统。
- PR 编号如填写，服务端读取并确认该空间仓库的真实 PR，保存 number/title/url/state/head SHA 等可用事实。不允许任意外部链接冒充 PR。
- 不自动把结果注入其他 Session 对话，不推送 GitHub issue 评论，不自动标完成。人可另点“已完成”。
- 同 Issue 可有多条执行结果。利用现有 issueLoop.issue/sourceBotId 关联，从同空间 Session 注册表聚合即可，不新增数据库表或事件系统。
- 提供供总览使用的结果数据（现有 Session list 可包含元数据，不强制加新 overview API）。父级接回主 worker 的总览。

## 文件边界

只改本工作树内现有：`src/routes/workspaces.mjs`、`src/github.mjs`、`src/bots.mjs`、`web/src/App.tsx`、`web/src/components/BotList.tsx`、`web/src/components/EnvironmentPane.tsx`、`web/src/shell/SessionHeader.tsx`、`web/src/types.ts`、`web/src/lib/workspaces.ts`、`test/issue-loop.test.mjs`、`web/test/issue-loop.test.tsx`。可新增一个最小测试文件，如确有需要。不新增产品模块或依赖。

优先扩展现有记录的少量 metadata。Review metadata 不伪装成 issueLoop，不让 review 出现发布 issue task 按钮。复用既有 Preamble removal + SPIKE_RULES + Approval。

## 安全与职责

先读 AGENTS.md 和源码。worker 仅离线开发：不访问 GitHub 或 Sprite，不读 .env，不启动 server/浏览器，不占 8090/5183，不删除 data/目录/Sprite，不触碰别人的工作树。不启动子代理。

远端验收只由父级在 `hifizz/tars-sandbox-playground` 的现有空间和 Sprite 中执行。没有 issue/PR 的真实字段就写未取得，不注入假成功。不存在的文档要说明。

## 验证与交付

最少行为测试：PR head pinned + 同 Sprite + fresh review；手动状态更新；执行结果与真实 PR 关联并只属于同空间 issue。前端控件正常路径即可。不扩异常矩阵。跑全量后端、前端、typecheck、build。

并行任务完成时报告：改动文件、每个 endpoint 和 body/return、metadata shape、父级需接入总览的两小处（PR Review 按钮、Issue results）、测试结果及未验证项。不要自行合并或提交。

这是 Fast Demo，只做以上动作。不要做后台同步、通知、自动 Review、自动完成判定、模型路由、权限系统、重试补偿、通用状态机或架构整理。
