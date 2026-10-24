# M1 计划：工作区 + 独立 Sprite + 可恢复执行

状态：待实施｜依据：第一阶段需求 v0.1（2026-10-24，未入库）与 2026-10-25 的评估讨论。本文是 M1 的设计与接口依据；与代码冲突以代码为准并回报。任务 brief 在 `docs/tasks/M1-*.md`。

**修订记录**：
- 2026-10-25 按 M1-00 探针结果（`docs/m1-probe.md`）修订。主要变化：执行编号改为 `namespace + generation + taskId`；safe 重放在 `execute` 内核对绑定；新增 `meta`、`executions`、`requests` 记录；启动顺序要求先装解析器再恢复调度。
- 2026-10-25 按用户决定「**不需要历史兼容，也不需要保留历史数据，全部全新**」简化：删除迁移任务（原 M1-11）、`legacy-shared` 工作区、`legacyEnv` 回退，以及“只给 managed 会话用 Exec、旧 Bot 继续用内置 bash”的按会话选工具机制——所有 Bot 都是工作区 Bot，`bash` 只有 runner 版一个。

**开工前置条件**：`npm ls @earendil-works/pi-durable` 必须显示 1.4.0。本机 `node_modules` 曾是 1.0.4，与 lockfile 不符（见 `docs/m1-probe.md` §1）；先 `npm ci`，否则所有测试结论都不可信。真实模型测试只用 SWE-2、GLM 5.3、GPT-6.1-sol（GPT-6.1-sol 的网关 ID 调用前先核实）；离线确定性测试用 `fauxProvider`。

## 1. 目标与取舍

**目标**：在浏览器里完成「选仓库 → 起一个独立的云工作区 → 让 Bot 改代码、跑命令 → 创建 PR」。关网页、重启服务都不丢任务、不重复执行；工作区里未提交的代码可以存档，并在一台新机器上恢复。

用户已确认的取舍（2026-10-25）：

- 先跑通核心流程，不求每个模块完美。
- GitHub 先用现有 `GITHUB_TOKEN` + 一个薄的 `src/github.mjs`。不做 OAuth / GitHub App，不复用 thread-chatbot 的 `lib/github`（它是 Next.js + Postgres + TS，依赖与「后端纯 `.mjs`」冲突）。只借它「按 head 分支找回已创建的 PR」的思路。
- 环境只做 Sprites，每个工作区一台 Sprite。InstaBox / E2B / VPS 不在 M1。
- 检查点放服务端本地盘（线上是 Fly 卷 `/data`），只做「保存和恢复未提交代码」。
- 凭据不入库，仍用环境变量。
- **全新开始，不做历史兼容、不保留历史数据**（用户 2026-10-25 决定）：没有迁移、没有“旧共享环境”、没有对旧 Bot / 旧会话的兼容，也没有“旧 Bot 继续用内置 bash”这类保护。现有 `data/` 与 Fly 卷里的旧 Bot 没有工作区关联，M1 里不显示、不可用，但**不删除**（AGENTS.md 禁止删除 `data/`、Fly 卷和 Sprite `pi-cloud-agents`，要清理必须由用户明确指示）。
- VPS 与移动端移出第一阶段通过标准。
- AGENTS.md 红线改为「名称前缀 `pca-` + 标签 `app:pi-cloud-agents` 的 Sprite 归本应用管」（已改）。旧共享 Sprite `pi-cloud-agents` 不再被应用使用，但**红线仍禁止删除它**，清理它需要用户明确指示。
- 运行端 runner（稳定执行编号、日志、取消）不砍：关网页不丢任务、重启不重复执行都靠它。

## 2. M1 覆盖与不覆盖

