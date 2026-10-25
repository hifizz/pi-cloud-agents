# M2-08：「先出方案」

依赖：M2-02（迁移 v2 里的 `workspaces.mode` 与 `plan_approved_at`、`store.workspaces` 的读写）。

先读：`docs/M2-PLAN.md` §3.4；`src/workspaces.mjs`（`workspaceInstructions`、`normalize`、`create`、`dispatchTask`）；`src/routes/workspaces.mjs`（`view()`、`POST /api/workspaces`、`jsonObject`、`mapError`）；`src/ext/approval.mjs`（`beforeTool` 钩子的写法与返回 `{block}`）；`node_modules/@earendil-works/pi-durable/dist/**/*.d.ts` 里 `beforeTool` 的类型；`web/src/components/NewWorkspaceDialog.tsx`、`WorkspaceStatus.tsx`、`web/src/lib/workspaces.ts`。

## 你只能创建/修改
- `src/ext/planmode.mjs`、`test/planmode.test.mjs`
- `src/routes/workspaces.mjs`（**只改**：创建时接受 `mode`；视图里带 `mode`、`planApprovedAt`；新增 `POST /api/workspaces/:id/plan/approve`）
- `src/workspaces.mjs`（**只改**：`normalize` 接受 `mode` 并参与 `payloadHash`；`workspaceInstructions` 在 `plan` 模式下追加方案要求。M2-04 同时会改这个文件的 `dispatchTask`，两处不重叠）
- `web/src/components/NewWorkspaceDialog.tsx`、`web/src/components/WorkspaceStatus.tsx`；`web/src/lib/workspaces.ts`、`web/src/lib/api.ts`、`web/src/types.ts`（这三个是共享文件，**只追加**）
- `test/routes-workspaces.test.mjs`、`test/workspaces.test.mjs`（仅新增用例）、`web/test/workspaces.test.tsx`（仅新增用例）

**共享文件**：`web/src/lib/api.ts`、`web/src/types.ts`、`web/src/lib/workspaces.ts`（以及 M2-09 的 `src/control/store.mjs`）会被其他任务同时修改——只追加、用精确小编辑、不整文件重写，规则见 `docs/M2-PLAN.md` §8.1。

## 要求
1. **创建**：`POST /api/workspaces` 的 body 可带 `mode: "direct"|"plan"`（默认 `direct`，其他值 400）。`mode` 参与创建请求的内容哈希：同 `requestId` 不同 `mode` → 409（既有的"请求编号已被不同内容使用"）。
2. **指令**：`plan` 模式下 `workspaceInstructions` 追加一段（中英均可，写清楚）：先阅读代码并给出实施方案（要改哪些文件、为什么、如何验证、风险），**在收到「方案已批准」之前不得修改任何文件**；方案写在聊天回复里，不要写入仓库。
3. **硬门（窄）**：`src/ext/planmode.mjs` 导出扩展 `Planmode`，其 `beforeTool` 在以下条件同时成立时 `block`：会话所属工作区 `mode==='plan'` 且 `planApprovedAt` 为空，且工具名是 `write` 或 `edit`。阻止文案要告诉 Bot 先给方案并等待批准。**`bash` 不拦**（无法用正则可靠分类；拦了会连探索和跑测试都做不了）。解析"会话 → 工作区"通过 `setPlanResolver(fn)`，仿照 `setExecResolver`（`fn({conversationId}) -> {mode, planApprovedAt} | undefined`）；解析不到时**放行**（不是 plan 工作区）。装配由编排者在 M2-11 做。
4. **批准**：`POST /api/workspaces/:id/plan/approve`（工作区必须 `ready` 且 `mode==='plan'`；否则 409）。写入 `planApprovedAt`，然后通过现有输入路径向该工作区的主会话提交一条「方案已批准，请开始实施」。**幂等**：重复批准返回同一结果、不重复提交消息（用 `requestId = plan-approve:<workspaceId>` 并让 Pi Durable 去重）。
5. **界面**：新建工作区对话框加"先出方案（批准后再动手改文件）"复选框，旁边说明"Bot 在你批准前不能写文件，但仍可能用 bash，这是软约束"；工作区状态里 `plan` 且未批准时显示"等待批准方案"徽标和"批准方案"按钮，批准后显示"方案已批准"；重复点击只发一次请求。
6. 不改 `src/control/*`（迁移与存取归 M2-02）。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿，`cd web && npm test && npm run typecheck` 通过（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。
- 必测：`mode` 的默认与校验；同 `requestId` 不同 `mode` → 409；`plan` 模式指令里含方案要求而 `direct` 不含；`Planmode` 在未批准时拦 `write`/`edit`、放行 `read`/`bash`；批准后放行；解析不到工作区时放行；批准接口的状态码、幂等、不重复提交消息；非 `ready` / 非 `plan` → 409；视图带 `mode`/`planApprovedAt`；前端：复选框随请求发送、徽标与按钮状态、重复点击只请求一次。
- 用真实 harness + `fauxProvider` 跑一次完整链路（参考 `test/approval.test.mjs`）：未批准时模型发起的 `write` 得到阻止文案，批准后同样的 `write` 成功。
- 不连网、不用真实 Sprite、不调用真实模型。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项。
