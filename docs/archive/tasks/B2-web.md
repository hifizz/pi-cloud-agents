# Batch 2 / Task 9 + 10（WP6b + WP6c）：Web 前端

先读：`docs/CONTRACTS.md`、`docs/PLAN.md` §5.3 与 Task 9/10、`src/api.mjs`（真实端点与 WS 帧格式）、`web/test/fixtures/*.json`（录制的真实帧）、`node_modules/@earendil-works/pi-durable/dist/harness/events.d.ts`、`node_modules/@earendil-works/pi-ai/dist/types.d.ts`（Message/AssistantMessage/ToolResultMessage/内容块）。

## 你只能创建/修改
- `web/**`（独立 npm 包：`web/package.json`，在 `web/` 内 `npm install`，依赖使用精确版本）
- 失败时：`docs/fail-WP6.md`

## 技术栈
Vite + React 19 + TypeScript + Tailwind v4（`@tailwindcss/vite`）+ `react-markdown` + `remark-gfm`；测试 Vitest + `@testing-library/react` + jsdom。不引入组件库。

## 分层（严格遵守 PLAN §5.3）
```
web/src/
  types.ts            # ViewModel：BotSummary, ChatMessage{id, role:'user'|'assistant'|'system'|'compaction', parts: Part[], pending?}, Part = TextPart|ThinkingPart|ToolPart|ImagePart, ToolPart{id,name,args,status:'running'|'done'|'error'|'interrupted',output,resultText?,images?}, Usage, ConversationVM{messages, busy, inbox, usage, agent}
  lib/reducer.ts      # 纯函数：reduce(vm, frame) —— 唯一读取 pi 协议的地方；snapshot 帧 → 全量重建；events 帧 → 增量
  lib/stream.ts       # WS 客户端：指数退避重连（0.5s→8s），重连后服务端会先发 snapshot，reducer 全量重置
  lib/api.ts          # REST 封装（bots, input, abort, compact, reset, usage, entries, space）
  hooks/useBotStream.ts
  components/
    BotList.tsx  DesktopPane.tsx  UsageBadge.tsx  ApprovalBar.tsx(占位，后续任务实现)
    Chat/MessageList.tsx  MessageItem.tsx  ThinkingBlock.tsx  ToolCard.tsx  Composer.tsx
  App.tsx  main.tsx  index.css
```
- 组件只吃 ViewModel，**不得** import pi 类型或直接读事件。
- reducer 要处理：`message_start/update(text_delta, thinking_delta, toolcall_*)/end`、`tool_execution_start/update(output trimStart/append/set)/end`（end 的 entry 是 `pi.tool-result`，从中取结果文本/图片/isError；没有 entry → interrupted/error）、`entry_appended`（user 输入、compaction、reset 等）、`run_start/run_end`（busy）、`inbox_update`、`usage_changed`、`agent_changed`、`task_failed`（显示为系统消息）。snapshot 中的 `entries` 需转换为消息列表（user/assistant/tool-result 归并到对应 assistant 的 ToolPart）。

## 界面
- 三栏：左 `BotList`（忙/闲指示、新建 Bot 表单：name、modelId 下拉 [glm-5.3, glm-5.3-flash, claude-sonnet-5-5, gpt-5.6-terra]、instructions），中 Chat，右 `DesktopPane`（iframe：`GET /api/space` 返回的 `viewerUrl`；接口不存在或失败时显示提示文字；可折叠/调宽）。
- `MessageItem`：Markdown（GFM）；`ThinkingBlock` 默认折叠；`ToolCard` 可折叠，显示工具名、参数摘要、状态徽标、输出（等宽，最多 ~200 行可展开），图片结果显示缩略图（点击放大）。
- `Composer`：Enter 发送 / Shift+Enter 换行；Bot busy 时按钮变为 "Steer"（`whenBusy:"steer"`），另有 "Queue" 次按钮（follow-up）与 "Abort"；每次提交生成 `requestId`（crypto.randomUUID）。
- 头部：当前 Bot 名、模型、`UsageBadge`（tokens / $cost）、Compact / Reset 按钮。
- 可访问性：所有按钮有可见文字或 `aria-label`，可键盘操作，焦点可见；暗色主题。
- `vite.config.ts`：dev server 代理 `/api`（含 ws）→ `http://127.0.0.1:8080`；`build.outDir = "dist"`（server.mjs 托管 `web/dist`）。

## 验收
- `cd web && npm test` 全绿：reducer 单测用 `web/test/fixtures/*.json` 回放（文本/思考拼接、工具开始→结束、interrupted、snapshot 重置、迟加入：从中途 snapshot 开始回放得到同样的最终 VM）；组件冒烟（MessageList 渲染文本/思考/工具卡；Composer busy 时显示 Steer）。
- `cd web && npm run build` 成功，产物在 `web/dist`。
- `cd web && npx tsc --noEmit` 无错误。

最后输出：改动文件概览、测试/构建结果、未验证项、需要后端配合的接口（如 `/api/space`）。
