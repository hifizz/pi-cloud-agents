要回答的问题：在已有空间（一个 GitHub 项目、一个沙箱）中，issue 能否自动开启钉住基线 commit、含代码且无新功能分支的讨论 Session，再由人发布任务，开启从该 commit 建立独立分支和目录、且不自动继承讨论调研和决策的执行 Session？
时间盒：一个工作日。时间到或指定路径走通即停止。
本分支不合并。

交付授权更新：用户在两个 Demo 验收通过后明确要求「Commit and push」，因此允许提交并推送 `spike/issue-loop`。先前“不提交、不推送”是当时的实验约束；不开 PR、不合并的约束仍有效。

## 当前结论：Demo 正常路径 PASS，停止开发

2026-10-30T16:08:58Z 已完成真实 GitHub + Sprite + EGO 路径。开始 14:44:14Z，未到 22:44:14Z 截止时间即走通，因此停止，不生产化、不提交、不推送、不开 PR、不合并。

以下 research、前置阻塞和 worker 未验证项保留为过程记录；实际最终结果以本段及文末现场验收为准。

## 实施前置检查：阻塞（历史，已解除）

- 开始时间：2026-10-30T14:44:14Z。按一个工作日 8 小时计，截止时间为 2026-10-30T22:44:14Z；交接不重置。
- 用户已授权由编排者带领 worker 实现，并要求 Fast Demo：只做正常路径，不加异常兜底、重试、补偿、防错框架或新抽象。现有安全限制保留。
- 本地默认及应用配置指向的控制库均不存在，没有可选的已有工作区。
- 通过 Fly SSH 使用 SQLite readOnly 连接查询线上 `/data/control.sqlite`，绑定 `hifizz/tars-sandbox-playground` 的空间为 0。线上仅有 2 个 ready 空间，项目为 `hifizz/thread-chatbot`。没有修改这些空间或触碰它们的 Sprite。
- 首次只读查询因 SSH 命令引号转义失败，随后改用 SQL 参数查询成功。没有写数据库。
- 因任务明确要求没有合适已有空间就停止，尚未启动实现 worker、server 或浏览器验收，也没有创建 Sprite。
- 断点在步骤 1 的环境前置条件，不是 Session 模型不允许，不是代码失败，也没有绕过约束。需要用户提供已有测试空间的位置，或明确调整前置条件。

## 当前状态

本轮只做代码 research 和需求设计，未实现 issue loop，未访问 GitHub 或 Sprite，未启动服务或做浏览器验收。不提交、不推送、不开 PR，不整理为可合并实现。

- 已建立 `spike/issue-loop`，功能代码未改。
- 已读用户指定的七个文件，并追踪环境、runner、fork、列表归属和通用提示词。
- 定向验证：`TARSBOT_NO_DOTENV=1 node --test test/workspace-env.test.mjs test/fork.test.mjs test/harness.test.mjs`，14 项通过。它们验证已有行为，不代表实验路径通过。
- 尚未确认哪个已有空间绑定测试仓库。实施时先确认 ready 空间、现有 binding 和仓库目录。没有合适空间就记录前置条件阻塞，不创建第二个沙箱。
- 本轮无假数据。没有读取 `.env`、删除 `data/` 或删除 Sprite。已有未跟踪文件不属于本次修改。

## Research 结论

