# M1-10：从检查点重建工作区（机器丢了之后）

依赖：M1-07（工作区服务）、M1-09（检查点）。

先读：`docs/M1-PLAN.md` §3.3、§3.5、§4.7、§8（风险：重建后不重放旧调用）；`docs/m1-probe.md`（A2：safe 恢复跳过 `beforeTool`、memo 固定首次值）；`src/workspaces.mjs`（M1-07 产出）；`src/checkpoint.mjs`（M1-09 产出）；`src/providers/sprites.mjs`（M1-03 产出）；`src/ext/exec.mjs`（M1-06 产出）。

## 你只能创建/修改
- `src/workspace-rebuild.mjs`
- `test/workspace-rebuild.test.mjs`
- 路由写在本文件导出的 `register(app)` 里（依赖 `app.ctx.rebuild`，没有注入则不注册）：`POST /api/workspaces/:id/rebuild`，body `{checkpointId}`

## 要求
1. 导出 `rebuildWorkspace({ svc, store, github, providers, cps }, { workspaceId, checkpointId, requestId? }) -> Binding`。
2. 前置：检查点属于该工作区且 `cps.verify` 通过；工作区必须有 active 绑定；**旧 runtime 不论是否还在，都不删除**（M1 不做自动释放）。
3. 流程（每步落意图 / 步骤，可接续、可重试）：
   1. 新的 requestId = `${workspaceId}:rebuild:${nextVersion}`（调用方可传 `requestId` 保证幂等）；`provider.ensure` 建新 Sprite（确定性名字，重复调用同一个）。
   2. `provider.init` + `runner.install`。
   3. clone 并检出检查点记录的 `baseCommit`（不是最新的基准分支）。
   4. `cps.apply` 恢复未提交代码。
   5. `store.bindings.bind` 写入新绑定（版本 +1，旧的 `replaced`）。
   6. 工作区状态保持 `ready`，在工作区记录里写一条 `rebuiltFrom: {checkpointId, at}`（用 `store.workspaces.update` 的现有字段，如需新字段回报，不要自行改 schema）。
4. **不重放旧调用**。PLAN 修订后（§3.3）的机制：每个 `Exec` 调用在 `execute` 第一步用 `api.memo` 把 `{runId, runtimeId, bindingVersion, cwd, commandHash}` 固定下来；重放时 `execute` 把 memo 里的绑定和 `store.bindings.current` 比较，**不一致就以「结果待确认」结束，不 prepare、不 start**。所以重建（绑定版本 +1）之后，旧绑定上遗留的未完成命令不会在新机器上被执行。**不能靠“新 runtime 上查不到这个 runId，于是 start”这条路**——`start` 本身会把 missing 变成一次新执行。本任务在测试里证明这一点：用 M1-06 的 `Exec` 加假 runner（记录所有调用），在命令执行中 SIGKILL、重建绑定、重新打开同一个 sqlite，断言新 runner 上 **prepare / start 调用次数为 0**，工具结果是「结果待确认」。若 M1-06 尚未合入，用同样语义的桩，并在汇报里写明。
5. 响应与日志不含 token、服务器绝对路径。重建失败时旧绑定保持 active，新建的半成品 Sprite 记入意图日志，且列在返回的错误详情里（只给名字，便于人工清理）。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿，假 provider + 本机 runner / 本机 git 仓库，不联网。
- 必测：成功路径（逐文件 sha256 与可执行位一致，含新增、修改、删除、二进制）；同一 `requestId` 重复调用只建 1 台；`apply` 失败时旧绑定仍 active；别人工作区的检查点被拒绝；重建后旧调用在新绑定上得到「结果待确认」而不是被重新执行（FT09 的 M1 版）。

最后输出：改动文件、测试结果、未验证项。
