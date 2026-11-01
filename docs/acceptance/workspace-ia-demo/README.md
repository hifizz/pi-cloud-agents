# Workspace 首页信息架构 Demo（探索轮）

快速探索实现，未写新 UI 单元测试；用户手动测试配合。所有改动在 `integration/amp13-loops-demo` 工作区，未提交、未部署。

## 行为变化

**Workspace 首页**
- Loops 概览：启用中的 Loop 卡片（名称、触发条件、最近一次运行状态与时间）、最近运行列表（最多 5 条，可直接打开对应会话）、停用数量提示；`管理全部 Loops →` 进入管理页。
- Issues：点击行只展开详情（编号、状态、作者、评论数、更新时间），动作显式化——`开始讨论 Session` / `打开讨论 Session`（已有讨论时）与 `在 GitHub 查看 ↗`；展开本身不创建会话。执行结果卡片仍按 issue 分组。
- Pull requests：`开放 / 已关闭 / 全部` 筛选（默认开放），每行显示状态徽标（开放/已关闭/已合并）、分支、更新时间；Review 按钮更名为 `打开 Review Session`，消除"查看 diff"的歧义。
- 设置模块：**环境变量为完整功能模块**（列表/新增/删除，值只写不读；未启用显示 TARSBOT_ENV_KEY 提示；加载失败显示错误+重试，不再永久 loading）；Skills 与 MCP 为占位卡片，标注三级粒度（整个 pi / 工作区 / 仓库）待定。

**Loops 页面**
- 固定 URL：`?workspace=<id>&loops=list`（列表）、`&loops=<loopId>`（运行历史）、`&loops=<loopId>&edit=1`（编辑）、`&loops=new`（新建）；刷新恢复当前视图。
- 页头新增 `← 返回工作区`，返回 workspace 首页。
- 从首页 Loop 卡片或最近运行可直达该 Loop 的运行历史。

**后端（最小改动）**
- `GET /api/workspaces/:id/overview?prs=all`：同时返回已关闭/已合并 PR（带 state），默认行为不变（仅开放）。
- `github.listIssues/listPulls` 增加 `updatedAt`；`listPulls` 支持 `state` 参数。

## 验证

- 后端 `TARSBOT_NO_DOTENV=1 npm test`：587 项，586 pass、1 skip、0 fail。
- 前端 `npm test`：235 项全部通过（更新了 issue 点击与 Review 按钮改名的既有断言）；typecheck、build 通过。

## EGO 浏览器验收（真实 GitHub 数据）

独立演示环境：当前源码 Vite `http://127.0.0.1:5183` → 8092 演示后端（数据为 loops 验收数据的 sqlite backup 副本，8090/8091 原服务未动；未新建 Sprite、未运行 Agent、未创建会话）。

1. 打开 workspace 首页：Loops 卡片与最近运行、Issues、PR 筛选、设置卡片全部渲染（01-overview.png）。
2. 点击 issue #13：展开详情（作者/评论数/更新时间 + 两个动作），未产生任何 API 创建调用（02-issue-detail.png）。
3. PR 筛选切换 开放/已关闭/全部 正常；该仓库当前无已关闭 PR，显示空态文案。
4. `管理全部 Loops →`：URL 变为 `?workspace=…&loops=list`（03-loops-list.png）；`← 返回工作区` 回到 `?workspace=…`。
5. 首页 Loop 卡片进入运行历史：URL `&loops=loop_…`（04-loop-runs-url.png）；刷新后仍停留在运行历史页。
6. 环境变量模块（05-env-settings.png）：空态 → 新增 `DEMO_COLOR=blue`（显示名称/时间/已加密，值不回显）→ 删除回到空态。演示后端 8092 已配临时 TARSBOT_ENV_KEY（仅进程内，未落盘）。

## 修复的 bug

首版卡片对环境变量请求失败没有终态，失败后永远显示“加载中…”（在旧后端 + 新 dist 的 8090 上必现）。已改为独立模块 `web/src/components/WorkspaceEnvSettings.tsx`，loading / 错误+重试 / 未启用（缺 TARSBOT_ENV_KEY）/ 正常列表四态齐全。

注意：8090 静态目录与主工作区共享 `web/dist`，重建后会拿到新 UI，但其长期运行的后端进程缺少 `/env` 等新路由——在本机演示请用 5183（→8092）。

## 已知边界（demo 级）

- 概览 Loops 数据在打开/刷新时拉取，不随 3s 轮询自动更新。
- Loops 编辑器 URL（`edit=1`）可恢复但未逐项浏览器验证。

## 追加：Issue / Review 首条消息排版（06-issue-brief-markdown.png）

`== 标题 ==` 式的纯文本墙改为真正的 Markdown 结构（聊天本来就按 GFM 渲染用户消息）：H1 会话标题、任务放引用块、背景为加粗标签列表、Issue 正文/评论/关联 PR/安全规则各成小节、diff 用代码围栏（Review 消息）。事实内容与措辞不变，仅排版调整；后端 586 项测试通过（两条 `== 安全规则 ==` 断言同步更新为 `## 安全规则`）。

验证方式：因共享 Sprite 的 git 凭据提示导致新建讨论会话在基线 fetch 处失败（环境问题，与本次改动无关），排版用同结构的真实模板文本在临时会话「格式预览（可忽略）」中渲染验证（立即 abort，0 token）。Review 消息为平行改动，由测试覆盖。

## 追加 2：讨论/Review 会话创建失败的根因与修复（07-real-issue-brief.png）

表象 `cannot open /dev/tty` 是误导：它出现在每条 git 命令的 stderr，包括成功时。真实错误被截断在后面——`git worktree add` exit 128：会话 worktree 目录按 workspace+issue 确定性哈希生成，该路径已被 10-31 的历史执行会话占用（executions 表 2 条记录指向同一目录），git 拒绝在已存在路径创建。

**处理**：新增 `addOrReuseWorktree`（src/routes/workspaces.mjs）：路径已存在时验证「已注册为该仓库 worktree 且 HEAD==目标 commit（分支 worktree 另查分支名）」，完全一致则直接复用；不一致返回 409 并指明冲突路径，绝不自动删除。接入讨论 / 发布执行 / Review 三处。fetch 与 add 拆分为独立 exec，两条相关测试断言同步拆分。

**验证**：后端 586 pass / 1 skip；8092 实测创建 issue #13 讨论会话返回 200，复用既有 worktree（未改动共享 Sprite 任何文件），新 Markdown 简报正常渲染，随即 abort。8090 的旧进程仍是老逻辑，重启拿到新代码后同样受益。
