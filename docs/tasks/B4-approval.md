# Batch 4 / Task 12（WP9）：审批钩子（仅后端）

先读：`docs/CONTRACTS.md`、`docs/PLAN.md` Task 12、规范 §4.10 F10 与 §7 S05、设计文档 §6.4、`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts`（`ToolHooks.beforeTool`、`HookApi.memo`）、`vendor-ref/durable-examples/17-coding-tools.ts`、`src/api.mjs`（路由插件写法）、`scripts/ask.mjs`。

## 你只能创建/修改
- `src/ext/approval.mjs`、`src/routes/approvals.mjs`
- `test/approval.test.mjs`、`scripts/approval-test.sh`
- 失败时 `docs/fail-WP9.md`
（集成到 `src/runtime.mjs` 由编排者做；测试里自己组装 harness。）

## 要求
1. `src/ext/approval.mjs` 导出：
   - `approvals`：进程内待审批中心（EventEmitter）：`request({taskId, conversationId, toolName, args, reason}) => Promise<boolean>`、`list()`、`resolve(taskId, approved)`、事件 `"changed"`。
   - `isDangerous(call) => reason | undefined`：`bash` 命令匹配危险正则（`rm -rf`/`rm -fr`、`git push`、`curl|wget ... -X (POST|PUT|DELETE)` 或 `--data`、`mkfs`、`dd of=`、`shutdown|reboot`、`> /dev/sd`），以及工具名集合（`send_*`、`deploy*`、`git_push`）；集合与正则可通过 `createApproval({ rules })` 配置。
   - `createApproval({ center = approvals, rules? })` 与默认 `Approval = defineExtension({ name: "tarsbot.approval", hooks: [hook(ToolTask, { beforeTool })] })`。
   - beforeTool：非危险 → `undefined`；危险 → `let ok = await api.memo("approval", ctx)`；若 `undefined` → `ok = await api.memo("approval", await center.request(...), ctx)`（首次写入生效，REQ-F10-2）；`ok === false` → `{ block: "User denied: <reason>" }`。
   - 注意：hook 在等待人工时可能被 abort（ctx 取消）→ 从 center 移除并抛出/返回 block。
2. `src/routes/approvals.mjs` `register(app)`：`GET /api/approvals` → 列表；`POST /api/approvals/:taskId {approved: boolean}`；`WS /api/approvals/stream` → 连接即发 `{type:"approvals", items}`，变化时再发。
3. 重启语义：进程重启后，仍未批准的工具任务会在 resume 时重新进入 beforeTool → 再次进入待审批列表（正确）；已批准的不会再问（memo）。

## 验收
- `npm test` 全绿：离线（faux 模型发出 `bash rm -rf /tmp/x`）→ 出现待审批 → approve → 工具执行；deny → 模型收到 block 结果；**TEST-F10-2**：使用 SQLite 存储，批准后在工具执行前关闭 harness（可用一个故意慢的 mock env/exec 制造窗口），重新打开 → 不再出现待审批项且工具执行完成。安全命令不触发审批。
- `scripts/approval-test.sh`：说明如何对真实 server 演示（server 需由编排者集成后才能跑），可以先写好不必运行。

最后输出：改动文件、测试结果、需要编排者在 runtime.mjs 中的集成改动、未验证项。
