# Batch 5 / 前端集成：审批条、fork、例程、清理

先读：`docs/CONTRACTS.md`、`web/src/**`（现有分层，必须遵守 PLAN §5.3：只有 `lib/reducer.ts` 读 pi 协议）、后端路由 `src/routes/approvals.mjs`、`src/routes/fork.mjs`、`src/routes/routines.mjs`、`src/api.mjs`（真实请求/响应格式，以代码为准）。

## 你只能创建/修改
- `web/**`
- 失败时 `docs/fail-web-features.md`

后端已在 `http://127.0.0.1:8080` 运行（编排者维护，**不要重启或杀掉它**）。可以 `curl` 读取接口确认格式；不要提交会改变数据的请求，除了你自己建的、名字以 `ui-test-` 开头的 Bot。

## 要求
1. **ApprovalBar**（TEST-F10-1 的 UI）：订阅 `WS /api/approvals/stream`（新建 `lib/approvals.ts`，带重连），在聊天区顶部显示当前 Bot 的待审批项：工具名、参数摘要（bash 显示命令）、原因；"Approve" / "Deny" 按钮 → `POST /api/approvals/:taskId {approved}`。其他 Bot 的待审批项在 BotList 上显示角标。
2. **Fork**（TEST-F07-1 的 UI）：消息悬停出现 "Fork from here" 按钮 → 小对话框（新 Bot 名、模型、"只读工具"复选框，默认勾选）→ `POST /api/bots/:id/fork {entryId, name, modelId?, readOnly}` → 刷新 Bot 列表并切换到新 Bot。ViewModel 的 `ChatMessage` 需要带 `entryId`（在 reducer 中从 entry 记录取 id）。Bot 列表中 fork 出来的 Bot 显示"↳ 父 Bot 名"。
3. **Routines 面板**：BotList 下方折叠区 "Routines"：列表（prompt、间隔、下次触发时间、bot）、新建（选 bot、prompt、间隔分钟）、取消。用 `GET/POST /api/routines`、`POST /api/routines/:id/cancel`。
4. **Compaction 显示**：确认 compaction 条目渲染为可折叠摘要（已有则跳过）。
5. 前端测试：reducer 带 entryId；ApprovalBar 渲染与按钮回调；Fork 对话框提交参数；Routines 面板列表渲染（mock fetch/WS）。

## 验收
- `cd web && npm test`、`npx tsc --noEmit`、`npm run build` 全部通过（构建产物 `web/dist` 由后端直接托管，构建完刷新页面即可生效）。
- 用 `curl` 核对你调用的每个接口的真实响应结构与前端类型一致，在汇报中列出。

最后输出：改动文件、测试/构建结果、未验证项。
