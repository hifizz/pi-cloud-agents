# 前端刷新：work-session 三栏界面（Spec）

> 起草：2026-10-16。参考：`/Users/zilin/side/thread-chatbot/feat-cloud-work/app/demo/work-session-v2/`（React 版）与同仓库根目录 `work-session.html`（静态版），截图 `docs/ui/reference-work-session.png`。
> 只改前端 `web/`，**不新增后端接口**。默认模型已改为 `swe-2`（编排者完成）。

## 1. 决策

| # | 决策 |
|---|---|
| U-D1 | 照搬参考页的**视觉与布局**：左 rail 272px（可折叠）｜中间会话（56px 头 + feed + 底部 composer 卡片）｜右侧面板（可开关），深色单主题。不照搬它的数据模型（`model.ts`/`data.ts`/`codex/` 都不要）——我们已有 `lib/reducer.ts` → `ConversationVM` → `lib/turns.ts` 的数据链路，参考页的 fold 规则我们也早已实现 |
| U-D2 | 样式用 Tailwind 4 + `web/src/index.css` 里的 `@theme` 设计令牌（已由编排者写好，§2）。**不要**把 `work-session-v2.css` 整个拷进来，也不要用全局 id 选择器；组件里用 `bg-surface`、`border-line`、`text-fg-dim` 等令牌类。旧的 `zinc-*` 硬编码颜色在各自负责的文件里迁移到令牌 |
| U-D3 | 右侧面板是**可插拔模块**（§3）：`web/src/panels/<id>/` 一个目录一个面板，`panels/index.ts` 的 `PANELS` 数组决定有哪些、什么顺序。增删、替换面板只改这个数组 |
| U-D4 | 本轮面板：`diff`（Changes：会话里 edit/write 工具产生的改动，按 turn 查看）、`environment`（沙箱信息）、`routines`（定时例程，从 rail 挪过来）。真实 `git diff` 没有后端接口，先不做；Changes 面板内部用 `DiffSource` 抽象（§4），以后换成 git 来源只需新增一个 source |
| U-D5 | 布局骨架（`shell/`）不含业务：只提供插槽与开关状态。业务装配只在 `App.tsx` |
| U-D6 | 参考页里纯装饰、无功能的按钮（Play run、+▾、box▾、github▾、Split、Whitespace、"+" 新 tab 等）**不做**。做上去的每个控件都要有真实行为 |
| U-D7 | 现有测试是约束：保留所有 `data-testid`、aria label/role、按钮文字（含中文“退出”等）、导出的函数名与组件路径（见 §6）。可以新增测试，改旧测试只限结构性调整（例如 RoutinesPanel 新增 prop 后的渲染方式），不得删弱断言 |

## 2. 设计令牌（`web/src/index.css`，已存在）

颜色：`surface #0a0a0a`、`rail #030303`、`raised #141414`、`field #151515`、`hover`、`selected #1e1e1e`、`line #1f1f1f`、`line-soft`、`line-strong #272727`、`fg #ededed`、`fg-dim #a1a1a1`、`fg-muted #6f6f6f`、`fg-faint #565656`、`accent #4b8dff`、`brand #1668e3`、`ok`、`bad`、`warn`、`diff-add`、`diff-del`、`syn-kw|str|num|type|fn|pun|cm`。字体 `font-sans`、`font-mono`。
用法：`bg-raised`、`border-line`、`text-fg-muted`、`bg-diff-add`、`text-syn-kw`……参考页里的零散灰（`#131313`、`#1b1b1b`、`#2a2a2a` 等）用最接近的令牌或 Tailwind 任意值 `bg-[#131313]`。
图标：`components/Chat/primitives/Icon.tsx` 已加 `sidebar`、`panelRight`、`plus`、`branch`、`folder`、`box`、`collapseAll`、`more`、`settings`、`logout`。需要新图标写进汇报，或在自己负责的目录里放局部 svg。

## 3. 面板契约（`web/src/panels/types.ts`，已存在）

```ts
interface PanelFocus { turnKey?: string; path?: string; seq: number }
interface PanelContext { bot?: BotSummary; bots: BotSummary[]; vm: ConversationVM; space?: SpaceInfo; focus?: PanelFocus }
interface PanelDefinition { id: string; title: string; icon: IconName; Component: ComponentType<PanelContext>; badge?: (ctx) => string | number | undefined }
```

