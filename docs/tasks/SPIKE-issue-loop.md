# SPIKE-issue-loop：同空间的 issue 讨论与任务发布

状态：设计已确认，待实施。实验分支：`spike/issue-loop`。记录与证据：根目录 `SPIKE.md`。

## 要回答的问题

在一个已有空间（一个 GitHub 项目、一个沙箱）中，一条 issue 能否自动打开普通讨论 Session：有代码，检出基线当时的 commit，没有新的功能分支；人能否再从讨论发布任务，打开从同一 commit 创建独立分支和目录的执行 Session，且不自动继承讨论调研和决策？

这次是探上限，不是生产实现。一个工作日或完整路径走通，先到者即停止。实施开始时在 `SPIKE.md` 记开始时间和截止时间；worker 与编排者共用这一个时间盒，交接不重置。不提交、不推送、不建 PR、不合并、不整理成可合并形态。

## 先读再改

必须完整阅读：

- `AGENTS.md`
- `SPIKE.md`
- `src/workspaces.mjs`
- `src/bots.mjs`
- `src/github.mjs`
- `src/ext/routines.mjs`
- `web/src/components/BotList.tsx`
- `web/src/lib/workspaces.ts`

随后追踪：`src/routes/workspaces.mjs`、`src/routes/fork.mjs`、`src/workspace-env.mjs`、`src/ext/exec.mjs`、`src/ext/preamble.mjs`、`src/control/db.mjs`、`web/src/App.tsx`、`web/src/shell/SessionHeader.tsx`、`docs/CLOUD-PLAN.md`。Pi Durable API 以已安装的 `.d.ts` 为准。

## 已确认的代码事实

- `createBot()` 能新建 conversation 并指定 `agent.cwd`，不必 fork。
- `conversation_links` 允许多条 conversation 关联同一空间。
- 文件工具与 runner bash 都优先使用 Session 自己的 cwd，仍通过空间 binding 选择同一 Sprite。
- 现有 workspace.create 会创建环境、空间级功能分支和主 Session，不用于这次创建讨论或执行 Session。
- 现有 fork 会继承历史，且应用路由只允许只读 fork。发布 task 不能调用 fork。
- 现有只读 fork 没有 bash，不适合作为本次讨论。
- 前端只通过空间主 botId 或 fork 祖先找归属，独立 Session 需要识别直接 workspaceId。不要伪造 fork 关系。
- 通用 preamble 包含 cd、clone、pull、建分支和开 PR 的流程，不能原样用于本次 Session。
- routine 只向已有 botConversationId 塞提示词。源码已确认，不需要为了此任务修改或运行它。
- 已有定向测试 14 项通过，不代表实验路径通过。命令：`TARSBOT_NO_DOTENV=1 node --test test/workspace-env.test.mjs test/fork.test.mjs test/harness.test.mjs`。

## 路径与行为要求

### 1. 只用一个已有空间、一个已有沙箱

选择已绑定 `hifizz/tars-sandbox-playground` 的 ready 空间，确认现有 binding 与仓库目录。没有合适空间就记录前置条件阻塞，不另建 Sprite。

只做一次显式触发：在现有工作区路由文件内接实验动作，手动调用一次，输入 workspaceId 和 issue 编号。使用现有 server 进程和鉴权。不要另开进程写同一份数据库，不调用空间创建、重建或释放流程。

### 2. 选择基线并钉住 commit

读取测试仓库的真实默认分支与分支列表。正文中出现完整、真实存在的分支名时使用它；否则用仓库默认分支，不猜 main/master。

多个有效分支命中时，取正文中最先出现的一条；同位置优先较长的完整名称。不能用子串把不存在的分支误匹配成已有分支。thread 必须写出实际选择、原因及完整 SHA。

读分支时记录 SHA，后续 fetch、检出、发布只用这个 SHA。分支后续前进不移动这次讨论。SHA 无法取到就停，不能悄悄换到新的 tip。

在同一 Sprite 中、原仓库目录之外建立 detached worktree，例如 `/home/sprite/issue-loop/<workspaceId>/discussion-<id>`：

```bash
git -C <repoDir> worktree add --detach <discussionDir> <pinnedSha>
```

不 checkout 或 reset 原目录，不为讨论创建功能分支。命令参数须安全引用，不能把 issue 文本直接拼入 shell 命令。

### 3. 新建普通讨论 Session

用现有注册表创建全新 conversation，真实 cwd 指向 discussionDir，关联原空间后再提交起始消息。它出现在左边列表，使用现有聊天，用户可见名称一律是 Session。

