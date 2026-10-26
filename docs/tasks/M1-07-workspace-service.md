# M1-07：工作区服务（创建、接续、重试）

依赖：M1-01、M1-02、M1-03、M1-04。M1-00 已完成（A3：`requestId` 去重；A6：`cwd` 透传不等于就绪）。

先读：`docs/M1-PLAN.md` §3、§3.6、§3.7、§4.6；`src/bots.mjs`（`createBot`，`cwd`、`instructions` 参数）；`src/ext/preamble.mjs`（通用 preamble 里的 clone / 建分支步骤，`workspaceInstructions` 要覆盖它们）；`src/ext/approval.mjs`（分支只能是 `tarsbot/*`）；`docs/m1-probe.md`（A3、A6）；`test/harness.test.mjs`（离线 harness 模板）。

## 你只能创建/修改
- `src/workspaces.mjs`
- `test/workspaces.test.mjs`

## 要求
1. 按 `docs/M1-PLAN.md` §4.6 实现 `createWorkspaceService`，依赖全部注入（`store`、`github`、`providers.sprites`、`bots`、`ctx`、`runnerFor(runtimeId)` 返回 runner 客户端的工厂，默认用 `createRunnerClient` 包装 `provider.bash`）。
2. `create(input)`：
   - 校验：`repo` 形如 `owner/name`、`requestId` 非空；`baseBranch` 缺省取仓库默认分支（`github.listBranches` 或 `listRepos` 里的 `defaultBranch`）。
   - `projects.upsert` → `workspaces.create`（幂等；`created:false` 时直接返回原记录，**不再启动后台**）。工作分支 `tarsbot/<slug>-<6 hex>`，`slug` 来自 `task` 或仓库名，只含 `[a-z0-9-]`，长度受限；`cwd` 为 `<home>/workspace/<repo 名>`。
   - 写入各步骤 `pending`，后台调用 `run(id)`，**不 await**，错误只落库不抛出。
3. `run(id)`：同一工作区串行（内存里的 per-id 队列即可）；从第一个不是 `done` 的步骤接续；每步先 `setStep(running)`，成功 `done`，失败 `failed`（带脱敏后的错误），API 类错误（不确定结果）为 `unknown`。步骤全 `done` 后 `status = "ready"`。
   - `runtime`：`intents.begin({kind:"sprites.create", target: provider.runtimeName(requestId)})` → `provider.ensure` → `bindings.bind`（已有 active 绑定则跳过）。`ensure` 抛「状态不确定」类错误时步骤置 `unknown`，**不要再调用 create**，等 `retry`。
   - `init`：`provider.init` + `runner.install()`。
   - `code`：`github.getBranch(repo, baseBranch)` 得 `baseCommit` 并存入工作区；在 Sprite 内（经 runner，长命令不怕断连）`git clone` —— **目录已存在且是 git 仓库就跳过，绝不覆盖**；`git fetch`、`git checkout -B <branch> <baseCommit>`；已在该分支且有本地提交时保持不动。
   - `deps`：有 `installCommand`（输入或项目默认）才执行，经 runner；没有就 `done`（标注「未配置」）。
   - `agent`：以 `store.links.conversationsOf(id)` 非空判断“已完成”，已有则跳过（**不要用“会话里已有任意消息”推断**）；否则 `bots.createBot({name, model, cwd, instructions: workspaceInstructions(ws)})`、`links.link`。不需要传 `extensions`：`Exec` 已作为全局扩展装好，所有 Bot 都用 runner 版 `bash`（PLAN §3.3）。有 `task` 则 `conv.submit({type:"input", content: task, requestId: `ws:${id}:task`}, ctx)`。探针 A3 已确认：同 `requestId` 的重复 `submit` 跨重启也只产生一条用户消息、一次 run；同编号不同内容会静默复用旧内容，但这里 `task` 是固定值，不会冲突。
4. `retry(id)`：把 `failed` / `unknown` 的步骤重置为 `pending` 并 `run`；对 `ready` 的工作区是空操作。
5. `resumePending()`：对所有 `status = "preparing"` 的工作区调用 `run`；`running` 状态的步骤（上次被打断）视为未完成重新执行——各步骤必须幂等。**调用方保证在 `harness.resume()` 之前调用它**（PLAN §3.6，由 M1-13 接线），本任务的测试要覆盖“先 resumePending 再 resume”的顺序。
6. `workspaceInstructions(ws)`：英文短文本，说明：仓库、`cwd`、工作分支、基准分支；**仓库已 clone 且已切到工作分支，不要重新 clone，也不要再建分支**（覆盖通用 preamble 的第 2、3 步）；只推送这个分支；PR 由用户在界面创建，或你在 `gh pr list --head <branch>` 确认没有后再 `gh pr create`。不含任何 token。
7. 任何地方不打印、不落库 token；错误文本经脱敏。
8. `create(input)` 在 `projects.upsert` 之前先 `store.requests.begin({scope:"workspace.create", requestId, payloadHash})`，`payloadHash` 取规范化后的 `{repo, baseBranch, task, modelId, installCommand, name}` 的 sha256；返回 `conflict` 时抛带 `code: "conflict"` 的错误（路由映射为 409），**不要静默返回旧工作区**（探针 A3：Pi Durable 对同编号不同内容会静默复用旧消息，这里在应用层挡住）。同内容则返回原工作区。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0），全部用假 provider / 假 github / 本机 runner 或假 runner / `fauxProvider` harness，不联网。
- 必测（FT-M1-1、FT-M1-3、FT-M1-4，每个时序窗口至少 10 次）：
  - 同一 `requestId` 同内容重复 `create`：只有 1 个工作区、1 次 `ensure`；**同一 `requestId` 不同内容**：抛 `conflict`，原工作区不变；
  - `runtime` 步骤中「`ensure` 已调用、绑定尚未写入」处强杀（丢弃服务实例，用同一文件库重新创建服务并 `resumePending`）：不会第二次 create，绑定到同一个 runtime；
  - `code` 步骤中强杀：重启后不重复 clone、不覆盖已有代码；
  - `ensure` 抛不确定错误（`statusCode` 5xx / 网络错）：步骤 `unknown`，**没有调用 `createSprite`**，`retry` 后继续；
  - 全流程成功：`status=ready`，有会话关联，`cwd`、`instructions` 正确传给 `createBot`，分支名以 `tarsbot/` 开头；首条任务消息只提交一次（重启后 `resumePending` 再走 `agent` 步骤，用户消息仍是 1 条）；
  - 两个工作区并行互不影响。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项。