- `PanelHost`（F1）渲染 56px 头部：每个面板一个 tab（图标 + 标题 + 可选 badge），右侧“关闭面板”按钮；下面渲染当前面板的 `Component`。
- `focus` 只传给它指向的面板；`seq` 每次请求递增，面板据此滚动/选中（同一目标再点一次也要生效）。
- 面板之间不互相 import；面板不直接调用 shell。
- `web/src/panels/diff/index.tsx` 目前是编排者写的占位，导出 `diffPanel`，由 F2 替换。

## 4. Changes 面板的数据（`web/src/lib/turns.ts`，已存在）

- `turnChanges(messages, { busy }) → TurnChange[]`：`{ key, index, title?, files: ChangedFile[], add, del }`，只含已结束且有改动的 turn，规则与 feed 的 files 行相同。
- `key` 与 feed 行的 `turnKey` 一致（`FeedRow` 的 `files` 行已加 `turnKey`）。
- “Open diff” 链路：`FilesChanged`（F3）→ `FeedRowHandlers.onOpenDiff(turnKey, path?)` → `MessageList` 的 `onOpenDiff` prop（已加，透传）→ `App`（F1）调用 `openPanel("diff", { turnKey, path })` → Changes 面板收到 `focus`（F2）。

## 5. 任务拆分（三个 worker 并行）

| ID | 内容 | 主要文件 |
|---|---|---|
| F1-shell | 布局骨架、rail、会话头、面板宿主与开关状态、environment/routines 面板、App 装配、其余周边组件换肤 | `shell/**`、`panels/index.ts`、`panels/environment/**`、`panels/routines/**`、`App.tsx`、`components/*.tsx`（Chat 以外） |
| F2-diff | Changes 面板：turn 选择、文件 chip、按文件折叠的 diff（行号、语法高亮、gap 条）、折叠全部、换行开关、复制路径、`DiffSource` | `panels/diff/**`、`lib/highlight.ts` |
| F3-feed | Chat 库换肤：用户消息卡片、助手正文、工具行、fold、thinking、files 卡片 + Open diff、composer 卡片、Jump to latest、gallery | `components/Chat/**`、`gallery/main.tsx`、`index.css` 的 `.md` 段 |

已由编排者完成的契约改动（worker 不要回退）：`index.css` 令牌、`Icon.tsx` 新图标、`turns.ts` 的 `turnKey`/`turnChanges`、`FeedRow.tsx`/`MessageList.tsx` 的 `onOpenDiff`、`Composer.tsx` 的 `context`/`status` 插槽、`panels/types.ts`、`panels/diff/index.tsx` 占位、`BotList.tsx` 的 `MODEL_OPTIONS`（`swe-2` 在首位）。

## 6. 必须保留的测试约束

- testid：`tool-card`、`tool-duration`、`approval-item`、`routine-item`、`sprite-card`（带 `data-sandbox`）。
- 角色/名字：`role=log "Conversation"`、`region "Changed files"`、`group "Diff of <path>"`、`group "edit diff"`、`label "bash output"`、按钮 `Send`/`Steer`/`Queue`/`Abort`/`Fork from here`/`Fork`/`Approve`/`Deny`/`New bot`/`Create`/`退出`/`Jump to latest`/`/worked for 42s/`/`/thought/`/`/1 changed file/`；`img` busy/idle；`status` "N pending approvals"；输入框 label `Message`、`Name`、`Model`、`Instructions (optional)`、`New bot name`、checkbox `/read-only tools/`。
- 组件路径与导出：`components/{ApprovalBar,ForkDialog,RoutinesPanel,BotList,AuthGate,UsageBadge}`、`components/Chat/{MessageList,Composer,index}`、`summarizeArgs`、`formatInterval`、`formatNext`、`MODEL_OPTIONS`、`usageLabel`。
- `MessageList` 不传 `onOpenDiff` 时，FilesChanged 保持现在的行内展开 diff 行为（测试依赖）。

## 7. 验收

- 每个 worker：`cd web && npm test && npm run typecheck && npm run build` 通过（别人文件导致的失败注明）。
- 编排者合入后：后端 `TARSBOT_NO_DOTENV=1 npm test`；EGO 浏览器验收（模型 `swe-2`）：登录 → 新建 Bot → 让 Bot 在沙箱里创建并编辑一个文件 → feed 出现 files 卡片 → Open diff 打开 Changes 面板定位到该文件 → 切换 Environment/Routines 面板 → 折叠 rail/面板 → 触发一次审批（例如 `git push --force` 到测试仓库分支）。截图存 `docs/acceptance/UI/`。