为此 Session 使用现有扩展选择能力去掉不适用的通用 Git 流程，设置实际目录、detached SHA、讨论任务和必要安全规则。起始上下文不得教 Agent 先 cd、clone、pull 或建分支。保留审批，不引入 mode、story 或模型路由。

起始消息包括：

- issue 标题、正文、评论和来源链接。
- 实际基线分支、SHA、选择原因。
- 能取得的相关 PR。范围限明确引用、可读取的关联事件、所选分支对应 PR，不做独立搜索产品，不宣称完整。
- 同空间其他 Session 名称及可取得的 busy、queued 状态，不复制其聊天。现有系统没有业务完成状态，idle 不等于结束。
- `docs/CLOUD-PLAN.md`、`AGENTS.md` 相关短摘录及来源。
- 各部分缺失或截断说明。取不到不能写成没有。
- 要求 Agent 先分析问题、相关代码和待确认事项，不开始实现。

先查目标 commit 下的文档。目标仓库缺少文档时说明缺失；如引用宿主项目的文档，明确标记来源，不冒充目标仓库内容。`CLOUD-PLAN.md` 有过时的全局共享 Sprite 与数据处置决策，不能当作本次操作授权。

Agent 自动做初步分析，人继续使用当前聊天。调研和决策留在本 conversation，不自动写成跨 Session 的交接文件。讨论保留 bash 能力，不宣称系统强制只读。

### 4. 人明确发布 task

人在讨论中点击“发布任务”，看到空白任务输入区，写下任务并确认。不要自动填入讨论摘要，不把普通聊天里的“可以做了”解释为发布。

在同一 Sprite 创建另一份 worktree，例如 `/home/sprite/issue-loop/<workspaceId>/execution-<id>`：

```bash
git -C <repoDir> worktree add -b tarsbot/issue-<number>-<id> <executionDir> <pinnedSha>
```

来源只能是讨论创建时的 pinnedSha，不是当前基线 tip、讨论当前 HEAD 或讨论目录的文件副本。讨论的未提交文件不复制过去。

新建另一条全新 conversation，关联同一空间，cwd 指向 executionDir。第一条用户消息逐字使用人确认的任务，不附 issue 原文、讨论历史、摘要、调研、决策或自动交接。系统只提供必要的实际环境信息和安全规则，不承载讨论结论。

来源 Session id 只供 UI 回链，不作为历史继承，不拼进任务消息。

### 5. 列表与灰色回链

发布成功后左边出现新 Session，并打开它。执行聊天上方显示灰色小字“来自讨论：<名称>”；点击返回原讨论，原聊天仍在。

两条都使用原有 Session 聊天。显示本 Session 的 detached commit 或执行分支，不能用旧空间的功能分支冒充当前状态。

旧空间级 PR、checkpoint、rebuild 不能处理这些新 worktree，在实验 Session 视图隐藏或禁用这些操作。不扩展这些功能。

## 实现边界

少量实验元数据沿用现有记录保存：workspaceId、基线分支、pinned SHA、目录、执行分支和来源讨论 id。不要抽新模块、新通用接口、数据库表或新的 Bot 概念。允许在现有文件里直接写实验接线，不重做空间系统。

不做：JEV、模型路由、poteto/pstack mode 或 story、调研筛选器、GitHub webhook、轮询产品、第二个沙箱、生产级权限、错误恢复、事务补偿、持久化方案或并发写锁。

固定 issue 载荷只在真实读取受阻且为了继续走通路径时使用，只能放在实际调用的函数内部。`SPIKE.md` 写明函数、字段、原因及哪些结论没有验证。不得伪造 commit、worktree、Session、目录或回链。

独立 worktree 不等于安全隔离。它们共享 Sprite、Git 对象库、文件系统和凭据。这次允许实验入口绕过同空间单可写 Session 的应用限制，串行验收，不能宣称已证明并发安全。数据库单写进程限制不能绕过。

保留现有鉴权和审批。确需现有 loopback 登录开关时，记录真实登录未验证，不削弱非 loopback 启动保护。

失败后记录副作用与断点，不自动删除目录、分支、Sprite 或 data。不得访问或修改其他远端仓库。

## 你只能创建/修改

实现只在下列现有文件内接线，按需使用，不要求全部改动：

- `SPIKE.md`
- `src/routes/workspaces.mjs`
- `src/bots.mjs`
- `src/github.mjs`
- `src/ext/preamble.mjs`
- `web/src/types.ts`
- `web/src/lib/workspaces.ts`
- `web/src/App.tsx`
- `web/src/components/BotList.tsx`
- `web/src/shell/SessionHeader.tsx`
- `web/src/components/WorkspaceStatus.tsx`
- `web/src/components/EnvironmentPane.tsx`