| 需求 | M1 | 说明 |
|---|---|---|
| AC03.1 两个工作区独立；重复申请只生成一个 | ✅ | `requestId` 唯一键 + 确定性 Sprite 名 |
| AC03.2 初始化中重启后接续 | ✅ | 步骤落库，启动时 `resumePending()` |
| AC03.4 创建响应丢失后找回实例 | ✅ | 按确定性名字查回；API 出错时停在「待确认」可重试 |
| AC07.1 / AC07.2 长命令不因关网页、重启而丢或重跑 | ✅（有一个已知窗口） | runner + 工具 `replay: "safe"`；`prepare` 与 `start` 之间崩溃时停在「结果待确认」，不自动重启（§3.3） |
| AC07.3 取消只影响本命令进程组、停止待确认 | ✅ | 日志截断标识只做基础版 |
| AC09.2 创建 PR 后响应丢失不重复创建 | ✅ | `ensurePull`：先找再建 |
| AC11.3 PR 已创建未记录时找回 | ✅ | 同上 |
| AC12.1 / AC12.2 未提交代码存档并在新机器恢复 | ✅（部分） | 文本、二进制、删除、可执行位；暂存区划分不保留 |
| AC04.1 同工作区新开会话 | ❌ | 没有写锁前不开放，API 返回 409 |
| AC04.2 请求编号去重 | ⚠️ 部分 | 原生 `requestId` 去重已验证（含重启）；创建工作区时同编号不同内容由应用层返回 409；聊天输入路由的内容冲突检查留到 M2（需改 `api.mjs`） |
| AC05.* 写锁、人工接管、失联旧执行者 | ❌ M2 | |
| F06 真实 Git 改动面板 | ❌ M2 | M1 仍用现有「会话改动」来源 |
| F08 预览、F09 交付卡与测试证据 | ❌ M3 | M1 只有 PR 创建 |
| F10 审批绑定运行版本 | ❌ M2 | 沿用现有审批 |
| F12 自动检查点、控制数据备份、F13 生命周期 | ❌ M4 | M1 的检查点是手动触发 |
| InstaBox / E2B / VPS / 加密凭据入库 / GitHub App | ❌ M3~M5 | |

M1 吸收了原计划 M2~M4 里的 runner、PR、检查点三块。M1 完成后重新拆 M2 及以后。

**如果要继续收缩**，按这个顺序砍：M1-10（重建）→ M1-09（检查点）。主路径是 M1-00 ~ M1-08、M1-12、M1-13、M1-14。

## 3. 关键设计

1. **控制库**：新建 `<dataDir>/control.sqlite`（`node:sqlite`，与 `auth.sqlite` 同方式），不混进 pi-durable 的 `alice.sqlite`。`bots.json` 不改，会话与工作区的关联存在控制库的 `conversation_links`。
2. **按会话路由环境**：`HarnessOptions.env` 收到 `{conversationId, cwd}`（已核对 `EnvTarget`），每次使用时现建。env 工厂：查 `conversation_links` → 工作区 → 当前绑定 → 该 Sprite 的 `bash` 原语 → `SandboxEnv`。**每个会话都必须属于一个工作区**：没有关联、工作区未就绪、没有 active 绑定，一律直接抛带原因的错误（§3.7）。不再有“全局共享沙箱”这条路径。
3. **runner + 安全重放**（已按 M1-00 探针修订）：
   - **工具选择**：`Exec`（`tarsbot.exec`）提供 `replay: "safe"` 的 `bash`，装在 `CodingTools` 之后，同名覆盖（探针 A1 已验证）。因为所有会话都属于工作区、都经 runner，**不需要按会话选择工具**，也不用 `settings.extensions` / `extensions.add`。`Exec` 解析不到工作区时以明确错误结束，**不回退到 `api.env.exec`**（回退会让重放重新执行 shell）。
   - **执行编号**：`runId = sha256(namespace ":" generation ":" taskId)` 前 24 位十六进制。`namespace`、`generation` 存在控制库 `meta` 表，随控制数据备份恢复；从备份恢复到新部署时 `generation` 加一。**不能用 `conversationId + callId`**：同一会话里模型可以重复使用 `callId`（实测 `c1` 对应 taskId 13 和 17）；也不能跨独立控制库裸用 `taskId`。
   - **意图固定**：safe 恢复**跳过 `beforeTool`**（实测）。所以 `execute` 第一步写 `api.memo("exec", {runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash})`——memo 首次写入生效，重放读回原值（实测：重启后尝试写 v2 仍读到 v1）。此后每次碰远端前，把 memo 里的绑定与控制库当前 active 绑定比较，不一致就以「结果待确认」结束，**不 start**。审批 hook 里“看当前实例”不够。
   - **接回**：runner 的 `prepare` 用 `mkdir` 原子占位，同 `runId` 已占位就不覆盖、只返回状态；`start` 只在状态为 `claimed` 且还没有进程身份时启动一次。重放时日志从偏移 0 重新输出（safe 重入时旧 progress 已被清空，实测）。
   - **仍未解决的窗口**：`prepare` 之后、`start` 完成之前崩溃，会留下“已占位但没有进程身份”的目录，状态为 `claimed`，按「结果待确认」处理，不自动重启（见 §4.4）。这一窗口尚无故障测试证据，列入 M1-04 / M1-14（5c）。**所以 M1 对“恰好一次”的承诺是：已启动的命令不会被重复启动；无法确认是否启动的命令停在待确认，而不是承诺任意外部副作用恰好一次。**
   - **边界**：safe 只保证“重入 `execute`”，副作用幂等全靠 runner；任何不经 runner 的路径都不得标 safe。
