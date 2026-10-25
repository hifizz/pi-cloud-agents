# M2-07：审批绑定运行版本

依赖：M2-03（两者都改 `src/ext/exec.mjs`，**必须在 M2-03 合入之后**才开始）。

先读：`docs/M2-PLAN.md` §3.3；`src/ext/approval.mjs`（`ApprovalCenter`、进程内 `#pending`、`beforeTool`、裁决写在任务 memo `"approval"` 里、首次写入生效）；`src/routes/approvals.mjs`（`POST /api/approvals/:taskId`）；`src/ext/exec.mjs`（意图 memo 与绑定核对；M2-03 加了 `lockEpoch`）；`docs/m1-probe.md` 的 A2（**安全重放会跳过 `beforeTool`**，所以绑定核对必须同时在 `execute` 里做）；`src/ext/exec.mjs` 的 `setExecResolver`（审批的解析器仿照它）；`test/approval.test.mjs`、`test/exec.test.mjs`。

## 真实缺口（调研）
审批通过之后，Exec 才固定绑定。如果审批等待期间发生重建（绑定 v1 → v2），批准后命令会在**新** Sprite 上执行——用户批准的是旧环境上的操作。

## 你只能创建/修改
- `src/ext/approval.mjs`、`src/routes/approvals.mjs`
- `src/ext/exec.mjs`（**仅** `approval.binding` 的读取与比较）
- `test/approval.test.mjs`、`test/exec.test.mjs`（仅新增用例）
- `web/src/components/ApprovalBar.tsx`、`web/src/lib/approvals.ts`、`web/src/hooks/useApprovals.ts`、`web/src/components/Chat/tools/ToolCall.tsx`（仅审批状态展示处）、`web/src/types.ts`（只追加）与对应测试（`web/test/` 下现有的审批相关测试文件，或新增 `web/test/approval-binding.test.tsx`）

**共享文件规则**见 `docs/M2-PLAN.md` §8.1（精确小编辑，只在自己负责的区域改，发现冲突写进汇报）。

## 要求
1. **解析器**：导出 `setApprovalResolver(fn)`，`fn({ conversationId }) -> { workspaceId, runtimeId, version } | undefined`（当前绑定的快照）。没有设置或解析不到时：**行为与 M1 完全一致**（不绑定、不核对）；已有的审批用例必须保持通过。装配由编排者在 M2-11 做。
2. **请求时固定**：`beforeTool` 在请求审批前把 `{ workspaceId, runtimeId, version }` 通过 memo 写入 `"approval.binding"`（首次写入生效，重放读回原值），并放进待审批项（供界面显示"针对环境 v1"）。
3. **裁决后核对**：得到裁决（以及重入读到已有裁决）后，用解析器取当前绑定，与 memo 里的比较；不一致 → 返回 `{ block: "运行环境已变更（审批时为 v1，现为 v2），审批作废，请重新发起" }`。批准变成作废；拒绝仍是拒绝。
4. **`exec.mjs` 中同样核对**（因为安全重放不经过 `beforeTool`）：固定自己的意图之前，若 memo 里有 `"approval.binding"`，把它与候选意图的 `{ runtimeId, bindingVersion }` 比较，不一致 → 「结果待确认」，**不 prepare、不 start**。读取用只读 memo 查询，不能写入。
5. **路由**：`POST /api/approvals/:taskId` 可选带 `bindingVersion`；与待审批项里记录的不一致 → 409 "审批针对的环境已变更"。不带则行为不变。待审批项列表（`GET`）里带 `workspaceId`、`bindingVersion`。
6. **重建时作废**：导出 `voidApprovalsForWorkspace(workspaceId)`，把该工作区内存里的待审批项标为作废并通知等待者（裁决视为拒绝，原因"运行环境已变更"）。调用点（重建完成后）由编排者在 M2-11 接线。
7. 界面：待审批项显示针对的环境版本；作废的项显示"已作废"而不是消失。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿，`cd web && npm test && npm run typecheck` 通过（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。
- **FT-M2-2（≥10 次）**：审批等待期间重建（绑定 +1）→ 批准 → 命令**不执行**，结果为审批作废；假 runner 的调用记录里没有 prepare/start；另一路：批准发生在重建**之前**、`execute` 在重建之后才开始（安全重放）→ `exec.mjs` 的核对使其成为「结果待确认」。
- 必测：未设置解析器时 M1 行为不变；绑定未变时正常批准并执行；`beforeTool` 在重入时读回原来的 `approval.binding`；`bindingVersion` 不一致的 409；`voidApprovalsForWorkspace`；危险命令（`rm -rf`）仍然停在审批（与 Exec 一起装，Approval 在最后）。
- 不连网、不用真实 Sprite、不调用真实模型。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项。
