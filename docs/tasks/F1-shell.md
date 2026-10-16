# UI / F1-shell：三栏骨架、rail、会话头、面板宿主、App 装配

依赖：`docs/UI-PLAN.md`（全文，尤其 §1、§3、§6）。与 F2（Changes 面板）、F3（Chat 库换肤）并行。

先读：
- 参考：`/Users/zilin/side/thread-chatbot/feat-cloud-work/app/demo/work-session-v2/` 的 `demo-app.tsx`、`rail.tsx`、`center-pane.tsx`、`diff-panel.tsx`（只看头部 `.d-head`）、`work-session-v2.css`（`#rail`、`.c-head`、`.hbtn`、`.composer-wrap`、`.worktree`、`.statusline`、`#diff`、`.d-tab` 段）；截图 `docs/ui/reference-work-session.png`（用读图工具看）。
- 我们的：`web/src/App.tsx`、`web/src/main.tsx`、`web/src/index.css`、`web/src/types.ts`、`web/src/lib/api.ts`、`web/src/panels/types.ts`、`web/src/panels/diff/index.tsx`、`web/src/components/*.tsx`、`web/src/components/Chat/Composer.tsx`（只读，看 `context`/`status` 插槽）、`web/src/components/Chat/MessageList.tsx`（只读，看 `onOpenDiff`）、`web/test/*.test.tsx`。

## 你只能创建/修改

- 新建：`web/src/shell/**`、`web/src/hooks/useSpace.ts`、`web/src/panels/index.ts`、`web/src/panels/environment/**`、`web/src/panels/routines/**`、`web/test/shell.test.tsx`
- 修改：`web/src/App.tsx`、`web/src/components/{BotList,RoutinesPanel,EnvironmentPane,ApprovalBar,ForkDialog,UsageBadge,LoginPage}.tsx`、`web/index.html`（只改 `<title>`）、`web/test/features.test.tsx` 与 `web/test/components.test.tsx`（仅当结构调整必须时；不得删弱断言）

**不要碰**：`web/src/components/Chat/**`（F3）、`web/src/panels/diff/**`、`web/src/lib/**`（F2/编排者）、`web/src/panels/types.ts`、`web/src/index.css`、`web/src/gallery/**`、后端。

## 要求

1. **`shell/WorkspaceShell.tsx`**：纯布局，插槽 `rail`、`main`、`panel`，props `railOpen`、`panelOpen`。`h-dvh flex overflow-hidden bg-surface`；rail `w-[272px] shrink-0 bg-rail border-r border-line`；main `flex-1 min-w-0 flex flex-col`；panel `w-[min(560px,45vw)] shrink-0 border-l border-line`。关闭时不渲染对应列。不含任何业务 import。
2. **`shell/usePanelState.ts`**：`{ open, active, focus, openPanel(id, target?: { turnKey?, path? }), select(id), toggle(), close() }`。`open`/`active` 持久化到 `localStorage["pca.panel"]`（JSON；坏值回退默认：open=true、active=第一个面板）。`openPanel` 打开并切换到该面板，有 target 时设置 `focus = { ...target, seq: prev+1 }`。`focus` 只在 `active === focus 的目标面板` 时传给面板（记录目标 id）。同理 `shell/useRailState.ts`（`localStorage["pca.rail"]`，默认 open）。
3. **`shell/PanelHost.tsx`**：props `{ panels: PanelDefinition[]; active; onSelect; onClose; ctx: PanelContext; focus? }`。56px 头部：每个面板一个 tab（`role="tab"`，`aria-selected`，图标 + 标题 + badge；选中态仿 `.d-tab`：`bg-[#161616] border border-[#242424] rounded-lg`），外层 `role="tablist"`；右侧关闭按钮 `aria-label="Close panel"`（图标 `panelRight`）。主体 `role="tabpanel"` `flex-1 min-h-0 overflow-hidden`，只渲染当前面板的 `Component`。`active` 不在列表里时回退第一个。
4. **`panels/index.ts`**：`export const PANELS: PanelDefinition[] = [diffPanel, environmentPanel, routinesPanel]`，文件头注释说明“增删/替换面板只改这里”。
5. **`panels/environment/`**：`environmentPanel`（id `environment`，标题 `Environment`，图标 `box`）。主体复用 `EnvironmentPane`，把它改成接收 `space`/`bot`/`vm` props 的展示组件（不再自己 fetch；`space` 未到显示“加载中…”，`space` 为 undefined 且已失败显示“执行环境信息不可用”——失败状态由 `useSpace` 给）。内容：沙箱类型与名字、工作目录（`vm.agent.cwd ?? space.cwd ?? "/home/sprite/workspace"`）、当前 Bot 的模型、thinking level（如有）。保留 `data-testid="sprite-card"` 与 `data-sandbox`。样式用 `<dl>` 两列、令牌色。
6. **`panels/routines/`**：`routinesPanel`（id `routines`，标题 `Routines`，图标 `clock`，badge 可省）。主体是 `RoutinesPanel`：给它加 `embedded?: boolean` prop——`embedded` 时没有折叠头、挂载即加载并轮询；默认（不传）保持现在的折叠行为，现有测试不改。换成令牌样式。
7. **`hooks/useSpace.ts`**：`api.space()` 一次，返回 `{ space?: SpaceInfo; failed: boolean }`。
8. **Rail（`shell/rail/`）**，参考 `rail.tsx`：
   - `RailHeader`：56px，参考页的蓝色渐变背景；logo 方块 `PI`（`bg-brand`）、品牌名 `pi-cloud-agents`；右侧折叠按钮 `aria-label="Collapse sidebar"`（图标 `sidebar`），真实折叠 rail。
   - 中部：`BotList`（见 9）。
   - `RailFooter`：40px，登录邮箱（截断，`title` 全文）+ 退出按钮（可访问名必须是 `退出`，可带 `logout` 图标），调用 `auth.logout()` 后 `onLoggedOut`。