4. **意图日志 + 确定性命名**：所有受管外部动作（建 Sprite、建 PR）先写 `intents` 再执行。Sprite 名 = `pca-<sha256(requestId) 前 10 位>`，建之前先按名字查，建时遇到「已存在」就当成功。PR 以「仓库 + head 分支」为天然键。超时不等于失败，先查再决定。
5. **检查点**：用临时索引 `GIT_INDEX_FILE=<tmp> git add -A` + `write-tree` 得到包含未跟踪文件的树，`commit-tree` 成检查点提交（父为当前 HEAD），`git bundle` 打包（以 `origin/<base>` 为前置），经分块 base64 取回，存 `<checkpointDir>/<workspaceId>/`。恢复时在新机器 clone → 取 bundle → 检出该树。`.gitignore` 里的文件（含 `.env`、`node_modules`）默认不进检查点。
6. **启动顺序**：`bootstrap({ resume: false })` 打开 Harness（暂不调度）→ 打开控制库、创建供应商与执行解析器（`setExecResolver`）→ `workspaces.resumePending()` → `harness.resume()`。`openHarness` 默认立即 `resume()`，若先恢复，被打断的工具会在解析器就绪前重入。
7. **工作区未就绪**：env 工厂对“会话没有工作区关联、未就绪、无绑定、供应商缺失”一律直接抛带原因的错误（探针 A4：工具得到可见的 `tool_error`，纯聊天不受影响；只让 `exec` 失败的 env 会放过文件读写，所以不用）。派发层另外保证 `preparing` / `failed` 的工作区不提交任务。`cwd` 只是透传的配置，不是就绪证明（探针 A6：内置 `write` 会替不存在的目录建出父目录）。

## 4. 模块与接口（名字与签名有约束力，需要改先回报）

### 4.1 控制库 `src/control/store.mjs`（M1-01）

