# SPIKE-workspace-overview：工作区首页展示 Issues 和 PR

用户追加任务。继续 `spike/issue-loop`，Fast Demo，不生产化。用户明确禁止继续用 Haiku，开发 worker 使用 `magpie/devin/swe-2`。本轮不提交、不推送、不合并，除非另获授权。

## 目标交互

- 点击左侧工作区大条目，中央显示真正的工作区总览，不再默认跳主 Session。
- 总览展示仓库名、空间状态，以及 Issues 和 Pull requests 两块列表。两类条目分开显示，编号、标题、状态可见。
- 只展示未解决 Issues（state=open）和仍开放、未合并的 PR（state=open）。不展示已关闭 issue、已关闭但未合并 PR 或已合并 PR。通过 GitHub REST 分页读取，不只展示第一页，也不把 PR 当 issue。PR 链接打开 GitHub 页面；不建 PR 管理或合并操作。
- 后续可在 PR 旁增加「Code Review」并创建 review Session。本轮只展示 PR，不实现 review、不放无功能的占位按钮、不为未来 review 抽接口。
- 点击 Issue 行：如果同空间已有该 issue 的讨论 Session，直接进入它。没有则通过已有 discuss 路径创建并打开。已有执行 Session 不能误认为讨论。
- 在后端 discuss 入口优先查找同 workspaceId、同 issue 且没有 branch/sourceBotId 的讨论，返回它，不再次执行 worktree add 或提交起始消息。只处理顺序重复点击，不做并发锁/重试/补偿。
- 左侧 Session 条目仍进入聊天。点工作区回总览。保留「⋯ → 添加 Session」、创建成功选中新 Session、发布任务和灰色回链。
- 总览不展示旧 Session 的消息、输入框、usage 或右侧 Session 面板。工作区加载失败显示简短错误即可，不加兜底数据或后台 GitHub 轮询。
- 一次打开/切换工作区时读取一次真实 GitHub 数据，提供手动刷新按钮。不要把 GitHub 请求接入现有 3 秒 bots 轮询。

## 最小实现与边界

先读 AGENTS.md、src/github.mjs、src/routes/workspaces.mjs、web/src/App.tsx、web/src/components/BotList.tsx、web/src/lib/workspaces.ts、web/src/shell/WorkspaceShell.tsx、现有 issue-loop tests。

复用现有 GitHub REST client、paginate、注册表 issueLoop metadata、discuss API 和聊天。工作区详情可加一个已鉴权 GET 路由，返回 issues、pulls 及对应讨论 botId。数据来源是该空间绑定的 repo，不接受另传任意 repo。不能访问或修改其他远端仓库；现场只测 hifizz/tars-sandbox-playground。

前端明确区分“工作区总览”和“选中 Session”，不要让自动选主 Session 的 fallback 覆盖总览。不要用新路由库、新数据库表、搜索产品或同步系统。

允许修改：
- `src/github.mjs`
- `src/routes/workspaces.mjs`
- `web/src/App.tsx`
- `web/src/components/BotList.tsx`
- `web/src/lib/workspaces.ts`
- `web/src/shell/WorkspaceShell.tsx`（仅必要接线）
- `test/issue-loop.test.mjs`
- `web/test/issue-loop.test.tsx`
- `web/test/workspaces.test.tsx`（旧选择行为测试需要调整时）

优先在 App.tsx 内加小总览组件，不抽新产品模块/接口层。必要时先报告文件边界变化。不要改模型网关、默认应用模型、provider、routine、鉴权。

## 开发和验收

最小正常路径测试：issue/PR 区分及分页；同空间已有讨论复用且不调用 worktree 创建；工作区点击总览、Issue 点击聊天、Session 点击聊天、新 Session 自动打开。全量后端/前端 tests、typecheck、build。

worker 不远端操作，不开服务或浏览器，不占 8090/5183，不读 .env，不提交、不推送，不删 data/Sprite。父级负责 EGO 和现场证据。

现场空间 `ws_e168e5f97244a35b`，Sprite `pca-eae56f671c`，已有 issue #12 对应讨论 bot `14a4c184`、执行 bot `b3b1d0d1`，以及手动 Session `2d5d5f01`。父级点击工作区看真实 issue/PR，再点 #12 应进入已有讨论而不新建目录/Session。可在同一测试仓库用一个新 issue 验证首次点击创建，不造沙箱。截图 `docs/acceptance/workspace-overview/`。

正常路径通过即停，不补异常矩阵，不整理成生产级实现。