1. `src/bots.mjs` 的 `createBot()` 已能创建全新 conversation，并指定 `agent.cwd`。沿用历史注册表，不引入新的 Bot 概念。
2. `src/control/db.mjs` 的 `conversation_links` 只对 conversation id 唯一，允许多条 conversation 关联同一空间。
3. `src/workspace-env.mjs` 优先用 conversation 的 cwd；`src/ext/exec.mjs` 也优先用 `agent.cwd`。文件工具和 bash 已具备同一沙箱、不同目录的能力，不需要重写 provider 或 runner。
4. `src/workspaces.mjs` 的 create 流程会创建环境、功能分支、主 Session。不能拿它来创建本次两条 Session，否则会继续绑定旧形态。
5. `src/routes/fork.mjs` 明确禁止同空间第二个可写 fork；`forkBot()` 又会复制历史。发布任务不能使用 fork。限制来自应用入口，不是 conversation 存储结构不允许。
6. `web/src/lib/workspaces.ts` 只通过空间主 botId 或 fork 祖先找归属。新建的独立 Session 即使已有 workspaceId，也不会自动显示。实验要让列表识别直接归属，不能伪装成 fork。
7. `web/src/shell/SessionHeader.tsx` 当前显示空间的功能分支。实验 Session 要显示自己的 detached commit 或执行分支，不能让旧空间分支冒充当前代码状态。
8. `src/ext/preamble.mjs` 默认教 Agent cd、clone、pull、建分支、提交和开 PR。实验 Session 不能直接套用这段流程。用现有的单 conversation 扩展选择去掉这段 preamble，给两条 Session 配实际目录、Git 状态和必要安全规则；保留现有审批机制。不增加 mode、story 或模型路由。
9. `src/github.mjs` 已能列分支、读 SHA、按 head 找 PR，但没有现成的 issue 和评论读取组合。一次触发里直接做所需的 GitHub 读取即可，不抽搜索模块或通用 issue 服务。
10. routine 只解析已有 `botConversationId` 并 submit prompt；目标不存在即报错。以上是源码结论，没有做“让 routine 创建 Session”的运行实验，不修改 routine 语义。
11. `docs/CLOUD-PLAN.md` 包含旧的全局共享 Sprite 及历史数据处置决策，与当前每空间绑定 Sprite、禁止删除 data 的约定不同。摘录必须注明来源，不能把历史条款作为本次操作授权。

## 拟走的最小路径

### 一次 issue 输入

在现有已鉴权的工作区路由文件内写实验动作，手动调用一次，输入已有 workspaceId 和测试仓库的 issue 编号。动作只接受 `hifizz/tars-sandbox-playground`。请求进入现有 server 进程，不另开一个写同一数据库的进程。不调用创建、重建或释放空间流程。

优先读取真实 issue、正文、评论、仓库默认分支、真实分支及可取得的相关 PR。若真实 issue 读取受阻，可以在这次实际调用的函数内放固定 issue 载荷，明确记录函数、字段与原因；默认分支、commit、Git 检出及 Session 创建不能伪造。缺失资料写“未取得”，不能写成“没有”。

基线选择建议采用确定性规则：正文中出现完整分支名且 GitHub 确认存在时使用它；多个命中取正文最先出现的一条，同位置优先较长完整名称。无命中回到仓库默认分支，不猜 main/master。消息注明选择原因、实际分支及完整 SHA。这个多命中规则是设计建议，尚未实测。

读分支时记下 SHA，后续 fetch、检出和发布都使用这个 SHA。基线随后前进，不刷新该讨论的 SHA。SHA 无法取到就停，不偷偷切换到新 tip。

### 讨论 Session

沿用该空间的现有 binding，在仓库外的同级目录创建 detached worktree，例如 `/home/sprite/issue-loop/<workspaceId>/discussion-<id>`。使用 `git worktree add --detach <discussionDir> <sha>`，不切换或重置原仓库目录，不创建讨论功能分支。

用 `createBot()` 新建普通 conversation，设置真实 cwd，再关联原空间，最后 submit 首条消息。UI 中一律称 Session。讨论和执行的区别只是这次启动的来源和 Git 状态，不增加产品中的新实体或切换模式。

首条消息包括：

- issue 标题、正文、评论及来源链接。
- 实际基线分支、SHA、选择原因。
- 可取得的相关 PR。范围限 issue 明确引用的 PR、可读取的关联事件、所选分支的 PR，不建设搜索产品，也不声称完整。
- 同空间其他 Session 的名称及可取得的忙碌、排队状态，不复制其他 Session 的聊天。现状没有业务上的完成状态，不能把 idle 解释成已结束。
- `docs/CLOUD-PLAN.md`、`AGENTS.md` 的短摘录和文件来源。先查目标快照；目标仓库缺少文件时明确说明。若引用本应用本地文件，明确标为宿主项目约束，不能伪称目标仓库内容。
- 每个缺失或截断部分的说明，然后要求 Agent 先分析问题、相关代码和待确认事项，不开始实现。

人随后使用现有聊天继续讨论。调研与决策留在此 conversation，不自动写成共享交接文件。讨论有 bash 能力，不伪称为系统强制只读。