```
openControlStore({ path }) -> ControlStore      // path: null = 内存库；用 PRAGMA user_version 做迁移
store.close()

store.projects.upsert({ repo, defaultBranch, installCommand?, testCommand? }) -> Project
store.projects.get(id) / getByRepo(repo) / list()

store.workspaces.create({ requestId, projectId, name, baseBranch, branch, cwd, model, task? }) -> { workspace, created }
    // 按 requestId 幂等：已存在则返回原记录，created=false
store.workspaces.get(id) / list({ includeArchived? }) / update(id, patch) / archive(id)
store.workspaces.setStep(id, step, { state, error? })      // step: runtime|init|code|deps|agent；state: pending|running|done|failed|unknown
store.workspaces.steps(id) -> [{ step, state, error, startedAt, finishedAt }]
    // Workspace = { id, requestId, projectId, repo, name, baseBranch, baseCommit|null,
    //               branch, cwd, model, task, status: "preparing"|"ready"|"failed"|"archived", error, createdAt, updatedAt }

store.bindings.bind(workspaceId, { provider, runtimeId }) -> Binding { id, version, ... }
    // 旧的 active 绑定改为 replaced；每个工作区同一时刻至多一个 active
store.bindings.current(workspaceId) -> Binding|undefined / history(workspaceId)

store.links.link({ conversationId, workspaceId, botId }) / workspaceOf(conversationId) / conversationsOf(workspaceId)

store.intents.begin({ requestId, kind, target, workspaceId? }) -> { intent, created }
store.intents.settle(requestId, { state: "confirmed"|"failed"|"unknown", evidence? })
store.intents.get(requestId) / list({ state?, kind? })       // state 初始 planned，发出后 sent

store.meta.get(key) / store.meta.ensure(key, makeValue) -> value   // 首次 ensure 写入并返回，之后读回；用于 `namespace`（随机，建库时生成）和 `generation`（整数，初始 1）

store.executions.claim({ runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash }) -> { execution, created }
    // runId 唯一；已存在则 created=false。状态：claimed → started → exited | lost | unknown
store.executions.update(runId, patch) / get(runId) / listOpen()   // listOpen = 状态不是 exited 的，供重启后核对
// Execution = { runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash, state, exit, createdAt, updatedAt }

store.requests.begin({ scope, requestId, payloadHash }) -> { created, conflict }
    // 应用层请求去重：同 (scope, requestId) 且 payloadHash 相同 → created=false；payloadHash 不同 → conflict=true（路由返回 409）。
    // Pi Durable 对同 requestId 不同内容会静默复用旧消息（探针 A3），所以工作区创建在这里先比对内容。

store.checkpoints.add({ workspaceId, bindingVersion, path, sha256, size, baseCommit, headCommit, treeHash }) -> Checkpoint
store.checkpoints.list(workspaceId) / get(id) / remove(id) / setPinned(id, pinned)
```

### 4.2 GitHub `src/github.mjs`（M1-02）

```
createGithubClient({ token = process.env.GITHUB_TOKEN, fetch = globalThis.fetch, apiBase? }) -> gh
gh.listRepos({ limit? })            -> [{ fullName, defaultBranch, private }]     // 按最近 push 排序
gh.listBranches(repo, { limit? })   -> [{ name, sha }]
gh.getBranch(repo, name)            -> { name, sha } | null
gh.findPullByHead(repo, headBranch) -> { number, url, state, merged, headRef, baseRef } | null   // state=all，优先 open
gh.createPull(repo, { head, base, title, body, draft? }) -> pull
gh.ensurePull({ repo, head, base, title, body }, { intents, requestId }) -> { pull, created }
    // intents.begin → findPullByHead → 无则 createPull → 任何超时/未知错误后再 findPullByHead 核对 → settle
class GithubError extends Error { code: "not_found"|"unauthorized"|"rate_limited"|"conflict"|"unknown", status }
```

token 不进错误信息、日志、返回值。

### 4.3 Sprites 供应商 `src/providers/sprites.mjs`（M1-03）

```
createSpritesProvider({ client, ghToken?, gitEmail?, log? }) -> provider
provider.kind = "sprites"
provider.runtimeName(requestId) -> "pca-<10 hex>"
provider.isManaged(name) -> boolean            // 前缀 pca- 且（取得标签时）带 app:pi-cloud-agents
provider.ensure({ requestId, workspaceId }) -> { runtimeId, created }
    // 先 getSprite(name)：存在 → created=false；404（statusCode）→ createSprite，409「已存在」→ 再 getSprite 并核对标签后按成功处理；
    // getSprite 报其他错误（网络、5xx、认证）→ 原样抛出，绝不去创建。创建返回成功只表示对象存在，不等于 exec 就绪（init 仍要做）。
provider.init(runtimeId)                       // gh、git 身份与凭据助手、网络策略；幂等。新实例已带 gh/node（/.sprite/bin），先探测再决定是否安装
provider.status(runtimeId) -> { state: "available"|"missing"|"unknown", raw? }   // 404 → missing；其他错误 → unknown
provider.bash(runtimeId) -> bash(command, { timeoutMs })   // 与 src/sandbox/sprites.mjs 同一原语契约，env 带 GH_TOKEN
provider.list() -> [{ runtimeId, labels }]     // 仅受管
provider.release(runtimeId)                    // 非受管一律抛错；删除 404 视为已不存在；M1 不对 UI 开放，只给测试清理用
```