9. **`components/BotList.tsx` 换肤**，参考 `.sess` 卡片：
   - 顶部 nav 行：搜索框（`aria-label="Search bots"`，按名字过滤，客户端）和 `New bot` 按钮（文字保持 `New bot`，展开现有的新建表单；表单字段 id/label 不变）。
   - 每个 Bot 一张卡片（`button`，选中态 `bg-selected border-[#262626]`）：顶行 `font-mono` 模型 id + 右侧相对时间（`createdAt`，如 `2h`/`3d`，无则不显示）；标题行 Bot 名（单行截断）；副行 `↳ parent` 血缘、`N queued`；右下角状态：busy 时琥珀色脉冲点，idle 时灰点（保持 `role="img"` `aria-label="busy"|"idle"`）；审批徽标保持 `role="status"` `aria-label="N pending approval(s)"`。
   - `MODEL_OPTIONS` 保持导出与当前值（编排者已把 `swe-2` 放首位）。
10. **会话头（`shell/SessionHeader.tsx`）**，参考 `.c-head`：56px；rail 折叠时左侧显示 `aria-label="Expand sidebar"` 按钮；面包屑：沙箱徽标（`SP`/`E2`，`bg-brand` 小方块）+ 沙箱名 + `/` + Bot 名（粗体白色，`h1`）；右侧：连接状态（保持现有 `role="status"` 文案 Reconnecting…/Connecting…/Disconnected）、`Compacting…`、`UsageBadge`、`Compact`、`Reset`（`.hbtn` 样式，行为与现在一致，Reset 仍 `window.confirm`）、面板开关按钮 `aria-label="Toggle side panel"`（`aria-pressed`，图标 `panelRight`）。没有 Bot 时标题显示 `pi-cloud-agents`。
11. **Composer 下方插槽**（`shell/ComposerContext.tsx`，导出两个组件传给 `Composer` 的 `context` / `status`）：
    - `WorktreeStrip`：仿 `.worktree`（贴在输入卡片下：`mx-2.5 h-[34px] border border-t-0 border-[#222] rounded-b-[10px] bg-[#101010] text-[11.5px] text-fg-faint`）：左 `box` 图标 + `Sprite <name>` 或 `E2B <name>`；右 `folder` 图标 + 工作目录（截断）。
    - `StatusLine`：仿 `.statusline`：小圆点 + 文本：断线 → 连接状态；busy → `Working…`；有排队 → `N queued`；否则 `Idle`。颜色 idle 用 `#8fb98f`。
12. **其余组件换肤**（行为不变）：`ApprovalBar`（琥珀色条，放在会话头下方）、`ForkDialog`、`UsageBadge`、`LoginPage`，从 `zinc-*` 迁到令牌。
13. **`App.tsx`**：只做数据与装配：现有状态与回调全部保留；渲染 `WorkspaceShell`，rail = Header + BotList + Footer（RoutinesPanel 移出 rail）；main = SessionHeader + ApprovalBar + 其他 Bot 的待审批提示 + 错误条 + `MessageList`（传 `onFork`、`onOpenDiff={(turnKey, path) => panels.openPanel("diff", { turnKey, path })}`）+ `Composer`（传 `context`/`status`）；panel = `PanelHost`，`ctx = { bot, bots, vm, space, focus }`。header 里的邮箱/退出移到 rail footer。`ForkDialog` 不变。
14. **测试 `web/test/shell.test.tsx`**：
    - `PanelHost` 用两个假面板：渲染 tab、点击切换、`active` 无效时回退第一个、关闭按钮回调、badge 显示——证明面板可替换。
    - `usePanelState`：`openPanel("b", {path})` 打开并切换、`focus.seq` 递增、localStorage 持久化与坏值回退。
    - `WorkspaceShell`：`panelOpen=false` / `railOpen=false` 时不渲染对应列。
    - `BotList` 搜索过滤。
    - `RoutinesPanel embedded` 挂载即请求。
    - `EnvironmentPane` 新 props：e2b/sprites 显示、`data-sandbox`、cwd 回退。

## 验收

- `cd web && npm test && npm run typecheck && npm run build` 通过（F2/F3 文件导致的失败注明后忽略）。
- 汇报：改动文件、测试结果、未验证项（视觉效果由编排者用浏览器验收）、需要编排者集成的改动。
