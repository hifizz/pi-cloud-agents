# UI / F3-feed：Chat 库换肤（feed 与 composer）

依赖：`docs/UI-PLAN.md`（全文，尤其 §1、§4、§6）。与 F1（骨架/App）、F2（Changes 面板）并行。

先读：
- 参考：`/Users/zilin/side/thread-chatbot/feat-cloud-work/app/demo/work-session-v2/feed-rows.tsx`、`center-pane.tsx`（feed 与 composer 部分）、`work-session-v2.css` 的 `CENTER` 段（`#feed`、`.feed-inner`、`.jump`、`.fold`、`.msg-assistant`、`.msg-user`、`.act*`、`.thought`、`.files-card`/`.files-head`/`.open-diff`/`.file-row`、`.composer*`、`.model`、`.send`、`.icon-btn`、`.caret`）；截图 `docs/ui/reference-work-session.png`（用读图工具看中间栏）。
- 我们的：`web/src/components/Chat/**` 全部、`web/src/lib/turns.ts`（只读：files 行的 `turnKey`）、`web/src/index.css`（令牌与 `.md` 段）、`web/src/gallery/main.tsx`、`web/test/chat-library.test.tsx`、`web/test/components.test.tsx`、`web/test/features.test.tsx`（MessageList/Fork 部分）。

## 你只能创建/修改

- `web/src/components/Chat/**`
- `web/src/gallery/main.tsx`
- `web/src/index.css`：**只限** `/* Markdown content */` 段及其后的 `.md`、`.md-streaming` 规则（令牌 `@theme` 与 body 段不要动）
- `web/test/chat-library.test.tsx`、`web/test/components.test.tsx`（新增用例；旧断言不得删弱）

**不要碰**：`web/src/App.tsx`、`web/src/components/*.tsx`（Chat 目录以外）、`web/src/shell/**`、`web/src/panels/**`、`web/src/lib/**`、后端。

## 要求

视觉对齐参考截图，行为与现在一致；所有 `zinc-*`/`sky-*` 硬编码迁移到令牌（`text-fg-dim`、`border-line`、`bg-raised`、`text-accent`…；焦点环用 `focus-visible:outline-accent`）。

1. **MessageList**：内容列 `max-w-[720px]`、左右 18px；上 26px 内边距、底部给 composer 留白；`Jump to latest` 改成参考 `.jump` 的胶囊（`bg-[#1c1c1c] border-[#2e2e2e] rounded-full shadow`），文字不变；空态换成令牌色。行间距规则 `gapBefore` 不改（在 lib 里），视觉上用户消息前大间距即可。
2. **UserMessage**：参考 `.msg-user`：`bg-raised border border-[#1d1d1d] rounded-xl px-3.5 py-3 text-[14.5px]`，靠右（参考是 `margin-left:88px`；我们保持右对齐并 `max-w-[85%]`），图片保持。
3. **AssistantText**：`text-[15px] leading-[1.62] text-[#e4e4e4]`；流式光标仿 `.caret`（块状闪烁，可沿用 `.md-streaming`，只改样式）。
4. **ActivityRow / ToolCall**：仿 `.act`：左侧 1px `border-[#202020]` + `pl-3`；头部一行：chevron（展开旋转 90°）、工具图标、标题、`font-mono` 参数（截断）、spacer、stat、`tool-duration`、状态（running：琥珀色转圈 + `running`；error：红色 `failed`；interrupted 不变；done 维持 sr-only `done`）。展开体仿 `.act-body`/`.act-out`（等宽、`max-h-[230px]` 滚动）。保留 testid、aria。
5. **FoldRow**：仿 `.fold`：`text-fg-dim text-sm` + chevron 旋转；收起时末尾小 chevron `#5a5a5a`；步数文案保留。
6. **Thinking**：仿 `.thought`：斜体、`text-fg-muted`、13.5px；可折叠行为与按钮名（`/thought/`）不变。
7. **FilesChanged + Open diff**：
   - props 改为 `{ files; turnKey?; onOpenDiff?: (turnKey: string, path?: string) => void }`，`FeedRowView` 的 files 分支传 `row.turnKey` 与 `handlers.onOpenDiff`。
   - 卡片仿 `.files-card`（`rounded-[10px] border border-line bg-[#0e0e0e]`）。头部：展开按钮（chevron、`N changed file(s)`、`+add −del`、`Show files/Hide files`）**与** `Open diff` 按钮并排（两个独立 `<button>`，不要嵌套；`Open diff` 仿 `.open-diff`：小边框按钮 + `diff` 图标），仅在 `onOpenDiff` 存在时渲染 `Open diff`，点击 → `onOpenDiff(turnKey, files[0].path)`。
   - 文件行：有 `onOpenDiff` 时点击 → `onOpenDiff(turnKey, f.path)`（不再行内展开）；没有时保持现在的行内展开 `DiffView`（测试依赖）。
   - 保留 `section aria-label="Changed files"` 与 `/1 changed file/` 按钮名。
8. **DiffView**（工具卡里的 diff）：行号栏 + `bg-diff-add`/`bg-diff-del` + 左侧色边，接近参考 `.act-diff`/`.dl`；不加语法高亮（那是 F2 的面板）。保留 `role=group` 与 label。
9. **Composer**，仿 `.composer`：
   - 卡片 `rounded-[14px] border border-[#262626] bg-field`，focus-within 边框变亮；textarea 无边框，placeholder 用参考的“Ask for changes, send follow-ups…”风格（busy 时保留现有 steer 提示语义）。
   - 底栏：左侧模型 chip（仿 `.model`：`h-7 rounded-[7px] px-2 text-[13px] text-fg-dim`，内含小方块缩写 + 模型 id；只展示，不做下拉）、排队数；右侧 Abort / Queue（busy 时）与圆形发送按钮（仿 `.send`：`size-[30px] rounded-full bg-[#2c2c2c]`；busy 时显示 `Steer` 文字的胶囊）。按钮可访问名 `Send`/`Steer`/`Queue`/`Abort` 与 label `Message` 不变。
   - 外层：底部渐变遮罩（参考 `.composer-wrap`），宽度与 feed 列一致。
   - `context` / `status` 插槽（编排者已加）按原样渲染在卡片下方，不加包裹样式（由 F1 提供带样式的内容）。
10. **Gallery**：更新 `gallery/main.tsx`：加一个带 `onOpenDiff`（console 输出）的 MessageList 例子、Composer 带示例 `context`/`status`；修正注释里的端口为 5183。
11. **测试**（新增）：
    - `onOpenDiff` 传入时 files 卡片有 `Open diff` 按钮，点击回调参数为 `(turnKey, 第一个文件路径)`；点击文件行回调 `(turnKey, 该路径)`；不传时没有 `Open diff`，文件行仍行内展开。
    - Composer 渲染 `context`/`status` 插槽内容。
    - 现有全部测试保持通过。

## 验收

- `cd web && npm test && npm run typecheck && npm run build` 通过（F1/F2 文件导致的失败注明后忽略）。
- 汇报：改动文件、测试结果、未验证项（视觉由编排者用浏览器验收）、需要编排者集成的改动。