SDK 错误字段是 `statusCode` 与 `errorCode`（探针 B1：重名 409、不存在 404，`errorCode` 里是消息文本），不是 `status` / `code`。

### 4.4 runner（M1-04）

运行端脚本 `src/runner/runner.sh`（POSIX sh），装在 Sprite 的 `~/.pca/`；客户端 `src/runner/client.mjs`。

```
runner.sh prepare <id> --cwd <dir> --cmd-file <path> [--env-file <path>]   # 原子占位：mkdir ~/.pca/runs/<id>，失败（已存在）→ 输出当前状态，不覆盖
runner.sh start   <id>                                                      # 占位后启动；只在状态为 claimed 且无进程身份时执行一次
runner.sh wait    <id> --from <byteOffset> --max <seconds>                  # 有新输出、结束或超时就返回
runner.sh status  <id>
runner.sh kill    <id> [--grace <seconds>]                                  # 先校验进程身份，再杀进程组
runner.sh version
```

命令正文与环境变量**不走 argv**：客户端先把它们分块（每块 12 KiB 原始数据）base64 写入 `~/.pca/stage/<id>/`，核对 sha256 后原子 `mv` 到位，再调用 `prepare` / `start`。原因（探针 B4）：Sprite 的 exec 把 argv 放在 WebSocket URL 里，最坏数据下 20 KiB 原始数据编码后已是 82,099 字符（上限 64,000）；环境变量值（含 token）不得写进磁盘上的 `cmd` / `meta`，只在包装进程里从 exec 环境读取。

返回为 `key=value` 行；`wait` 在 `--data--` 行之后带原始日志字节。`state` 取值：`claimed`（已占位，尚未有进程身份）/ `running` / `exited`（带 `exit=<n>`）/ `lost`（进程已不在但没有退出码）/ `missing`（目录不存在）。**`claimed`、`lost`、`missing` 都不得自动重新启动**，一律以「结果待确认」交给上层。`kill` 返回 `killed=confirmed|unconfirmed|not-found`。进程身份 = `/proc/sys/kernel/random/boot_id` + `/proc/<pid>/stat` 第 22 字段（起始时间），探针 B3 实测同一进程两次读取稳定；只支持 Linux + `setsid`（B2 实测新 Sprite 具备）。日志 stdout 与 stderr 合并为一个文件。

```
// src/runner/client.mjs
createRunnerClient({ bash, runnerPath? }) -> { install(), prepare({id, cwd, command, env?}), start(id), wait({id, from, maxSeconds}), status(id), kill(id) }
runIdFor({ namespace, generation, taskId }) -> string      // sha256(`${namespace}:${generation}:${taskId}`) 前 24 位十六进制，纯函数
commandHash(command, cwd) -> string                         // sha256，用于重放时核对“还是同一条命令”
```

**“恰好一次”的边界**：`prepare` 用 `mkdir` 保证同一 `runId` 只占位一次；占位后、`start` 之前崩溃会留下 `claimed`，此时不知道有没有进程，所以只报告、不重启。探针没有覆盖这个窗口，M1-04 的故障测试和 M1-14 要专门打它。

### 4.5 执行工具 `src/ext/exec.mjs`（M1-06）与环境路由 `src/workspace-env.mjs`（M1-05）

```
// 扩展名 tarsbot.exec：提供 bash 工具，参数 command / timeout，replay: "safe"。所有会话共用（见 §3.3）
export const Exec
export function setExecResolver(fn)   // fn({ conversationId }) -> { store, runner, workspace, binding } | undefined
    // 解析不到（会话没有工作区关联）时，工具以明确错误结束，**不回退到 api.env.exec**：回退会让重放重新执行 shell

// execute 内的固定顺序（每步都在碰远端之前）：
//   1. memo("exec") 固定 {runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash}（首次写入生效）
//   2. 与 store.bindings.current(workspaceId) 比较 runtimeId / version；不一致 → 「结果待确认」，不 prepare / start
//   3. store.executions.claim → runner.prepare → runner.start（已占位则只 status）
//   4. runner.wait 循环，日志从偏移 0 给 api.output；state=lost/claimed/missing → 「结果待确认」
//   5. 超时 / abort → runner.kill；unconfirmed 时写「停止待确认」，不写「已停止」

export function createWorkspaceEnv({ store, providers }) -> ({ conversationId, cwd }) => ExecutionEnv
    // 未就绪（无会话关联 / preparing / failed / 无 active 绑定 / 供应商缺失）直接抛带原因的错误，不回退共享沙箱（§3.7）
```

