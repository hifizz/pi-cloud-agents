# M1-06：基于 runner 的 bash 工具（可重放、可取消）

依赖：M1-01（`store.executions`、`store.meta`、`store.bindings`）、M1-04（runner）。M1-00 已完成，结论已写入 `docs/M1-PLAN.md` §3.3、§4.5，**以修订后的 PLAN 为准**。

先读：`docs/M1-PLAN.md` §3.3、§3.6、§3.7、§4.4、§4.5、§8；`docs/m1-probe.md`（A1、A2 及“需要修改 M1-PLAN 的地方”）；`scratch/m1-probe-a.mjs`（A2 的 `replayTool`：memo 固定意图、`api.output`、`api.details` 的用法，可直接参考）；`node_modules/@earendil-works/pi-durable/dist/tools/bash.d.ts`（内置 bash 的参数与行为）、`dist/harness/types.d.ts`（`ToolExecutionApi`：`memo`、`retainedOutput`、`output`、`details`、`env`）；`src/ext/approval.mjs`（`beforeTool` 钩子；Approval 必须在扩展列表里排在本扩展之后）；`src/ext/timing.mjs`。

## 你只能创建/修改
- `src/ext/exec.mjs`
- `test/exec.test.mjs`

## 已由探针确定的事实
- 同名工具后装者生效；工具返回字段是 **`output`**（1.4.0），不是 `content`。
- `replay: "safe"` 的工具在崩溃后重入 `execute`，`callId`、`taskId` 不变；**重入时不再经过 `beforeTool`**；旧 progress 已被清空，`retainedOutput().text` 为空。
- `api.memo(name, candidate, context)`：首次写入生效，重启后读回的是第一次的值（重启后尝试写入不同值仍返回原值）。
- 同一会话里模型可以重复使用同一个 `callId`（实测 `c1` 对应 taskId 13 和 17），所以执行编号用 **taskId**，不用 `callId`。

## 要求
1. 导出扩展 `Exec`（扩展名 `tarsbot.exec`）与 `setExecResolver(fn)`、`createExec({store, runnerFor, now?})`（便于测试注入）。`fn({ conversationId }) -> { store, runner, workspace, binding } | undefined`。
2. 工具名 `bash`，参数 `command`（必填）、`timeout`（秒，可选），描述与内置 bash 对模型等价，`replay: "safe"`。
3. **解析不到工作区（`fn` 返回 undefined）时，工具以明确错误结束，不要回退到 `api.env.exec`。** 所有会话都属于工作区（项目是全新开始，没有旧共享环境），所以“解析不到”就是配置错误；回退会让重放重新执行 shell。
4. `execute` 的固定顺序，每一步都在碰远端之前完成：
   1. `ns = store.meta.get("namespace")`、`gen = store.meta.get("generation")`；`runId = runIdFor({namespace: ns, generation: gen, taskId: api.taskId})`；`hash = commandHash(command, cwd)`。
   2. `api.memo("exec", {runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash: hash}, context)`：首次执行写入，重放读回。**之后所有判断用 memo 返回的值，不用当前计算出的值。**
   3. `current = store.bindings.current(workspaceId)`；若 `current.runtimeId` / `current.version` 与 memo 不一致，或 memo 里的 `commandHash` 与重放时重算的不同 → 以「结果待确认」结束（说明原因），**不 prepare、不 start、不 kill**。
   4. `store.executions.claim(...)`；`created` 为 true 才 `runner.prepare` → `runner.start`；已存在则只 `runner.status`。`prepare` / `start` 抛“连接中断”类错误 → 「结果待确认」，**不重试**。
   5. 循环 `runner.wait({id: runId, from, maxSeconds: 25})`，**日志从偏移 0 开始**逐块 `api.output(chunk)`（重入时旧 progress 已清空，必须重新给全）。`state=exited`：非零退出码抛错（与内置 bash 一致，带输出），零退出码正常结果。`state=lost` / `claimed` / `missing` → 「结果待确认」，说明命令可能已执行，**不要自动重新启动**。
   6. 超时：到点 `runner.kill`；`unconfirmed` 时结果里写「停止待确认」，不要写「已停止」。`context.abortSignal` 中止：同样 `runner.kill`，返回前等确认结果。
5. `wait` 调用自身失败（Sprite 暂时不可达）：退避重试（最多约 60 秒），仍不行以「结果待确认」结束，命令仍在 Sprite 里运行。
6. 日志只有一路（stdout 与 stderr 合并），不要伪造 stderr。
7. 不在日志、错误、`details`、memo 里放任何环境变量的值；`details` 里只放 `runId`、`state`、`exit`、`offset`。
8. **不需要按会话选择工具**：`Exec` 装在 `CodingTools` 之后，同名覆盖内置 `bash`（探针 A1），所有 Bot 都用它。不要使用 `settings.extensions` / `extensions.add`。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。测试用 M1-04 的 runner 在本机临时目录跑，再用 `fauxProvider` + 临时 sqlite **文件**驱动真实 harness（需要重启的用例用子进程 + `SIGKILL`，参考 `scratch/m1-probe-a.mjs` 的 A2）。必测：
  - 命令正常执行、非零退出、超时被杀、中止被杀；
  - **重放**：命令运行中 SIGKILL 控制进程，重新打开同一个 sqlite 后同一个任务重入：计数文件仍为 1 行（不重复执行），最终结果包含**完整**日志（从偏移 0 重放），退出码正确；**safe 与 runner 组合 10 次**；
  - 同一会话里模型两次使用同一个 `callId`：产生两个不同的 `runId`，两条命令都各自执行一次；
  - **重建后不重放**：重放时 `store.bindings.current` 已变成新绑定（版本 +1）→ 结果是「结果待确认」，**新绑定的 runner 上没有被 prepare / start 过任何东西**（断言假 runner 的调用记录）；
  - `claimed` / `lost` / `missing` 状态都得到「结果待确认」，且没有再次 start；
  - 解析不到工作区时明确报错，**没有调用 `api.env.exec`**（用会抛错的假 env 断言）；
  - 输出、错误、memo、details 里没有注入的假 token（断言）；
  - 与 Approval 一起装（Approval 在 Exec 之后）：危险命令（`rm -rf`）仍然停在审批；
  - **覆盖内置 bash**：`[CodingTools, Exec]` 装好后，`conv.agent(ctx)` 里 `bash` 的 `replay` 是 `safe`，且模型看到的 `bash` 只有一个（描述为本扩展的）；`read` / `write` / `edit` 仍是内置的。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项。
