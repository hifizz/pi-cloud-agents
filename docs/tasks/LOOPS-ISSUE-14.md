> 本 issue 只做调研和设计记录，不包含代码。实现等审阅后再单独派发。
> 分支说明：调研要求写的是 `spike/issue-loops`，远端实际存在的是 **`spike/issue-loop`**（HEAD `774f73d`），本文以它为基础。

## 1. 调研来源

- Karri Saarinen 的帖子：[x.com/karrisaarinen/status/2116183173608661426](https://x.com/karrisaarinen/status/2116183173608661426)（2026-10-30）
  > "You can do this in @linear today in few seconds. Head to Loops, set up the automation for your team/whole workspace, add MCP tools like Datadog, internal admin, and it let run."
  - 帖子附了一张截图，内容无法读取，**未取得**。
  - 他在回复里说："at this point it still requires review/merge from a human"（[链接](https://x.com/karrisaarinen/status/2116205405168910594)），也就是说代码合并仍然要人来做。
- 被引用的帖子：Cory House [x.com/housecor/status/2115778301939892667](https://x.com/housecor/status/2115778301939892667)
  > A software factory is basically 2 things: 1. A high-level skill that calls other skills (implement-ticket / fix-bug). 2. It runs automatically when it sees new tickets or errors in a log (instead of being run manually by a human's prompt).
- 回复里值得注意的观点：
  - "the hard part … was deciding which loops get to close without me looking"（[@anirudh_twt](https://x.com/anirudh_twt/status/2116191243327914422)），说的是自动闭环的权限边界。
  - "a loop that can pull live Datadog context … is a different animal from one that only shuffles tickets"（[@BlackironX_007](https://x.com/BlackironX_007/status/2116200970250268904)），说的是 MCP 外部上下文的价值。
- Linear 官方资料：
  - [Docs: Loops](https://linear.app/docs/loops)，这是行为细节的主要来源。
  - [Changelog](https://linear.app/changelog)，涉及 4 个版本：
    - 07-20 Introducing Loops
    - 09-14 Loops for product management
    - 09-24 Team loops triggers
    - 10-22 Slack/GitHub triggers、模板、推理等级
  - 另有 09-03 和 10-08 的小改进：按小时调度、按 loop 设消费上限。

## 2. Linear Loops 是什么（只写资料中的事实）

**定义**：Loops 是"团队级的周期性 agent 工作流"。用户用自然语言描述要做的事，再选择按**定时**还是按**事件**触发。每次运行由 Linear Agent 结合工作区上下文和已连接的工具，决定下一步该做什么。

### 归属与可见性
- loop 可以建在团队下，也可以建在工作区级。
- 有权限的人都能查看它的指令、配置和每一次运行。
- 数量上限：每个团队 100 个，工作区级 500 个，每人最多 100 个未发布草稿。
- 名称最长 64 字，描述最长 255 字，条件最多 8 个。

### 触发器（Trigger）
1. **Schedule**：每小时（或自定义小时间隔）、每天、每周（可选多天）、每月、每年。可以选时区和首次运行时间，首次运行不能早于当前时间。
2. **Issue**：状态、优先级、负责人、cycle、project、label 发生变化；进入 Triage（需要团队开启 triage）。
3. **Project / Initiative**：状态、负责人、目标日期、里程碑、成员、label 变化，以及新的 update 和评论。
4. **Cycle**：创建、开始、完成。
5. **Team**：团队创建、成员加入或离开、issue 被分配给团队。
6. **Release**：文档提到支持，具体事件**未取得**。
7. **Pull request**（GitHub）：
   - 支持的事件：创建、ready for review、状态变化（含 Merged）、reviewer 增删、label 增删、push、checks 通过或失败、review 提交、新评论、评论 resolved。
   - 必须选仓库，可以加过滤条件。
   - "Merged" 是状态转换，已经合并的 PR 后续再更新不会重复触发。
8. **Slack**：选定公开频道里有新的顶层消息时触发。不支持私有频道、DM、线程回复、编辑过的消息、访客消息。
9. **Webhook**：每个 loop 有自己的 URL 和 secret。
   - 请求头：`Authorization: Bearer <secret>`，或者使用 Standard Webhooks 签名。
   - 用 `Webhook-Id` 去重，重试时沿用同一个 ID。
   - 收到后返回 `202 Accepted`，只表示已接收，不表示已完成。
   - 请求 body 会自动作为运行的上下文。

### 条件语义
- 带条件的 loop 在对象**开始匹配**条件的那一刻运行一次；只要条件持续匹配，后续更新不会再触发。
- 事件型触发则是每次事件发生、且过滤条件匹配时都运行。

### 创建方式
- 先在 Agent 对话里把事情做成，再说"把它变成 loop"。
- 用一句 prompt 生成草稿，系统会给出指令和建议的触发器。
- 从模板开始（内置模板或工作区模板），回答几个设置问题。
- 从零开始：依次设置 Trigger、Instructions、Connectors、Capabilities & access，然后 Create。

### Capabilities & access（权限）
- **Team access**：可读写哪些团队。工作区级或公开团队的 loop 默认能访问全部公开团队。
- **Reasoning level**：Auto / Low / Medium / High。
- **Web access**：开关。
- **Access code**：Disabled / Read / Read & write。Read & write 表示可以发起 coding session。
- **Externally synced issues and comments**：开关，控制能否写入与外部同步的 issue 或评论。
- **External sources**：默认只处理在 Linear 内创建的 issue。来自 Slack、邮件等外部来源的 issue 要单独开启。
- **Allow changes outside of triggering entity**：关闭时只能修改触发它的那个对象。
- **MCP connectors**：
  - 管理员维护允许使用的 connector 白名单。
  - 每个 loop 可以选择开放哪些 tool。
  - 每个 tool 可以设 "Always approved"，也可以"自动批准全部"；其余调用需要人工审批。
- **Who can edit**：所有成员 / 管理员或团队 owner / 仅 loop owner。

### 运行（Run）
- 每次运行就是一次 Linear Agent 对话。
- 有 **Run history** 可以审计。运行结束后可以像普通会话一样**继续对话**。
- Slack 里 loop 发出的消息带有指向这次运行的链接，在线程里回复可以继续对话。

### 手动运行
- 支持 Run now 的触发类型：schedule、issue、project、initiative。issue、project、initiative 类型需要先选一个对象。
- cycle 和 PR 触发**不支持** Run now。
- 可以从命令菜单对多个 issue 批量运行。

### 版本、模板与开关
- 每次发布都会保存一个版本，可以回滚。
- 可以"另存为模板"。模板不复制 owner、启用状态、团队访问、外部来源和 connector 授权。Slack、PR、webhook 触发的 loop 不能存为模板。
- loop 可以启用或禁用，删除不可恢复。别人禁用或删除你的 loop 时，你会收到通知。

### 计费与限额
- 消耗 AI credits。
- 可以按工作区、用户或单个 loop 设消费上限，到达上限后暂停。
- 运行失败时会通知 loop owner。

### 产出动作
- 创建或修改 issue。
- 更新 project 和 initiative。
- 编辑文档，并有作者标注，能看出哪些内容是 loop 写的。
- 发 Slack 消息。
- 发用户通知。
- 发起 coding session，由人 review 后合并。

### 未取得或不确定
- 截图内容。
- Release 触发的具体事件。
- 运行状态的完整枚举。
- 失败重试策略。
- 并发和去重的细节（webhook 以外的触发）。
- 计划可用性：changelog 07-20 写的是 Business/Enterprise，现在的文档写"plans including free"，以文档为准，但两者不一致。

## 3. 现状：`spike/issue-loop` 已经有什么

相对 main 新增 3 个提交，约 7.5k 行。已有能力如下：

- **讨论 Session**：`POST /api/workspaces/:id/issue-loop/discuss`
  - 读取真实 issue、评论和相关 PR，选定基线分支并**钉住 SHA**。
  - 在同一个 Sprite 上为讨论建 detached worktree，用 `createBot()` 新建一个 Session，并去掉通用 Git preamble。
- **发布任务**：`POST /api/workspaces/:id/issue-loop/publish`
  - 人显式点击后，从 pinnedSha 建执行分支和 worktree。
  - 执行 Session 的首条消息就是发布原文，不继承讨论内容。
  - UI 上有"来自讨论"的回链。
- **PR Review**：`POST /api/workspaces/:id/review`
  - 钉住 PR head SHA，在 detached worktree 里只做审查。
- **Session 状态**：`POST …/sessions/:botId/status`，四种状态：讨论中、待确认、执行中、已完成。
- **执行结果回流**：`POST …/sessions/:botId/result`
  - 包括摘要、人工填写的测试记录、可选 PR 编号（服务端会核实）。
  - 汇总到 `GET …/overview`。
- **已有的底座**：
  - `src/ext/routines.mjs`：基于 pi-durable 的 durable sleep 做定时 routine，有 exactly-once requestId 和补跑逻辑（漏掉的时间点只补一次）。
  - Approval 扩展（放在扩展链最后）。
  - `src/github.mjs` 薄封装。

### 差距（对照 Linear Loops）
| Linear Loops | spike 现状 | 差距 |
|---|---|---|
| Loop 实体（名称、指令、触发器、权限、版本、启用状态） | 没有。只有一次性的 HTTP 动作；routine 只是"定时往一个已有 bot 塞 prompt" | **需要新增 Loop 定义和存储** |
| 定时触发（小时/天/周/月/年 + 时区） | routine 只支持每天的 `HH:MM` 列表 | 需要扩展调度语义，routine 要能"每次新建运行 Session" |
| 事件触发（issue、PR、label、checks…） | 没有。全靠手动调用 | 需要 GitHub webhook 或轮询，加过滤和"开始匹配"语义 |
| Webhook 触发 + 去重 + 202 | 没有 | 需要新增入口，带 secret 和 Webhook-Id 去重 |
| 每次运行 = 一个可继续的 Agent 会话 | 讨论和 Review Session 已经是这种形态 | ✅ 可以直接复用：一次运行 = 一个 Session |
| Run history / 审计 | 只有 overview 汇总 | 需要 loop 维度的运行列表、状态和触发载荷 |
| Run now（选一个对象） | discuss 和 review 本身就是"对 issue/PR 立即运行" | ✅ 基本具备，需要挂到 loop 上 |
| 权限：只改触发对象、代码读/读写、Web、MCP tool 白名单与自动批准 | 只有全局 Approval、白名单登录 | 需要按 loop 设置能力开关，并映射到扩展和工具集 |
| 人工审批或合并 | 发布任务需要人点击；PR 不会自动合并 | ✅ 理念一致 |
| 推理等级 | 按 bot 选模型和 thinkingLevel | 需要把 Low/Med/High 映射到 thinkingLevel 或模型 |
| 版本与回滚、模板 | 没有 | 放到后续阶段 |
| 消费上限 | 没有 | 放到后续阶段，可以先记录 token |
| Slack 触发和发消息 | 没有 | 不在本阶段范围 |

## 4. 决策记录（2026-10-31 已确认）

| # | 问题 | 结论 |
|---|---|---|
| 1 | GitHub 事件怎么进来 | 主路径是 **Webhook**（HMAC 签名校验）。**轮询**作为补漏和对账。两条路径按 delivery id / event id 统一去重，同一事件只运行一次 |
| 2 | loop 能不能改代码、开 PR | **可以**。允许 `code=readwrite`：建分支、提交、推送、开 PR。**禁止自动合并** |
| 3 | 并发 | loop 和运行的数量不设上限。同时运行数有一个**可配置上限，默认 3**，超出的进入 **FIFO 队列**，UI 能看到 `queued` 状态和排队位置 |
| 4 | 在哪个分支开发 | 从 `spike/issue-loop` 切出新分支 **`feat/loops`**。spike 分支保持不变 |

### 默认方案，可调整
- **推理等级**：
  - `auto` 跟随工作区默认模型和 thinkingLevel。
  - `low` 用默认模型，thinking=low。
  - `medium` 用默认模型，thinking=medium。
  - `high` 用默认模型，thinking=high。
  - 映射表集中放在 `src/config.mjs`，只是一层配置，后续可以改成换模型。
- **工具来源**：
  - 用服务端已配置的 MCP / 工具集合作为白名单。每个 loop 只勾选白名单里的工具，并可单独设自动批准。
  - 不做每个 loop 单独 OAuth 授权。
  - 内置 GitHub 写工具（评论、label、开 PR、开 issue），每个都有独立开关。
- **Slack**：本期不做，列为非目标。
- **归属层级**：只做工作区级（一个 loop 属于一个工作区，也就是一个仓库加一个 Sprite），不做全局或跨工作区 loop。

## 5. 任务书

### 5.1 目标
在 pi-cloud-agents 里实现接近 Linear Loops 的"定时或事件触发的 agent 工作流"。
- 一次运行就是一个可以继续对话的普通 Session。
- 运行可以读代码、改代码、开 PR，但合并必须由人来做。
- 运行过程可审计、能排队、服务重启后不丢、不重复。

### 5.2 范围
- Loop 定义：创建、编辑、启用/禁用、删除、版本。
- 触发方式：手动 Run now、定时、Webhook、GitHub issue/PR 事件（webhook 加轮询）。
- 运行引擎：全局队列（默认并发 3、FIFO）、运行记录、Session 创建、worktree 和分支、能力开关、审批。
- 产出：评论、label、PR、执行结果回流、"建议发布的任务"。
- UI：Loops 列表、编辑器、运行历史、排队状态、Session 上显示"来自 Loop"。

### 5.3 非目标
- 自动合并 PR。
- Slack 触发和发消息。
- 跨工作区或全局 loop。
- 每个 loop 单独 OAuth 授权外部工具。
- 计费系统（只记录 usage，不做扣费）。
- 多 Sprite 隔离或新建 Sprite（运行仍然复用工作区自己的 Sprite）。
- 改 `~/.pi` 全局配置、发 npm。

### 5.4 分支与约束
- 开发分支是 `feat/loops`，从 `spike/issue-loop` 的最新提交（`774f73d`）切出。按阶段开 PR 合到 `feat/loops`，是否合到 main 另行决定。
- 遵守 `AGENTS.md` 的约定：后端用纯 ESM `.mjs`，不用 TS，依赖精确锁定；前端用 React + TS。扩展顺序里 Approval 必须排在最后。
- 触发器和队列必须在 server 进程内运行，不能另起进程写 `control.sqlite`。
- 秘密只存哈希或环境变量，不写日志，也不写入 Session 内容。

### 5.5 数据模型（`src/control/db.mjs` 迁移）
```
loops(id PK, workspace_id, name ≤64, description ≤255, instructions TEXT,
      trigger JSON, conditions JSON (≤8), capabilities JSON, reasoning TEXT,
      enabled INT, owner TEXT, edit_policy TEXT, version INT, webhook_secret_hash TEXT NULL,
      created_at, updated_at)
loop_versions(loop_id, version, snapshot JSON, published_at, published_by, PK(loop_id,version))
loop_runs(id PK, loop_id, loop_version, workspace_id, trigger_kind, trigger_key, payload JSON,
          entity_ref TEXT NULL, bot_id NULL, branch NULL, pr_number NULL,
          status TEXT  -- queued|starting|running|needs_approval|succeeded|failed|canceled|skipped
          error NULL, enqueued_at, started_at NULL, ended_at NULL, usage JSON NULL,
          UNIQUE(loop_id, trigger_key))
loop_match_state(loop_id, entity_ref, matched INT, updated_at, PK(loop_id,entity_ref))
github_event_cursor(workspace_id PK, last_event_id, polled_at)       -- 轮询游标
github_deliveries(event_key PK, source TEXT webhook|poll, received_at) -- 跨通道去重
settings: loops.maxConcurrentRuns 默认 3（config / 环境变量 TARSBOT_LOOPS_MAX_CONCURRENCY）
```
- `trigger.kind` 可取以下值：
  - `manual`
  - `schedule{freq: hourly|daily|weekly|monthly|yearly, interval, days[], at, tz, startAt}`
  - `webhook`
  - `github_issue{event, filters}`
  - `github_pr{event, filters}`
- `capabilities` 结构：
  ```
  {code: none|read|readwrite, web: bool, scopeToTrigger: bool,
   github: {comment, label, openIssue, openPr}, tools: [{name, autoApprove: bool}]}
  ```
- `trigger_key` 生成规则：
  - schedule：`schedule:<slotTs>`
  - webhook：`webhook:<Webhook-Id>`
  - GitHub：`gh:<规范化事件键>`
  - 手动：`manual:<uuid>`
- **GitHub 规范化事件键**：webhook 和轮询必须能映射到同一个键。例如 `issues.opened:<issueId>`、`pull_request.labeled:<prId>:<labelId>:<updated_at>`、`check_suite.completed:<id>`。delivery id 只用于 webhook 自身的重放去重，跨通道去重以规范化键为准。

### 5.6 API
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/workspaces/:id/loops` | 列表和创建 |
| GET/PATCH/DELETE | `/api/loops/:id` | 详情、修改（会生成新版本）、删除 |
| POST | `/api/loops/:id/enable` `/disable` | 开关 |
| POST | `/api/loops/:id/run` | Run now，body `{entity?: {issue?:n, pr?:n}}`，返回 `{runId, status}`（可能是 queued） |
| GET | `/api/loops/:id/runs` | 运行历史（分页） |
| POST | `/api/loop-runs/:runId/cancel` | 取消排队中或运行中的 run |
| GET | `/api/loops/queue` | 当前运行中和排队中的 run 及其位置 |
| POST | `/api/loops/:id/webhook` | 外部 webhook。`Authorization: Bearer` 或 Standard Webhooks 签名。按 `Webhook-Id` 去重，返回 202 |
| POST | `/api/loops/:id/webhook/rotate` | 轮换 secret，只返回一次明文 |
| POST | `/api/github/webhook` | GitHub webhook，`X-Hub-Signature-256` 校验，按仓库路由到工作区 |
| GET | `/api/loops/:id/versions`，POST `/api/loops/:id/versions/:v/restore` | 版本和回滚 |
| POST | `/api/loops/draft-from-prompt` | 由一句话生成草稿（第三期） |

除了两个 webhook 入口，其余接口都走现有登录鉴权。

### 5.7 分阶段任务拆解

**Phase 1：Loop 本体、队列和运行引擎（手动、定时、Webhook）**
1. `src/control/db.mjs`：完成上面的迁移，加 loops、loop_versions、loop_runs 的 CRUD。
2. 新增 `src/loops/store.mjs`：负责 loop 的 CRUD、版本快照、参数校验（长度、条件数量、trigger 结构）。
3. 新增 `src/loops/queue.mjs`：
   - 全局 FIFO，`maxConcurrentRuns`（默认 3）。
   - enqueue 时用 `UNIQUE(loop_id, trigger_key)` 实现幂等。
   - 有空位时按 `enqueued_at` 顺序启动。
   - run 结束、失败或取消时释放空位。
   - 服务启动时恢复：之前是 `starting`/`running` 的 run，检查它的 Session 是否还在由 pi-durable 继续执行；如果在就继续占用空位，否则标为 failed（`interrupted`）。`queued` 的 run 按原顺序继续排队。
4. 新增 `src/loops/runner.mjs`，负责单个 run 的执行：
   - 组装上下文：issue 触发复用 discuss 的组装逻辑，PR 触发复用 review 的钉住逻辑，webhook 用 payload，schedule 用工作区摘要。这些逻辑要从 `src/routes/workspaces.mjs` 抽成可复用的函数。
   - 按 `code` 准备 worktree：none 不检出代码；read 用 detached worktree；readwrite 新建分支 `loops/<loopSlug>/<runId>`。
   - 调 `createBot()` 新建 Session。Bot 记录加上 `loopRun{loopId, runId, version}`。
   - 按 capabilities 组装 extensions 和 tools，Approval 放在最后。
   - Session 结束后写回 run 状态和 usage，把 Session 状态设为"待确认"。
5. `src/ext/routines.mjs`：增加 schedule 计算（hourly/daily/weekly/monthly/yearly、interval、days、tz、startAt），沿用 durable sleep 和 exactly-once。触发时改成 enqueue 一个 run，不再往已有 bot 提交 prompt。原有的 routine 行为保持不变。
6. 新增 `src/routes/loops.mjs`：实现上面的 API（Phase 1 部分），包括 webhook 入口和 secret 轮换。
7. `src/bots.mjs`：Bot 记录支持 `loopRun` 元数据。
8. 前端：
   - `web/src/types.ts`、`web/src/lib/loops.ts`：类型和 API 客户端。
   - 新增 `web/src/components/LoopsList.tsx`：名称、触发器摘要、启用开关、最近一次运行状态。
   - 新增 `web/src/components/LoopEditor.tsx`：分 Trigger、Instructions、Capabilities & access 三段，底部 Save。
   - 新增 `web/src/components/LoopRuns.tsx`：运行历史和队列视图，显示 queued 的排队位置；运行可以取消；点击打开对应 Session。
   - `web/src/shell/SessionHeader.tsx`：显示灰色小字"来自 Loop：<名称> · 运行 #n"，可以点击跳回 loop。
   - `BotList.tsx`、`App.tsx`：加 Loops 入口和路由。
9. 测试：新增 `test/loops-store.test.mjs`、`test/loops-queue.test.mjs`、`test/loops-schedule.test.mjs`、`test/loops-webhook.test.mjs`、`test/loops-runner.test.mjs`、`web/test/loops.test.tsx`。

**Phase 2：GitHub 事件（webhook + 轮询）、改代码和开 PR**
1. 新增 `src/loops/github-events.mjs`：
   - 负责事件规范化（webhook payload 和 events API 的结果都映射成统一的事件对象和规范化键）。
   - 做过滤匹配（event、label、分支、作者、路径等）。
   - 实现"开始匹配"语义，依赖 `loop_match_state`。
2. `POST /api/github/webhook`：签名校验，记录 delivery，按仓库找到工作区，再匹配 loop 并 enqueue。
3. 轮询：在 server 进程内跑一个 durable 定时任务（默认 5 分钟，可配置）。按 `github_event_cursor` 拉取每个工作区仓库的 issue/PR events 和 timeline，走同一条规范化和 enqueue 路径。轮询也用来对账 webhook 漏掉的事件。
4. `src/github.mjs`：补充 events/timeline 读取，以及评论、label、开 PR、开 issue 这几个写操作，加上 PR 的 checks 和 reviews 读取。
5. 运行内的 GitHub 工具（`src/loops/tools.mjs`）：
   - 每个工具受 `capabilities.github.*` 开关控制。
   - `scopeToTrigger` 打开时，只允许写触发它的 issue 或 PR，开 PR 除外（开 PR 必须关联触发它的 issue）。
   - **不提供 merge 工具**。
6. readwrite 运行的收尾：
   - agent 提交并推送 `loops/...` 分支，用工具开 PR，PR 正文附运行链接。
   - run 记录 `branch` 和 `pr_number`，写入执行结果回流，复用 `/result` 的数据结构。
7. "建议发布的任务"：运行可以产出一份任务草稿，UI 一键调用现有的 `issue-loop/publish`。
8. 前端：编辑器加 GitHub 触发器的 event 选择、仓库（固定为工作区的仓库）和过滤器；运行历史显示 PR 链接。
9. 测试：新增 `test/loops-github-events.test.mjs`、`test/loops-dedup.test.mjs`、`test/loops-pr.test.mjs`，并补充 web 测试。

**Phase 3：工具权限、推理等级、版本、模板、草稿、花费**
1. 工具白名单和每个工具的自动批准，接入现有 Approval，需要审批时 run 状态为 `needs_approval`。
2. reasoning 映射（见默认方案），放在 `src/config.mjs`。
3. 版本列表和回滚 UI。
4. 内置模板：issue 根因分析、PR 加 label 后出 QA 清单、每周总结、CI 失败分析。另存为模板时不复制 owner、启用状态和 secret。
5. `draft-from-prompt`：用一句话生成指令和建议的触发器。
6. 每个 loop 的 usage 统计，可选每日运行次数上限或花费上限，达到后自动禁用并通知。
7. 测试：`test/loops-approval.test.mjs`、`test/loops-versions.test.mjs`、`test/loops-templates.test.mjs`。

## 6. 验收条件

### 通用（每个阶段都要满足）
- [ ] `TARSBOT_NO_DOTENV=1 npm test` 全部通过；`cd web && npm test && npm run typecheck && npm run build` 全部通过。
- [ ] 离线测试使用临时存储、内存控制库和 fauxProvider，不连接真实模型或 Sprite。
- [ ] 现场验收在 `hifizz/tars-sandbox-playground` 的已有空间里用真实 Sprite 和 EGO 完成，截图放在 `docs/acceptance/loops/phase-N/`，截图里不能有密钥。
- [ ] 不新建 Sprite；现有的 discuss、publish、review、routine 测试保持通过。

### Phase 1
**Loop 定义**
- [ ] 能创建、编辑、启用/禁用、删除 loop，服务重启后数据还在。
- [ ] 名称超过 64 字、描述超过 255 字、条件超过 8 个时返回 400。
- [ ] 每次 PATCH 都会让 version+1，并在 `loop_versions` 生成一份快照。
- [ ] 已禁用的 loop 不会被任何触发器 enqueue。Run now 返回 409。

**队列（上限 3）**
- [ ] 连续触发 5 个 run 时，正好 3 个是 running，2 个是 queued；`GET /api/loops/queue` 显示的排队位置是 1、2。
- [ ] 任意一个 running 结束后，排队位置 1 的 run 在 1 秒内（测试里用假时钟）变成 running，顺序严格 FIFO。
- [ ] 把 `maxConcurrentRuns` 设成 1 或 5 后，行为符合新的上限。
- [ ] 取消一个 queued run 后，它不会启动，后面 run 的排队位置前移；取消 running run 后会中止它的 Session 并释放空位。
- [ ] UI 上 queued 的 run 显示"排队中 #n"，running 显示"运行中"。
- [ ] 失败的 run（比如 worktree 创建失败）会释放空位，状态为 failed，error 不为空，不会卡住队列。

**重启安全**
- [ ] 有 3 个 running 和 2 个 queued 时重启 server：queued 按原顺序保留；running 的 Session 如果还在由 pi-durable 执行就继续占用空位，否则标为 failed(interrupted)。不会出现超过 3 个并发运行，也不会重复启动同一个 run。
- [ ] 定时 loop 在停机期间错过了多个时间点，重启后只补跑一次，下一个时间点按原来的时间网格计算。
- [ ] 重复的 `trigger_key` 不会产生第二个 run（数据库唯一约束，有测试覆盖）。

**定时**
- [ ] hourly(interval=2)、daily、weekly(多天)、monthly、yearly 在指定时区计算出的下一次时间正确，包括 DST 边界（测试固定 `America/New_York` 和 `Asia/Singapore`）。
- [ ] `startAt` 早于当前时间时返回 400。

**Webhook**
- [ ] secret 错误或缺失时返回 401，不创建 run。
- [ ] 正确请求返回 202，响应体里有 runId。
- [ ] 用相同的 `Webhook-Id` 重发，仍然返回 202，但不会产生第二个 run（返回原 runId）。
- [ ] Standard Webhooks 签名校验能通过；时间戳超过 5 分钟时拒绝。
- [ ] 轮换 secret 后，旧 secret 立即失效。
- [ ] payload 作为不可信上下文出现在首条消息里（放在明确标注的围栏内）。

**运行**
- [ ] 每个 run 都会新建一个 Session，与工作区的 runtimeId 相同，Bot 记录有 `loopRun`。
- [ ] `code=none` 时 cwd 下没有检出代码；`code=read` 时 HEAD 是 detached，等于钉住的 SHA；`code=readwrite` 时位于新分支 `loops/<slug>/<runId>`，起点等于钉住的 SHA。
- [ ] Session 结束后能从运行历史打开，并继续对话。
- [ ] 前端测试：列表、编辑器保存、Run now、排队显示、"来自 Loop"回链能点击跳转。

### Phase 2
**webhook + 轮询去重**
- [ ] 同一个 GitHub 事件先通过 webhook 到达，再被轮询拉到，只产生 1 个 run。顺序反过来也只产生 1 个。
- [ ] 同一个 `X-GitHub-Delivery` 被重放，不会产生新 run。
- [ ] `X-Hub-Signature-256` 校验失败时返回 401。
- [ ] 关掉 webhook（模拟丢失）后，轮询能在一个轮询周期内补上触发，补上的事件记为 `source=poll`。
- [ ] 轮询游标持久化，重启后不会重复处理已处理过的事件，也不会漏掉停机期间的事件（在 API 可回溯的窗口内）。

**事件与条件**
- [ ] issue opened/labeled/closed/assigned/commented 和 PR opened/ready_for_review/labeled/merged/checks_failed/review_submitted 都能触发，并按过滤器匹配。
- [ ] 条件型 loop 只在对象从不匹配变成匹配时运行一次；之后仍然匹配的更新不再触发；变回不匹配后再次匹配会再触发。
- [ ] PR merged 只在状态变成 merged 时触发一次；合并后的后续更新不会触发。

**改代码和开 PR**
- [ ] 在 `code=readwrite` 且 `github.openPr=true` 的条件下，用真实 issue 触发 loop：Sprite 上创建 `loops/...` 分支并推送，在 `hifizz/tars-sandbox-playground` 开出一个 PR；PR 正文含运行链接，`loop_runs.pr_number` 已记录，概览里的执行结果能看到这个 PR。
- [ ] 整个过程中没有调用任何 merge，运行的工具集里不存在 merge 工具（有测试断言）。
- [ ] `github.openPr=false` 时开 PR 被拒绝，run 能正常结束并说明原因。
- [ ] `scopeToTrigger=true` 时评论或打 label 到其他 issue 会被拒绝（有测试）。
- [ ] "建议发布的任务"可以一键发布，生成的执行 Session 首条消息等于确认后的文本，不继承运行的历史。

### Phase 3
- [ ] 没开启自动批准的工具调用会让 run 进入 `needs_approval`，批准前不执行；批准或拒绝后继续。被审批阻塞的 run 仍占用并发空位（UI 显示"待审批"）。
- [ ] reasoning 的 auto/low/medium/high 正确映射到 thinkingLevel（有测试）。
- [ ] 回滚到旧版本后，下一次运行使用旧版本的指令，`loop_runs.loop_version` 记录正确。
- [ ] 从模板创建的 loop 不包含 owner、启用状态和 secret。
- [ ] 达到每日运行次数上限后，新的触发记为 `skipped`（附原因），并通知 owner。

## 7. 风险
- **安全**：所有 run 共享同一个 Sprite、Git 对象库和凭据，worktree 不等于隔离。issue、PR、webhook 内容都是不可信输入，要靠 scopeToTrigger、审批和"不提供 merge 工具"来约束。
- **公网入口**：两个 webhook 入口必须做签名校验、限流和请求体大小限制。
- **并发**：同一个 Sprite 上 3 个运行同时写 Git，需要在测试中验证 `git worktree` 并发是安全的；有问题时，在单个工作区内对 git 写操作加锁。
- **成本**：事件触发可能让运行数量暴涨，靠队列上限、去重和 Phase 3 的运行次数上限来控制。
- **pi-durable API 仍在实验阶段**，重启恢复依赖它的行为，需要针对现场做测试。