### 4.6 工作区服务 `src/workspaces.mjs`（M1-07）

```
createWorkspaceService({ store, github, providers, bots, ctx, now? }) -> svc
svc.create({ requestId, repo, baseBranch?, task?, modelId?, installCommand?, name? }) -> Workspace   // 落库后返回，后台开跑，不等待
    // 先 store.requests.begin({scope:"workspace.create", requestId, payloadHash})：同编号不同内容 → 抛 conflict（路由 409）；同内容 → 返回原工作区
svc.run(id) -> Promise<Workspace>            // 幂等；从第一个未完成步骤接续；同一工作区串行
svc.retry(id) -> Workspace
svc.resumePending() -> Promise<void>         // 启动时调用：所有 status=preparing 的继续；必须在 harness.resume() 之前（§3.6）
svc.get(id) / svc.list()
workspaceInstructions(ws) -> string          // 写入 Bot 的 instructions，覆盖通用 preamble 的 clone / 建分支步骤
```

步骤顺序：`runtime`（建或找回 Sprite 并绑定）→ `init`（供应商初始化 + 安装 runner）→ `code`（解析基准提交、clone、建工作分支）→ `deps`（可选安装命令，经 runner）→ `agent`（建 Bot、关联会话、有 task 则以 `ws:<id>:task` 为 requestId 提交）。工作分支名 `tarsbot/<slug>-<6 hex>`，满足现有审批规则。`agent` 步骤是否已完成，以 `store.links` 里有无该工作区的会话为准，不靠“会话里已有任意消息”推断。

### 4.7 检查点 `src/checkpoint.mjs`（M1-09）、重建 `src/workspace-rebuild.mjs`（M1-10）

```
createCheckpointService({ store, dir, now? }) -> cps
cps.save({ workspace, bash }) -> Checkpoint        // bash 是目标 Sprite 的原语
cps.apply({ checkpoint, bash, cwd })               // 把检查点内容放到 cwd（仓库已 clone 到基准提交）
cps.list(workspaceId) / cps.verify(checkpoint)     // 校验 sha256
rebuildWorkspace({ svc, store, github, providers, cps }, { workspaceId, checkpointId }) -> Binding   // 新 Sprite，绑定版本 +1
```

### 4.8 API（M1-08 / M1-09 / M1-10 / M1-12 共用）

| 方法与路径 | 说明 |
|---|---|
| `GET /api/github/repos` | `[{fullName, defaultBranch, private}]` |
| `GET /api/github/branches?repo=owner/name` | `[{name, sha}]` |
| `POST /api/workspaces` | body `{requestId, repo, baseBranch?, task?, modelId?, installCommand?, name?}`；202 + Workspace，同 `requestId` 返回同一个 |
| `GET /api/workspaces` / `GET /api/workspaces/:id` | Workspace + `steps` + `botId` + 当前绑定摘要 |
| `POST /api/workspaces/:id/retry` | 重试失败或待确认的步骤 |
| `POST /api/workspaces/:id/pr` | body `{requestId, title?, body?, base?}` → `{pull, created}` |
| `POST /api/workspaces/:id/checkpoint` | 保存检查点 → manifest |
| `GET /api/workspaces/:id/checkpoints` | manifest 列表 |
| `POST /api/workspaces/:id/rebuild` | body `{checkpointId}` → 新绑定 |

错误统一 `{error: string}`。所有路由经现有鉴权守卫；响应与日志不含任何 token。`POST /api/workspaces` 之外不新增会创建会话的入口。

## 5. 文件所有权

并行 worker 只改自己列出的文件，不 `git commit`。共享文件由编排者在 M1-13 集成。

