# UI / F2-diff：Changes（diff）面板

依赖：`docs/UI-PLAN.md`（全文，尤其 §3、§4）。与 F1（骨架/面板宿主）、F3（Chat 库换肤）并行。面板的 tab 头与开关由 F1 的 `PanelHost` 负责，你只做面板主体。

先读：
- 参考：`/Users/zilin/side/thread-chatbot/feat-cloud-work/app/demo/work-session-v2/diff-panel.tsx`、`markdown.ts`（`hiMarked` 分词器）、`types.ts`（`DiffFile`/`DiffHunk`）、`work-session-v2.css` 的 `RIGHT — diff panel` 段及 `.dl`/`.t-*`/`.skip`/`.fchip`/`.menu`；截图 `docs/ui/reference-work-session.png`（用读图工具看右侧）。
- 我们的：`web/src/panels/types.ts`、`web/src/panels/diff/index.tsx`（占位，你替换）、`web/src/lib/turns.ts`（`turnChanges`、`TurnChange`、`ChangedFile`）、`web/src/lib/diff.ts`（`DiffLine`：`kind add|del|ctx|gap`、`num?`、`text`）、`web/src/lib/format.ts`、`web/src/components/Chat/primitives/{Icon,DiffView,Collapse}.tsx`（只读、可 import）、`web/src/index.css`（令牌）、`web/src/types.ts`、`web/test/chat-library.test.tsx`（看 fixture 写法）。

## 你只能创建/修改

- `web/src/panels/diff/**`（替换 `index.tsx`，其余新建）
- `web/src/lib/highlight.ts`（新建）
- `web/test/diff-panel.test.tsx`（新建）

**不要碰**：`web/src/lib/turns.ts`、`web/src/lib/diff.ts`、`web/src/components/**`、`web/src/panels/types.ts`、`web/src/panels/index.ts`、`web/src/shell/**`、`index.css`、后端。需要改它们时写进汇报。

## 要求

1. **模块结构**（每个文件一个职责，可单独替换）：
   - `source.ts`：`interface DiffSource { id: string; label: string; useTurns(ctx: PanelContext): { turns: TurnChange[]; loading?: boolean; error?: string } }`；`conversationSource`（`useMemo(() => turnChanges(ctx.vm.messages, { busy: ctx.vm.busy }), …)`）。注释说明以后的 git 来源实现同一接口即可。
   - `DiffPanel.tsx`：组合下面的组件；props `PanelContext & { source?: DiffSource }`，默认 `conversationSource`。
   - `TurnSelect.tsx`：仿 `.turn-select` + `.menu`：按钮显示 `Turn N`，下拉列出所有有改动的 turn（`Turn N` + 截断的 `title` + `+add −del`），当前项高亮。键盘可用：Escape 关闭，点外部关闭（用 ref 判断，不要用全局 id），菜单 `role="listbox"`/选项 `role="option"`（或 menu/menuitem，二选一保持一致）。
   - `DiffToolbar.tsx`（仿 `.d-sub`，42px）：TurnSelect、本 turn 的 `+add −del`、右侧 `Wrap` 开关（`aria-pressed`，真实切换长行换行/横向滚动）、`Collapse all`/`Expand all` 切换（图标 `collapseAll`）。不做 Unified/Split/Whitespace。
   - `FileChips.tsx`（仿 `.d-files`/`.fchip`）：横向滚动的文件 chip，basename + `+a −d`，`title` 为全路径，选中态；点击滚动到该文件。
   - `DiffFileCard.tsx`（仿 `.dfile`）：sticky 头（折叠 chevron、语言徽标如 `TS`/`TSX`/`JS`/`PY`/`MD`/`SH`/`JSON`，按扩展名，未知取扩展名大写前 3 位或 `TXT`、全路径、复制路径按钮 `aria-label="Copy path"` 用 `navigator.clipboard?.writeText`、`−del +add`）；主体：每行 60px 行号栏 + 代码；`add` 行 `bg-diff-add` + 左侧绿色 2px 边，`del` 行 `bg-diff-del` + 红边，`ctx` 普通，`gap` 渲染成居中 `.skip` 条（文字“⋯”或“unmodified lines”）。根元素 `role="group"` `aria-label="Diff of <path>"` **会与 Chat 里的 DiffView 重名**——请用 `aria-label="Changes in <path>"` 避免测试歧义。
   - `EmptyState`：没有改动时显示说明：“No file changes in this conversation yet. Changes made by the edit/write tools show up here.”（bash 里做的修改不会出现，说明里点到即可）。
2. **`lib/highlight.ts`**：移植 `hiMarked` 的朴素 TS/JS 分词（关键字、字符串、数字、类型（大写开头）、函数调用、标点、注释），但**返回 token 数组** `{ text: string; kind?: "kw"|"str"|"num"|"type"|"fn"|"pun"|"cm" }[]`，由 React 渲染成 `<span className="text-syn-kw">` 等——**不得使用 `dangerouslySetInnerHTML`**。不处理参考里的 `[[…]]` 行内标记。非 JS/TS 类文件（按扩展名）可以不高亮。导出 `tokenize(line, lang?)`；性能：单行超过 2000 字符直接返回原文。
3. **focus**：`ctx.focus` 变化（看 `seq`）时：切到 `focus.turnKey` 对应的 turn（找不到则保持当前）；有 `path` 时展开该文件并 `scrollIntoView({ block: "start" })`（jsdom 下要判空），并把对应 chip 设为选中。
4. **默认选中**：没有 focus 时选最后一个 turn；当前选中 turn 消失（如 reset）时回退最后一个。
5. **状态**：折叠集合、wrap、当前 turn 都是面板内部 state；切换 turn 时清空折叠集合与选中文件。
6. **`index.tsx`**：`export const diffPanel: PanelDefinition = { id: "diff", title: "Changes", icon: "diff", Component: DiffPanel, badge: (ctx) => 文件总数或 undefined }`。badge 计算要便宜（直接 `turnChanges` 一次即可）。
7. 样式全部用令牌类（`bg-surface`、`border-line`、`text-fg-dim`、`bg-diff-add`、`text-syn-*`…），字体 `font-mono` 12.5px、行高约 1.7，接近参考截图。面板主体 `flex h-full flex-col`，文件列表区 `flex-1 overflow-auto`。
8. **测试 `web/test/diff-panel.test.tsx`**（构造带 edit/write 工具结果的 `ChatMessage[]`，参考 `chat-library.test.tsx`）：
   - `tokenize`：关键字/字符串/注释分类，超长行原样返回。
   - 多 turn：默认显示最后一个 turn；TurnSelect 切换到另一个 turn 后文件 chip 与卡片更新；Escape 关闭菜单。
   - 折叠单个文件、Collapse all / Expand all、Wrap 的 `aria-pressed`。
   - `focus={{ turnKey, path, seq: 1 }}` 选中对应 turn 与文件；再给 `seq: 2` 同一目标仍生效（不报错）。
   - busy 的最后一个 turn 不出现；无改动时显示 EmptyState。
   - 自定义 `source` 注入能替换数据（证明可替换）。
   - `diffPanel.badge` 返回文件数。

## 验收

- `cd web && npm test && npm run typecheck && npm run build` 通过（F1/F3 文件导致的失败注明后忽略）。
- 汇报：改动文件、测试结果、未验证项、需要编排者集成的改动。