### 人发布 task

人在讨论中点击“发布任务”，在空白输入区写任务，再点击确认。发布文本不自动预填讨论摘要。普通聊天中说“可以做了”不自动触发，新 Session 只由这个明确动作创建。

在同一 Sprite 创建另一个 worktree，例如 `/home/sprite/issue-loop/<workspaceId>/execution-<id>`，执行 `git worktree add -b tarsbot/issue-<number>-<id> <executionDir> <pinnedSha>`。来源是讨论最初记录的 SHA，不是当前默认分支、讨论当前 HEAD、讨论工作区改动或复制出的文件。

创建另一条全新 conversation，关联同一空间，cwd 指向 executionDir。它的第一条用户消息逐字使用人确认的 task，不加 issue 原文、讨论历史、摘要、调研、决策或自动交接。系统仅提供实际环境信息和安全规则。来源 Session id 只供 UI 回链，不拼进任务消息。

创建完成后左边出现新 Session 并打开它。聊天上方显示灰色小字“来自讨论：<名称>”，点击返回原讨论。两条 Session 都继续使用现有消息列表和输入框。

## 最小改动边界

遵循最小改动原则：只在现有路由、注册表和 UI 文件内接线，不抽新模块、新通用接口或数据库表。少量实验元数据随现有记录保存：空间归属、钉住的分支和 SHA、目录、执行分支、来源讨论 id。它们是实际运行事实，不是假数据。直接复用 conversation 的 cwd 和空间 binding。

不调整整个空间模型。旧空间仍保留旧 branch/cwd 字段，实验 Session 不拿它们作为自己的 Git 状态。现有空间级 PR、checkpoint、rebuild 按钮不适用于这些 worktree，实验视图应隐藏或禁用，不能误操作旧主目录。本次不验证提交、push 或 PR。

不做生产级错误恢复、事务补偿、重启恢复、去重同步或并发写锁。出错就记录已经发生的实际副作用并停止，不自动删除目录、分支或 Sprite。保留现有鉴权、审批和存储单写进程约束。

## 拟验证的证据和停止点

先验证最硬的三件事，再补齐交互：两个 conversation 使用同一个 binding；讨论 worktree 真正 detached 且固定 SHA；执行 worktree 从同一 SHA 创建且 conversation 没有继承历史。

实施后的验收包括：

- 两条 Session 的空间、runtimeId 一致，provider 创建调用为零。
- 讨论中 Agent 实际运行 `pwd`、`git status --short --branch`、`git branch --show-current`、`git rev-parse HEAD`，目录正确、HEAD detached、当前分支名为空、SHA 一致；对比 refs 确认未新建讨论功能分支。
- 执行刚创建时 HEAD 等于 pinned SHA，分支名及目录不同于讨论。
- 讨论后续新增消息或本地调研文件不会作为执行的历史或工作树内容自动复制。
- 直接检查新 conversation 的首条用户消息等于发布文本，并确认没有讨论历史，而不只看屏幕上最新一条消息。
- 跑自动化测试后使用 EGO：打开讨论、继续聊天、发布、看到新 Session、点击灰色回链返回讨论。截图保存到 `docs/acceptance/issue-loop/`，不含密钥。

完整路径通过即停止，剩余时间不用于整理。一个工作日到期也停止，记录最后成功步骤和阻塞原因。

## 绕过的约束

当前：无实际绕过，仅设计。

拟在实验入口绕过现有“同空间只允许一个可写 Session”的产品限制。独立 worktree 避免默认工作目录相互覆盖，但共享同一 Sprite、Git 对象库、凭据和文件系统，绝不是安全隔离或生产级写锁。验收先串行跑，不声称已证明并发安全。存储的单写进程限制不绕过。

登录默认不绕过；若只能用现有 loopback 开发开关，记录未验证真实登录。持久化只沿用现有能力，不保证 Session 元数据、worktree、链接与首条消息跨崩溃原子完成。真实 issue 若改用函数内载荷，单独标记，不以固定载荷证明 GitHub 读取成功。

## 不采用的路径和已知死路