| 任务 | 可创建/修改 |
|---|---|
| M1-00 | `scratch/m1-probe-*.mjs`、`docs/m1-probe.md` |
| M1-01 | `src/control/*.mjs`、`test/control-store.test.mjs` |
| M1-02 | `src/github.mjs`、`test/github.test.mjs` |
| M1-03 | `src/providers/sprites.mjs`、`src/providers/sprites-init.mjs`、`test/providers-sprites.test.mjs` |
| M1-04 | `src/runner/*`、`test/runner.test.mjs` |
| M1-05 | `src/workspace-env.mjs`、`test/workspace-env.test.mjs` |
| M1-06 | `src/ext/exec.mjs`、`test/exec.test.mjs` |
| M1-07 | `src/workspaces.mjs`、`test/workspaces.test.mjs` |
| M1-08 | `src/routes/workspaces.mjs`、`src/routes/github.mjs`、`test/routes-workspaces.test.mjs` |
| M1-09 | `src/checkpoint.mjs`、`src/routes/checkpoints.mjs`、`test/checkpoint.test.mjs` |
| M1-10 | `src/workspace-rebuild.mjs`、`test/workspace-rebuild.test.mjs` |
| M1-12 | `web/src/` 下与新建工作区、工作区状态相关的文件（见任务文件） |
| M1-13（编排者） | `src/runtime.mjs`、`src/server.mjs`、`src/config.mjs`、`src/ext/preamble.mjs`、`docs/CONTRACTS.md`、`README.md` |

`package.json` 不改：只用 `node:sqlite`、`fetch` 与现有依赖。

## 6. 依赖与波次

```
波 A（互相独立，可并行）：M1-00  M1-01  M1-02  M1-03  M1-09  M1-12
波 B：M1-04（要 M1-00 B 部分）  M1-05（要 01、03）
波 C：M1-06（要 04、M1-00 A 部分）  M1-07（要 01、02、03、04）
波 D：M1-08（要 07）  M1-10（要 07、09）
波 E：M1-13 集成（编排者）→ M1-14 验收（编排者，EGO 浏览器）
```

M1-09 只依赖「一个 bash 原语」，用本地临时 git 仓库就能测，所以放在波 A。M1-12 按 §4.8 的 API 约定用假数据先做，联调在 M1-13 之后。

## 7. M1 验收

自动化：`TARSBOT_NO_DOTENV=1 npm test` 全绿；`cd web && npm test && npm run typecheck` 通过。

**确定性故障测试**（离线，假客户端 / 假 fetch，每个时序窗口至少重复 10 次，全部通过）：

- FT-M1-1：建 Sprite 的请求已发出、响应前强杀，重启后找回同一名字，假客户端的 create 调用累计 1 次。
- FT-M1-2：`ensurePull` 在「POST 已生效但响应丢失」与「POST 之前」两个窗口强杀后重试，只有 1 个 PR。
- FT-M1-3：`POST /api/workspaces` 用同一 `requestId` 重复提交，只有 1 个工作区、1 次建 Sprite。
- FT-M1-4：初始化在 `code` 步骤中被杀，重启后接续，不重复 clone。

**真实 Sprite 验收**（只用测试仓库 `hifizz/tars-sandbox-playground`，只建 `pca-` 前缀的 Sprite，结束清理）：

1. 两个工作区并行，各自改同名文件，互不影响（AC03.1）。
2. 让 Bot 跑一个 90 秒、每 5 秒写一行日志的命令，中途 `kill -9` 服务并重启：命令计数文件仍为 1，最终拿到退出码和日志（FT03 / FT04 的 M1 版，至少 3 次）。
3. 创建 PR，继续改，再次创建：PR 编号不变（AC09.2）。
4. 保存检查点（含修改、新增文本、新增二进制、删除各一个文件）→ 删除该测试 Sprite → 重建 → 文件校验值与清单一致。

EGO 浏览器验收按 AGENTS.md「验收」一节，由编排者在合入后统一做；并行 worker 不做浏览器验收。

## 8. 风险与探针结论

M1-00 已于 2026-10-25 完成（`docs/m1-probe.md`，A 部分在 1.4.0 隔离目录 195/195 断言通过，B 部分真实 Sprites，3 台测试实例已全部删除）。

