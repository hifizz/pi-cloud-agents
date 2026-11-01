# shadcn/ui 全量替换验收

任务：用 shadcn/ui（preset `base-nova`，Base UI 原语 + hugeicons）替换 web 前端全部手写 UI 组件；聊天区采用官方 ai-elements 组件（message / conversation / prompt-input 家族同源）。功能、URL 行为、测试契约不变。

环境：8092 后端（`/tmp/pca-wia-demo-data`）+ Vite dev 5183，账号 `demo@localhost`。

## 分区（4 个并行 poteto 子代理 + 编排者集成）

| 区 | 文件 | 结果 |
|---|---|---|
| 工作区首页 | App.tsx、WorkspaceEnvSettings、WorkspaceStatus、NewWorkspaceDialog、LoginPage、AuthGate | 85/85 |
| 聊天区 | Chat/**、ApprovalBar | 41/41 |
| 壳与面板 | shell/**、panels/** | 70/70（+107 回归） |
| 侧栏与 Loops | BotList、EnvironmentPane、RoutinesPanel、Loop*、ForkDialog、UsageBadge、gallery | 48/48 |

编排者全局门：`tsc --noEmit` 0 错误（修了 App.tsx 两处：未用 import、ToggleGroup 值类型）；`npx vitest run` **22 文件 / 235 测试全绿**；`npm run build` 成功。

## 主要组件映射

- 按钮 → `Button`（outline/default/link/ghost/destructive，size sm/xs/icon）
- 概览与面板卡片 → `Card size="sm"` 系列；状态 → `Badge`（secondary/destructive/outline）
- PR 状态筛选 → `ToggleGroup`；Loops 启用 → `Switch`；diff Wrap → `Toggle`
- 新建工作区 / Fork / 重建确认 → `Dialog`（Base UI 焦点陷阱 + Esc 免费）
- 聊天消息容器 → ai-elements `Message`/`MessageContent`；会话列表滚动 → `Conversation`/`ConversationContent`（use-stick-to-bottom）；Composer → `InputGroup` 家族（`PromptInput` 的 form/attachment 链与受控 submit 模型冲突，有意不用）
- 空态 → `Empty`；加载 → `Skeleton`；错误条 → `Alert variant="destructive"`
- 配色全部迁语义 token（`foreground`/`muted-foreground`/`border`/`card`）；`ok`/`warn`/diff 高亮因 shadcn 无对应物保留应用 token

## 有意保留原生（测试契约）

- `<select>` ×6（`userEvent.selectOptions` 依赖原生）：新建工作区、Fork、LoopEditor 触发器、会话状态、git 比较基线、events 追加目标
- events 的开关保留原生 checkbox（测试断言 `role="checkbox"`；Base UI `Switch` 是 `role="switch"`）
- PanelHost tab strip 保留原生 `role="tab"` 按钮；Thinking 折叠保留现有 Collapse（折叠即卸载语义）

## 已知事项

- `@theme` 中 `--color-accent` 双定义（应用蓝 #4b8dff vs shadcn 中性映射），后者生效；承重蓝已显式用 `brand`/`primary`。token 去重留给收尾轮。
- 面板 tab 条在 1680 宽度下 "Environment" 标签轻微截断（"Environme…"），纯观感问题。
- `ai`/`streamdown` 等依赖进入包体（ai-elements 源文件顶层 import），后续可裁剪。

## EGO 浏览器验收（全部 PASS）

| 截图 | 场景 | 观察 |
|---|---|---|
| 01-login.png | 登录页 | Google 按钮、邮箱/密码 Label+Input、主按钮，居中卡片 |
| 02-overview.png | 工作区首页 | Loops 卡片+最近运行、Issues 展开、PR 筛选（开放 7 选中）、Review 按钮，文案齐全 |
| 03-issues-pr.png | Issue 展开 + PR 列表 | 行点击仅展开，详情卡与显式操作按钮在位 |
| 04-loops.png | Loops 固定 URL | `?loops=list` 刷新恢复、返回按钮（loops-back）在位、6 个 Switch 渲染 |
| 05-session.png | 会话聊天 | Markdown 简报 H1 渲染、Message 卡片、Composer（模型徽章 sw、Enter 提示、发送键）、Idle 状态 |
| 06-panels-terminal.png | 终端面板 | PTY 警告卡 + 确认 checkbox + 禁用的启动按钮（安全默认），双 tab（终端/命令控制台） |
| 07-env-pane.png | 会话环境面板 | 环境信息卡 + 工作区/Session 环境变量两个折叠区 |
| 08-diff-panel.png | Changes 面板 | No turns/Wrap 工具条 + Empty 空态文案 |

操作路径：登录 → ?workspace= 深链 → Issue 行展开 → ?loops=list → ?bot= 会话 → Toggle side panel → Terminal/Environment/Changes 面板切换 → 登出/登录。控制台无错误（无 vite overlay / 白屏）。
