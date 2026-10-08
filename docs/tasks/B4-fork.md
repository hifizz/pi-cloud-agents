# Batch 4 / Task 14（WP8 + F09）：多 Bot 交接（fork）与压缩（仅后端）

先读：`docs/CONTRACTS.md`、`docs/PLAN.md` Task 14、规范 §4.7 F07 与 §4.9 F09、设计文档 §5.5、`vendor-ref/durable-examples/02-forks.ts`、`07-configuration.ts`、`25-compaction.ts`、`27-plan-mode.ts`、`28-reviewer.ts`、`src/bots.mjs`、`src/api.mjs`。

## 你只能创建/修改
- `src/bots.mjs`（**授权修改**：只新增 `forkBot`，不改现有方法签名）
- `src/routes/fork.mjs`
- `src/ext/history.mjs`（`search_history` 工具，见下）
- `test/fork.test.mjs`、`test/compaction.test.mjs`
- 失败时 `docs/fail-WP8.md`

## 要求
1. `BotRegistry.forkBot(fromIdOrName, { entryId?, name, modelId?, readOnly?, instructions? })`：`entryId` 缺省为父对话最新 entry；`conv.fork(entryId, { ownership:{kind:"ownerless"}, agent }, ctx)`；`readOnly: true` 时 agent 的 `tools` 收窄为只读集合：`read`、`desktop_screenshot`、`desktop_elements`、`desktop_windows`、`web_search`、`search_history`（按名字；查 `configure` 的 tools 字段接受对象还是名字——看 d.ts，若需对象，从 registry 解析：`harness` 上如何拿到 registry 的工具对象需要查清，必要时 forkBot 接受 `toolsResolver`）。新 Bot 记录增加 `parent: {botId, entryId}`。
2. `src/routes/fork.mjs`：`POST /api/bots/:id/fork {entryId?, name, modelId?, readOnly?}` → 新 bot。
3. `src/ext/history.mjs`：`History` 扩展，工具 `search_history {query, limit?}`（`replay:"safe"`），在当前 conversation 的**全部历史**（包括 reset/compaction 之前的 entries，用 `conv.entries` 翻页）里做大小写不敏感子串搜索，返回匹配片段（REQ-F09-2 / TEST-F09-2）。工具 execute 拿 conversation 的方式查 `ToolApi`（d.ts）。
4. 压缩：确认 `POST /api/bots/:id/compact`、`/reset` 已存在于 `src/api.mjs`（Task 8）。只写测试，不改 api.mjs；若缺功能，汇报。

## 验收
- `npm test` 全绿：
  - **TEST-F07-1**（faux）：父 Bot 两轮对话 → forkBot(readOnly) → 子 Bot 的 `context()`/entries 含父历史；子 Bot 的 agent tools 不含 `bash`/`write`/`edit`/`desktop_click`；faux 模型让子 Bot 调用 `write` → 得到"工具不可用"类错误结果（确认 pi-durable 对未提供工具的行为并断言）。
  - **TEST-F09-1**（faux）：长对话手动 `compact()` → 出现 `pi.compaction` entry，之后对话继续可用。
  - **TEST-F09-2**（faux）：`reset("handoff note")` 之后，`search_history` 仍能搜到 reset 之前的内容。
最后输出：改动文件、测试结果、需要编排者在 runtime.mjs 中的集成（History 扩展）、未验证项。