| 原风险 | 结论 | 对设计的影响 |
|---|---|---|
| 自定义 `bash` 能否覆盖 `CodingTools` 的 | 能，后装者生效（A1） | 采用；所有会话共用 `Exec`，不需要按会话选择 |
| `replay: "safe"` 恢复时是否再调用 `execute`；`callId` 是否不变 | 是，10/10；`callId`、`taskId` 不变（A2） | 采用；但 safe 重入会**跳过 `beforeTool`**，且旧 progress 被清空 |
| `callId` 能否做执行编号 | **不能**：同一会话里 `callId` 可重复（`c1` → taskId 13、17） | 改用 `namespace + generation + taskId`（§3.3、§4.4） |
| `submit` 的 `requestId` 是否去重 | 是，跨重启有效；**同编号不同内容会静默复用旧消息**（A3） | 工作区创建走 `store.requests`，冲突返回 409；聊天输入路由的检查留到 M2 |
| env 工厂未就绪时抛错 | 工具得到可见 `tool_error`，纯聊天不受影响；只封 `exec` 的 env 会放过文件读写（A4） | 工厂直接抛错（§3.7） |
| `node:sqlite` 的 `backup()` | 有；并发写入下 5/5 一致（A5） | M4 备份可用；跨文件一致性仍需方案 |
| `cwd` 不存在时的表现 | 原样透传；内置 `write` 会替不存在的目录建父目录（A6） | `cwd` 不是就绪证明，需显式 readiness 检查 |
| Sprite 有 `setsid` / `/proc` / `flock` / `base64` / `sha256sum` | 都有（B2） | runner 只支持 Linux + setsid |
| 后台进程能否脱离 exec 存活、整组取消 | 能；进程身份稳定；TERM 进程组后组内无进程（B3） | 采用；不覆盖自行 daemonize 逃出进程组的子进程 |
| 创建耗时、重名与不存在的错误形态 | 约 0.5 秒；重名 409、不存在 404（均为 `statusCode`）；删除不存在也是 404（B1） | `provider.ensure` / `release` 按此判断（§4.3） |
| exec 传大数据 | 12 KiB 原始数据分块可靠；20 KiB 起最坏编码超过 64,000 的 URL 上限（B4 与补充） | 命令正文分块写入后再启动，不走 argv（§4.4） |
| 3 台并发 | 创建与独立执行正常（B5）；未测第 4 台和配额耗尽 | 验收期间仍限制 ≤ 3 台 |
| 新 Sprite 网络策略 | 默认不限制；现有 allowlist 可应用且可恢复（B6） | 沿用 `sprite-setup` 的策略 |

仍然存在的风险：

| 风险 | 影响 | 处理 |
|---|---|---|
| `prepare` 后、`start` 前崩溃（`claimed` 状态）：不知道进程有没有起来 | 可能少执行或需要人工判断 | 一律「结果待确认」，不自动重启；M1-04 故障测试与 M1-14 专门覆盖，尚无证据 |
| 重建后旧绑定的未完成命令 | 若 `execute` 只靠“查 runner 得 missing 就 start”，会在新机器上重跑 | `execute` 先核对 memo 里的绑定与当前绑定，不一致不 start（§3.3）；M1-10 要有测试 |
| 启动顺序：`openHarness` 默认立即 `resume()` | 被打断的工具在解析器就绪前重入 | `resume: false` 后手动恢复（§3.6）；M1-13 用测试覆盖 |
| 没有写锁：同一工作区被两个会话同时写 | 文件互相覆盖 | M1 不开放同工作区新会话，写锁在 M2 |
| `fork`（`POST /api/bots/:id/fork`）产生的新会话没有工作区关联 | env 工厂会抛错；若允许写入型 fork，又会在同一工作区产生两个写入者 | **提议（待用户确认）**：M1 只允许 `readOnly` fork，并继承父会话的工作区关联；写入型 fork 返回 409，等 M2 写锁 |
| 日志 stdout / stderr 合并 | 工具结果里区分不了两路 | 已知偏差，记在 M1-04 |
| 本机 `node_modules` 曾是 1.0.4 | 所有本地测试结论失真 | 开工前 `npm ci`；`npm ls` 校验版本（页首） |
