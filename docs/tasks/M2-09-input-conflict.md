# M2-09：聊天输入的请求内容冲突检查

依赖：无。`src/api.mjs` 在 M2 里只有本任务能改，且**仅限 `POST /api/bots/:id/input` 路由**。

先读：`docs/M2-PLAN.md` §3.5；`docs/m1-probe.md` 的 A3（同一 `requestId` 不同内容会被 Pi Durable 静默复用旧消息）；`src/api.mjs`（`input` 路由、`HttpError`、`app.ctx`、`extraCtx`）；`src/control/store.mjs` 的 `requests.begin`（返回 `{created, conflict}`，不覆盖旧记录）；`web/src/App.tsx`（`sendInput` 的调用）、`web/src/lib/api.ts`（`sendInput` 已支持 `requestId`）；`test/api.test.mjs`。

## 你只能创建/修改
- `src/api.mjs`（**只改 `POST /api/bots/:id/input` 路由**，其余一行不动）
- `src/control/store.mjs` 里 `requests` 的清理方法（**只新增** `requests.prune({ olderThanMs })`；M2-02 同时在改这个文件的 `locks` 与 `workspaces`，两处互不重叠，冲突时以汇报为准让编排者合并）
- `web/src/App.tsx`（**只改发送输入的部分**）、`web/src/lib/api.ts`
- `test/api.test.mjs`、`web/test/` 下相关测试

**共享文件**：`web/src/lib/api.ts`、`web/src/types.ts`、`web/src/lib/workspaces.ts`（以及 M2-09 的 `src/control/store.mjs`）会被其他任务同时修改——只追加、用精确小编辑、不整文件重写，规则见 `docs/M2-PLAN.md` §8.1。

## 要求
1. 路由：`requestId` 给出且 `app.ctx.control` 已注入时，在 `conv.submit` 之前调用 `control.requests.begin({ scope: \`bot.input:${bot.conversationId}\`, requestId, payloadHash })`，其中 `payloadHash = sha256(JSON.stringify([text, whenBusy ?? null]))`。`conflict` → `HttpError(409, "requestId 已用于不同内容")`（文案必须与现有的「bot is busy」409 区分）。同内容重试 → 与现在一样返回同一个 `submissionId`。
2. 没有 `requestId`，或没有注入 `control`（裸 `createApi` 的旧测试）→ **行为与现在完全一致**；加测试证明。
3. 进程在 `begin` 与 `submit` 之间死亡后，同内容重试仍会提交（`begin` 不覆盖旧记录，所以不会误判为"已提交"）；加一个测试：先 `begin` 再不 `submit`，然后同内容请求 → 成功提交一次。
4. `requests.prune({ olderThanMs })`：删除早于阈值的记录并返回条数。服务启动时的调用由编排者在 M2-11 接线，你只实现和测试。
5. 前端：`sendInput` 的每次用户发送生成一个 `requestId`（`crypto.randomUUID()` 或现有的 `newRequestId`）；**发送失败后的重试复用同一个**，发送成功后下一次是新的。输入框里内容被改过再发送，也要换新的 `requestId`（否则会撞上刚实现的 409）。
6. 409 的前端展示：在输入框附近显示错误，不丢用户输入。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿，`cd web && npm test && npm run typecheck` 通过（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。
- 必测：同编号同内容 → 同一 `submissionId`；同编号不同内容 → 409 且**不创建会话消息**（用 `entries` 断言没有新增）；不同 `whenBusy` 算不同内容；无 `requestId` 与无 `control` 的旧行为不变；`scope` 按会话隔离（两个会话用同一个 `requestId` 互不冲突）；`begin`/`submit` 之间死亡的恢复用例；前端：每次发送带 `requestId`、失败重试复用、改内容后换新、409 的提示与输入保留。
- 不连网、不调用真实模型。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项。