- 现有 fork：会带入历史，且路由拒绝可写 fork，与目标相反。
- 现有 workspace.create：会进入新环境和空间级功能分支的流程。
- 改用 readOnly fork 作为讨论：现有只读工具列表没有 bash，无法验证 Agent 在目标目录执行。
- 扩展 routine：现有语义只给已有 Session 塞提示词，不是 issue loop。
- 仅在提示词要求先 cd：无法替代真实 cwd 配置，也违反本次起始上下文要求。

这些是源码确认的不适配，不是已运行失败的实验记录。

## 最终验收记录（2026-10-30，正常路径 PASS）

| 项目 | 现场事实 |
|---|---|
| 做成哪几步 | 原需求 1–6 正常路径均走通；GitHub 显式触发一次、讨论、续聊、发布、执行、回链均有证据 |
| 前置条件如何解除 | 用户授权操作页面后，通过现有 UI 建立唯一测试空间。此后讨论与执行没有新建 Sprite |
| 空间与沙箱 | `ws_e168e5f97244a35b`，`pca-eae56f671c`，binding v1 |
| 实际基线分支和 commit | issue #12 正文命中 `main`；`3157db095cb9344e5b9cf0669657bf613d036b46` |
| 讨论 Session | `14a4c184`，conversation 79，`issue-12-discuss` |
| 讨论目录 | `/home/sprite/issue-loop/ws_e168e5f97244a35b/discussion-e77cc0f6` |
| 讨论 Git 状态 | `## HEAD (no branch)`；branch --show-current 为空；refs 对比无新增讨论分支；Agent 实际执行 Git 检查 |
| 执行 Session | `b3b1d0d1`，conversation 130，`issue-12-exec` |
| 执行分支和目录 | `tarsbot/issue-12-14a4c184`；`/home/sprite/issue-loop/ws_e168e5f97244a35b/execution-291b5107` |
| 执行起点 | HEAD 与讨论 pinned SHA 相同；Agent 创建未跟踪 `DEMO-EXECUTION.txt`，内容 `issue-loop execution demo`，未提交 |
| 灰色回链 | 真实点击返回讨论；computed color `rgb(86, 86, 86)` |
| 第一条消息 | 直接读真实 conversation entries：仅 1 条用户消息，与发布原文逐字一致；执行记录中无讨论专用标记 `DISCUSSION_ONLY_7e91` |
| GitHub 材料 | 真实创建并读取测试 issue #12 和一条评论；正文、标题、评论都进入讨论。PR 只取指向基线的 open PR，未做关联搜索 |
| 文档 | 目标快照缺少 AGENTS.md 与 CLOUD-PLAN.md。消息使用明确标注来源的宿主 AGENTS 安全摘录及 CLOUD-PLAN 单写进程摘录 |
| 假数据 | 正常路径没有假 issue、评论、commit、Session 或沙箱；离线测试有测试替身，明确与现场分开 |
| 登录 | 真实本地邮箱密码登录；未启用 auth disabled。密码不写入本文或验收截图 |
| 写锁/持久化/错误 | 绕过同空间单可写 Session 应用限制；无并发写锁与事务补偿；未验崩溃恢复，不声称生产就绪 |
| EGO | PASS；截图和 JSON 证据在 `docs/acceptance/issue-loop/` |


## 实施进度（编排者授权离线开发后，worker 记录）

时间盒：开始 2026-10-30T14:44:14Z，截止 2026-10-30T22:44:14Z，交接不重置。最后一次离线运行约 2026-10-30T15:40Z。

### 已实现（代码与离线测试，未做真实现场验证）

- 路由（均在现有 `src/routes/workspaces.mjs`，走现有鉴权守卫，同一 server 进程）：
  - `POST /api/workspaces/:id/issue-loop/discuss`，体 `{"issue": <正整数>}`：读取真实 issue 与评论，选基线，固定 SHA，在同一 Sprite 建 detached worktree，新建普通会话并提交起始消息。
  - `POST /api/workspaces/:id/issue-loop/publish`，体 `{"botId": "<讨论会话 id>", "task": "<任务原文>"}`：从讨论记录的 pinned SHA 建执行 worktree 与分支，新建会话，第一条用户消息为任务原文。