允许增加本实验的最小行为测试：`test/issue-loop.test.mjs`、`web/src/lib/issue-loop.test.ts`。不新增产品模块。若实际现有类型或 UI 入口位置不同，先报告需要调整的文件边界，不能借此扩大重构。

编排者可在 `docs/acceptance/issue-loop/` 保存浏览器截图和验收记录。

## 实施顺序与停止条件

1. 记录时间盒，确认已有空间及 binding。无合适空间就报告阻塞。
2. 先证明同一 binding、不同 cwd、讨论 detached 固定 SHA、新执行 conversation 不继承历史。
3. 接上一次 issue 读取、起始材料、明确发布及回链。
4. 跑自动化验证，再由编排者做真实 EGO 验收。
5. 路径通过即停；时间到也停，写明最后成功步骤、原因和未验证项。不用剩余时间整理代码。

worker 不开 server、不占 8090/5183、不做浏览器验收、不提交。真实 UI 操作由编排者完成。任一关键限制无法绕过时报告，不改成另一条更容易但不符合目标的路径。

## 验收

自动化命令：

```bash
TARSBOT_NO_DOTENV=1 npm test
cd web && npm test && npm run typecheck && npm run build
```

离线测试用临时存储、内存控制库或现有 fauxProvider，不连真实模型或 Sprite。测试替身与真实链路分开记，不用离线通过替代现场证据。

行为与现场证据：

- [ ] 两条 Session 属于同一空间，runtimeId 相同，没有新增 Sprite。
- [ ] 讨论 Agent 实际运行 `pwd`、`git status --short --branch`、`git branch --show-current`、`git rev-parse HEAD`。目录正确、HEAD detached、分支名为空、SHA 等于记录值。
- [ ] 对比 refs，确认没有为讨论新建功能分支。
- [ ] 正文有效分支命中与默认分支回退有行为测试，thread 显示实际选择。
- [ ] 即使基线 ref 后续前进，已有讨论 SHA 和发布起点不变。可在隔离本地 Git 测试中验证，不为此改远端基线。
- [ ] 执行刚创建时 HEAD 等于 pinned SHA，拥有自己的分支与目录。
- [ ] 讨论后续消息和未提交调研文件不自动进入执行历史与工作树。
- [ ] 直接读新 conversation 的首条用户消息，等于发布原文，且没有继承讨论历史。不只检查页面上最新一条消息。
- [ ] EGO 中看到讨论初步分析，人继续聊天，明确发布后左边出现执行 Session。
- [ ] 灰色回链可点击，返回原讨论。
- [ ] 截图不含密钥，保存到 `docs/acceptance/issue-loop/`。

## 最终汇报

更新 `SPIKE.md`，把实测事实与设计、绕过、死路分开。必须包含：

- 做成哪几步、断在哪一步，是现有模型不允许，还是绕过了应用约束。
- 实际 workspaceId、runtimeId、基线分支、完整 commit。
- 讨论目录和 git status，无新讨论功能分支的证据。
- 执行 Session 的分支与目录。
- 回链是否可点击，执行首条消息是否不含讨论调研。
- 写锁、登录、错误处理、持久化、真实 GitHub 读取分别是否绕过或未验证。
- 假数据的具体函数与内容，缺失材料和原因。
- 自动化结果、EGO 操作、观察、截图与 PASS/FAIL。未跑写未验证，不填 PASS。
- 值得保留的交互只写动作和屏幕变化，不写组件拆分方案。

## worker 配置与冒烟结果

新增 Pi worker：`.pi/agents/issue-loop-worker.md`，名称 `issue-loop-worker`，模型 `magpie/auto/claude-haiku-5-5`，配置 `thinking: xhigh`。这是执行本任务的 worker 配置，不是应用中的模型路由功能，不修改本应用默认模型或现有 Kiro worker。

原请求的 `auto-claude-haiku-5-5` 未匹配；用户要求尝试 `claude-haiku-5-5` 后，在 Pi 中找到 `magpie/auto/claude-haiku-5-5`。Kiro 列表未列出 5.5。

只读冒烟 run `061e290d-81db-4571-8ea6-5e83b8b49658` 已完成：worker 读取本任务文档并复述约束，未执行实现或远端操作。父级检查会话记录，模型确为 `magpie` 的 `auto/claude-haiku-5-5`；但 `thinking_level_change` 实际记录为 `max`，并非请求的 `xhigh`。因此只能确认模型可运行，不能宣称 xhigh 已生效。配置仍保留用户要求的 xhigh，运行时差异待查；不自动改用其他模型或启动实现。