- 基线：正文中按出现顺序取第一条真实存在的分支名（同位置取较长名）；否则读取仓库真实默认分支（`getRepo`，读不到即报错，不回退到工作区分支，不猜 main/master）。SHA 由分支读取取得，之后讨论与发布都只用该 SHA。
- 评论：读取失败即报错；超过 100 条即 409 显式报错，不静默截断。
- 相关 PR：仅为“所选基线分支的 open PR”（`listPullsByBase`），不是按 issue 引用搜索；读取失败写“未取得”，无结果写“所选基线没有 open PR，不代表 issue 没有关联 PR”。
- 安全规则：移除通用 preamble 后，讨论与执行会话的 instructions 与起始消息都重述：禁止输出凭据、禁止凭据相关命令、禁止 force/删除/合并/改设置、本 spike 不 push 不开 PR。Approval 扩展保留（runtime 未改）。
- 宿主项目摘录：从本应用 `AGENTS.md` 的「安全红线」节取不超过 1500 字符，明确标注为宿主项目背景，不是目标仓库内容；目标仓库中的文档不读取。
- 会话移除 preamble 的写法：`extensions: { remove: [Preamble] }`（对象，不是字符串；字符串会被 harness 拒绝，已有真实 harness 回归测试）。
- 同空间另一会话的 busy/queued 来自 conv.viewState；读不到写“未取得”，不写 idle。
- 数据：Bot 记录新增可选 `workspaceId` 与 `issueLoop`（issue、baseBranch、pinnedSha、dir、branch、sourceBotId），用于前端直接归属与灰色回链。
- 前端：左侧列表通过 `bot.workspaceId` 直接归属（不伪装为 fork）；会话头显示自己的 detached SHA 或执行分支；执行会话显示灰色“来自讨论：<名称>”，点击返回讨论；讨论会话出现“发布任务”空表单（不预填）；工作区级 PR/检查点/重建在 issue-loop 会话中隐藏。

### 离线自动化结果（同一版本代码，worker 本地运行）

| 命令 | 结果 |
|---|---|
| `TARSBOT_NO_DOTENV=1 npm test` | 通过：347 项，346 通过，1 跳过（既有 skip），0 失败，退出码 0 |
| `TARSBOT_NO_DOTENV=1 node --test test/issue-loop.test.mjs` | 通过：10/10 |
| `cd web && npx vitest run` | 通过：10 文件，136 项 |
| `cd web && npm run typecheck` | 通过 |
| `cd web && npm run build` | 通过 |
| `git diff --check` | 通过 |

离线测试使用：内存控制库、真实 HTTP server（createApi）、真实 GitHub client 接假 fetch、记录型 runtimeBash、真实 harness（MemoryStorage + faux 模型）。没有真实 Sprite、真实 GitHub、真实模型调用，没有启动 server，没有占用 8090/5183。

### 未验证（留给编排者现场验收）

- 真实 EGO 操作：登录、讨论、继续聊天、发布、回链点击、截图：未做，PASS/FAIL 均未填写。
- 真实 GitHub 读取（issue #12 与其评论、分支 SHA）：离线测试仅用假 fetch 验证请求形状与解析，未对真实仓库执行。
- 真实 Sprite 上的 `git worktree` 执行与目录创建、`pwd` / `git status` / `git rev-parse HEAD` 的现场结果：未执行。
- 执行会话首条消息在真实 harness 落库后的内容：离线测试在真实 harness 下验证（唯一用户消息等于任务原文），现场未验证。
- 同 Sprite 两个 worktree 并发、写锁、错误恢复、持久化：未验证，本 spike 明确不做。

### 绕过与限制（如实记录）

- 绕过同空间“只允许一个可写会话”的应用限制：实验入口允许同空间第二个会话；独立 worktree 不等于安全隔离，串行验收。
- 没有写锁、没有事务补偿：失败时只记录已发生的副作用（worktree 可能已存在），不自动删除目录、分支、Sprite 或 data。
- 讨论会话不是只读：保留 bash，不宣称系统强制只读。
- 没有 mode / story / 模型路由 / 调研筛选器 / webhook / 轮询。

### 本轮未做（明确）

- 未提交、未推送、未建 PR、未合并、未删除 data 或 Sprite、未启动 server、未做浏览器验收。
- 未扩展测试范围；本轮只修正了上面三处要求差距并更新已有断言。
