# M2 计划：写锁与接管、真实 Git 改动、审批绑定、先出方案，以及 M1 遗留的加固

状态：待实施｜依据：M1 完成情况（PR #4，`docs/acceptance/M1/README.md`）、代码审查遗留项、2026-10-25 对代码的只读调研。本文是 M2 的设计与任务依据；与代码冲突以代码为准并回报。任务 brief 在 `docs/tasks/M2-*.md`。

**开工前置条件**：PR #4（`feat/m1-workspaces`）已合入 `main`，在其上建分支；`npm ci` 后 `npm ls @earendil-works/pi-durable` 必须是 1.4.0。

## 1. 目标与取舍

**目标**：让「多个人/多个会话围着同一个工作区」安全起来，并把 M1 留下的两处用户可见缺口补上。

- 同一工作区可以有多个会话，但**同一时刻只有一个写入者**（写锁）；人可以接管，被接管的旧执行者不能再写（围栏）。
- 改动面板显示**真实的 git 改动**（含 bash 造成的、未跟踪的、删除的、二进制的），不再只看编辑工具的记录。
- 审批绑定到运行环境版本：重建后，重建前发出的审批不能在新环境里生效。
- 「先出方案」：Bot 先产出方案并等你批准，再开始写。
- 聊天输入的 `requestId` 同编号不同内容返回 409（M1 只在创建工作区时做了）。
- 补上 M1 的两个遗留：中止后看不到「已停止 / 停止待确认」；新 Sprite 上偶发的「结果待确认」。

**不在 M2**（保持 M1 §2 的划分）：预览与交付卡（M3）、自动检查点/控制库备份/生命周期（M4）、InstaBox/E2B/VPS/GitHub App/加密凭据（M3~M5）。其中 InstaBox 的接入方式在 §7 说明，但不排进 M2 的必做项。

用户在 M1 已确认、M2 继续有效的约束：全新开始、不做历史兼容；真实模型只用 SWE-2 / GLM 5.3 / GPT-6.1-sol；全程由编排者用子代理推进，验收时才找用户；不合并到 `main`、不开自动合并。

## 2. 覆盖表

| 需求 | M2 | 任务 |
|---|---|---|
| AC04.1 同工作区新开会话 | ✅ | M2-02、M2-03、M2-04 |
| AC04.2 请求编号去重（聊天输入） | ✅ | M2-09 |
| AC05.* 写锁、人工接管、失联旧执行者 | ✅（不含终端） | M2-02 ~ M2-04 |
| F06 真实 Git 改动面板 | ✅ | M2-05、M2-06 |
| F10 审批绑定运行版本 | ✅ | M2-07 |
| 「先出方案」 | ✅ | M2-08 |
| 中止结果显示「已停止 / 停止待确认」 | ✅ | M2-10 |
| 新 Sprite 就绪探测与瞬时「结果待确认」 | ✅ | M2-01 |
| 在 Sprite 里开终端（人工接管的完整形态） | ❌ 留 M3 | 见 §6 |
| 释放 / 配额 / 孤儿回收 | ❌ 留 M4 | 见 §6 |
| 预览、交付卡、自动检查点、InstaBox 等 | ❌ M3 以后 | |

## 3. 设计

### 3.1 写锁与围栏（M2-02 ~ M2-04）

**写入点**（调研结果，需要被门控的）：

- 提交工作：`POST /api/bots/:id/input`（`src/api.mjs`）、首条任务 `dispatchTask`（`src/workspaces.mjs`）、例程的 `Tick`（`src/ext/routines.mjs`）。
- 写 Sprite：Exec 的 `prepare/start`（`src/ext/exec.mjs`）、内置 `write`/`edit`（经 `src/workspace-env.mjs`）、服务端的 `runCommand`（code/deps 步骤）、重建的 `bind` 与检查点 `apply`。
- 不需要门控：`read`、`web_search`、`search_history`、`abort`/`compact`/`reset`（只改会话，不改 Sprite）。

**状态**（控制库迁移 v2）：`workspace_locks(workspace_id PRIMARY KEY, holder_kind 'conversation'|'user', holder_id, epoch INTEGER NOT NULL, acquired_at)`。**释放时保留行**（`holder_id` 置空），这样 `epoch` 只增不减。`store.locks.acquire / release / current`。

**围栏**：锁的凭证是 `epoch`。

- Exec 把 `lockEpoch` 放进 memo 固定的意图里，与现有的绑定核对放在同一处；在 `wait` 循环里也复查，发现 epoch 已变就以「结果待确认（已被接管）」结束，并请求 `runner.kill`（见下）。
- env 工厂返回的 `SandboxEnv` 的 `bash` 原语要包一层：每次远端调用前核对「本会话是否仍持有锁或锁空闲」，否则抛带原因的错误。**这一层是权威**；`beforeTool` 只是用户友好的提前拒绝，因为**安全重放会跳过 `beforeTool`**（`docs/m1-probe.md` A2），而且管不到已在途的调用。
- 接管必须同时 `conv.abort`，否则进行中的命令不会被杀（杀进程只发生在用户中止这条路上）。
- 服务端写入者（`runCommand`、重建、检查点 apply）不持有「会话锁」，而是持有 `holder_kind='user'` 的短时系统锁，或在执行前断言锁空闲；具体由 M2-03 在代码里选定并写进汇报。

**读者与写者**：没有锁时任何会话都可以读；`write`/`edit`/`bash` 需要持有锁。**第一个真正写入的会话自动获得锁**——取锁发生在 Exec 的 `execute` 与 env 的写类调用里（它们是首次写入的必经之处，都拿得到 `store`），所以 `src/api.mjs` 不需要改；其他会话的写入被围栏拒绝，错误指向「可接管」。注意是写入时取锁，不是提交消息时：只读的会话从不占锁。

**人工接管（M2 范围）**：用户在界面点「接管」→ 服务端 `epoch+1`、`holder=user`、对原持有者 `conv.abort`、暂停该工作区的例程提交（见下）。用户可以：自己给工作区发消息（以 `user` 身份）、点「交还」释放锁。**不含终端**：Sprites 的 TTY 能否经现有非 TTY 的 `provider.bash` 使用，调研没有验证；终端留 M3，先做 spike（M2-12 的一项）。

**例程**：`Tick` 重新提交会绕过接管，所以接管期间对该工作区的例程提交要么被跳过，要么按 `followUp` 排队但不执行写；M2-04 选一种并测试。

**fork**：锁存在之后，`src/routes/fork.mjs` 对「非只读 fork」的 409 可以放开：新会话关联到同一工作区，但**没有锁**，首次写时按上面的规则竞争。M2-04 同时改 `mapBotsToWorkspaces`（`web/src/lib/workspaces.ts`）和 `view()` 的 `botId`（目前只取 `links[0]`），让多会话在界面和接口里都能表达。

### 3.2 真实 Git 改动面板（M2-05、M2-06）

现状（调研）：右栏「Changes」数据来自对话里 `edit`/`write` 工具的结果（`web/src/panels/diff/source.ts`），bash 的改动、未跟踪/删除/重命名/二进制都看不到，`write` 被当成全量新增。

**后端** `src/routes/changes.mjs`（取 bash 的方式同 `src/routes/checkpoints.mjs`：`app.ctx.runtimeBash(workspaceId)`）：

- `GET /api/workspaces/:id/changes`：返回 `{baseCommit, head, branch, truncated, files:[{path, oldPath?, status:'M|A|D|R', binary, add, del}], totals}`。
- `GET /api/workspaces/:id/changes/patch?path=`：单个文件的 unified diff，限长，超出标 `truncated`。
- 取树的方式沿用检查点的临时索引：**复制真实索引**到临时位置后 `git add -A`、`write-tree`，再 `git diff -M --numstat -z <base> <tree>`，用完删临时目录。不碰真实索引，不锁仓库。命令里的路径一律 `shellQuote`。
- 上限：最多 200 个文件、单个 patch 40 KB、单次 exec 的 argv 不超过 Sprites 的 URL 限制、输出分块读（沿用 12 KiB 经验）；超时 30 秒返回 504，连接失败 503；整个 GET 是只读的，可以安全重试。
- 服务端对同一工作区做 singleflight，并缓存 2~3 秒（每次 exec 约 0.9~1 秒，且会唤醒休眠的 Sprite）。

**前端**：新增 `gitSource`（实现现有 `DiffSource` 接口），把 unified diff 适配成 `DiffLine[]`（`@@` → `gap` 行），**复用 `DiffFileCard`**；`ChangedFile` 增加可选的 `status`、`binary`、`oldPath` 以显示徽标。刷新时机：打开面板/切到该标签、bash/edit/write 工具变为 `done`（防抖约 1.5 秒）、会话由忙变闲、手动按钮；**空闲时不轮询**。

### 3.3 审批绑定运行版本（M2-07）

现状（调研）：待审批项只存在进程内存里（`ApprovalCenter.#pending`），裁决写在任务 memo 的 `"approval"` 里；没有任何工作区/绑定信息。**真实缺口**：审批等待期间发生重建，批准后命令会在新 Sprite 上执行（Exec 在批准之后才固定绑定）。

改法（最小）：

1. 审批需要能解析「会话 → 工作区 → 当前绑定」，仿照 `setExecResolver` 提供 `setApprovalResolver`，由 `src/server.mjs` 装配。
2. `beforeTool` 在请求审批前把 `{workspaceId, runtimeId, version}` 写进 memo `"approval.binding"`（首次写入生效），并放进待审批项供界面显示。
3. 裁决之后以及重入时，再核对当前绑定；不一致返回 `{block: "运行环境已变更，审批作废"}`。
4. `exec.mjs` 在固定意图前读取 `approval.binding`（若存在）并与候选意图比较，不一致走「结果待确认」。**这一步必须在 `execute` 里**，因为安全重放不经过 `beforeTool`。
5. `POST /api/approvals/:taskId` 可带 `bindingVersion`，过期返回 409；重建完成时丢弃该工作区的待审批项。

### 3.4 先出方案（M2-08）

采用一种：**工作区级 `mode` + 指令 + 窄的硬门**。

- 创建工作区时可勾选「先出方案」；控制库迁移里给 `workspaces` 加 `mode`（`'direct'|'plan'`）与 `plan_approved_at`。
- `workspaceInstructions` 在 `plan` 模式下要求 Bot：先读代码、产出方案（不修改任何文件）后停下。
- 硬门：新扩展 `src/ext/planmode.mjs` 的 `beforeTool` 在未批准前拦截**名字可靠的写工具**（`write`、`edit`）。`bash` 不拦：它无法用正则可靠分类，拦了会连探索和跑测试都做不了；这是已知的软约束，写进界面说明。
- `POST /api/workspaces/:id/plan/approve` 置 `plan_approved_at`，并以输入路径提交一条「方案已批准，开始实施」。
- 不采用只读工具集（`READ_ONLY_TOOLS` 没有 bash，连 `git status`、grep、测试都跑不了）和审批中心（方案更适合作为一轮聊天来批准）。

### 3.5 聊天输入的请求内容冲突（M2-09）

现状：同一 `requestId` 不同内容会被 Pi Durable 静默复用旧消息（`docs/m1-probe.md` A3）；前端目前**根本没有发送 `requestId`**（`App.tsx` 的 `sendInput`）。

- `src/api.mjs` 的 `POST /api/bots/:id/input` 在 `conv.submit` 之前调用 `control.requests.begin({ scope: 'bot.input:<conversationId>', requestId, payloadHash: sha256(text + whenBusy) })`，`conflict` 时返回 409「requestId 已用于不同内容」（文案要与现有的「bot is busy」409 区分）。路由插件拦不到内置路由（内置先注册、`matchRoute` 取第一个），所以这里是一处**经批准的对 `api.mjs` 的小改动**。
- 前端开始为每次发送生成 `requestId`（失败重试复用同一个）。
- `requests` 表没有清理：同时加一个按时间的清理（保留 7 天），避免无限增长。
- 进程在 `begin` 与 `submit` 之间死亡时，同内容重试仍会提交（`begin` 不覆盖旧记录）。

### 3.6 中止结果文案（M2-10）

调研结论：**工具内部无法做到**。中止标记在信号触发前就提交了，之后来自「运行」模式的提交会被拒绝（`#gated` 抛 "has a durable abort mark"），所以中止前的 `api.output` / `details` 写不进去；中止结果由 `ToolTask.abort` 用已提交的内容生成通用文本。

采用**事后推导**：

- `exec.mjs` 在 `handleAbort` 里已经把结果写进控制库（`executions.state` / `exit.killed`，这是控制库写入，不受 Harness 门控）。
- 新路由 `GET /api/executions?runIds=…`（只读）按 `details.runId` 返回每个执行的停止状态：`stopped | stop_unconfirmed | exited | unknown`。
- 前端 reducer（目前把 `aborted` 映射成 interrupted）在工具部分带 `runId` 且状态为已中止时，显示「已停止」或「停止待确认」。
- 可选加固：`beforeRequest` 钩子改写给模型看的文本（仅模型视图，不改记录），让 Bot 知道「已停止」而不是笼统的 aborted。作为 M2-10 的第二步，单独测试。

### 3.7 新 Sprite 就绪探测与瞬时「结果待确认」（M2-01）

M1 验收里，新建/重建的 Sprite 上前两次 `bash` 先后得到「结果待确认」：一次 `prepare` 时 WebSocket 连不上，一次 `wait` 读到 `missing`。**根因没有证据**，所以 M2-01 先取证再改：

1. **取证（不改行为）**：用 `TARSBOT_SPRITES_LOG` 打开已有的 exec 日志；在 `provider.ensure` 之后循环 `exec true`（0.5 秒间隔），记录首次成功的耗时与之前失败的次数；记录 `start` 的 `started/reason` 返回值与 `prepare` 之后立即 `status` 的结果。最多用 1~3 台 Sprite（见 §5 的上限）。
2. **加固（调研已给出的几项）**：`ensure` 为新建时、重建时，在使用前加 `waitReady`（`exec true`，退避到约 30 秒）；预开连接失败的重试从 1 次改为 3 次带退避；`exec.mjs` 检查 `start` 的返回值（`started=no reason=missing` 当前被忽略）；`isDefiniteFailure` 把「连接建立前失败、命令必然未执行」的 `SPRITES_CONNECT_FAILED` 视为确定性失败而不是「结果待确认」。
3. 判据：新建/重建后连续 20 次 `bash` 调用没有任何一次出现「结果待确认」（真实 Sprite，≤3 台）。

## 4. 控制库迁移

M1 的迁移机制是 `PRAGMA user_version` + `MIGRATIONS` 数组（`src/control/db.mjs`）。M2 增加 **v2**（同一个迁移里一次做完，避免任务之间互相等待）：`workspace_locks`、`workspaces.mode`、`workspaces.plan_approved_at`。**归 M2-02 所有**，其他任务只使用，不改 `db.mjs`。全新开始，不涉及旧库迁移之外的兼容。

## 5. 约束与验收

- 真实 Sprite 同时存在的 `pca-*` 不超过 **3 台**；只用测试仓库 `hifizz/tars-sandbox-playground`；模型只用 SWE-2 / GLM 5.3 / GPT-6.1-sol；全新临时 `TARSBOT_DATA_DIR`；不读、不回显 `.env`；不删 `data/`、不动 `pi-cloud-agents`。
- 自动化：`TARSBOT_NO_DOTENV=1 npm test`、`cd web && npm test && npm run typecheck && npm run build` 全绿。
- **每个大任务用 EGO 浏览器验收**（AGENTS.md「验收」），由编排者做；并行 worker 不起服务、不占 8090/5183。
- **M1 的教训**：单元测试全绿时，仍出现了「路由没注册」和「PR 状态串工作区」两个只有实机才暴露的问题。所以 M2 的接线类改动必须同时有 `test/integration-startup.test.mjs` 风格的接线断言，并在真实服务上走一遍。
- **新增故障测试**（离线，时序窗口各重复 ≥10 次）：
  - FT-M2-1：持有者在 `prepare` 与 `start` 之间被接管 → 不启动；`start` 之后被接管 → 命令被杀且结果为「已被接管」，旧持有者随后的 `write`/`bash` 全部被拒。
  - FT-M2-2：审批等待期间重建 → 批准后命令不执行，结果为「审批作废 / 结果待确认」，新 Sprite 上没有该命令的 `~/.pca/runs/<id>`。
  - FT-M2-3：同一 `requestId`、不同内容的聊天输入 → 409；同内容 → 同一条消息。
- **真实 Sprite 验收场景**（M2-12，≥3 台以内）：两个会话同工作区，B 写入被拒、接管后 A 的长命令被杀且 A 此后写入被拒；人在接管期间改了文件，交还后 Bot 能看到真实改动；改动面板对 bash 造成的新增/修改/删除/二进制都正确；审批期间重建后的行为；先出方案全流程；中止显示「已停止」；新建 Sprite 后连续 20 次 bash 无「结果待确认」。

## 6. 明确不做、留给后面

| 项 | 为什么不在 M2 | 去向 |
|---|---|---|
| Sprite 内的人工终端 | 没有证据表明 Sprites 的 TTY 能经现有非 TTY 的 `provider.bash` 使用，需要 spike | M3；M2-12 先做 spike 并写结论 |
| 释放/配额/孤儿回收/空闲 TTL | 需要「先存检查点再释放」「全局与每用户上限」「与绑定对账的孤儿回收」的设计 | M4（生命周期） |
| 自动检查点、控制库备份 | 自动触发时机、`node:sqlite` `backup()` 与跨文件一致性 | M4 |
| 预览、交付卡与测试证据 | 产品形态未定 | M3 |
| InstaBox / E2B / VPS | 见 §7 | M3~M5 |
| 旧共享 Sprite 的脚本（`scripts/sprite-setup.sh`、`scratch/sprite-setup.mjs`） | 仍依赖 `TARSBOT_SPRITE_NAME` | M2-11 里退役或改为只服务 `pca-*` |

## 7. InstaBox 的接入方式（记录，M2 不做）

PR #1 把 InstaBox 做成第三种全局沙箱；M1 删掉了全局沙箱选择器，所以它不能直接合并。调研结论：`src/sandbox/instabox.mjs` 的 `createInstaboxBash` 是依赖注入式的，可直接复用；`test/instabox.test.mjs`（约 522 行，离线）去掉单例相关用例后可复用。要做的是新增 `src/providers/instabox.mjs`（实现 `ensure / init / bash / status / list / release`，用 `pca-<hash>` 与 metadata 做受管判定），并把 M1 里写死 `providers.sprites` 的几处改为按 `binding.provider` 选取（`src/server.mjs`、`src/workspaces.mjs`、`src/workspace-rebuild.mjs`）。**runner 能否在 InstaBox 上工作未知**（home 是 `/data/home`、单次 `commands.run` 上限 600 秒与 1 MiB 输出、`setsid` 进程在自动挂起后是否存活），需要先做探针。建议作为 M3 的第一个任务，并在 PR #1 上说明这条路径。

## 8. 任务与文件归属

并行 worker 只改自己列出的文件，不 `git commit`。共享文件（`src/runtime.mjs`、`src/server.mjs`、`src/config.mjs`、`src/ext/preamble.mjs`、`src/api.mjs`、`docs/CONTRACTS.md`、`README.md`/`README.zh-CN.md`、`AGENTS.md`）只有编排者在 M2-11 改。

| 任务 | 可创建/修改 | 依赖 |
|---|---|---|
| M2-01 新 Sprite 就绪探测与取证 | `src/providers/sprites.mjs`、`src/sandbox/sprites.mjs`（仅预开重试）、`scratch/m2-readiness-*.mjs`、`docs/m2-readiness.md`、`test/providers-sprites.test.mjs`、`test/sprites.test.mjs` | — |
| M2-02 写锁存储与迁移 v2 | `src/control/db.mjs`、`src/control/store.mjs`、`test/control-store.test.mjs` | — |
| M2-03 围栏：Exec 与 env 的锁校验 | `src/ext/exec.mjs`、`src/workspace-env.mjs`、`test/exec.test.mjs`、`test/workspace-env.test.mjs` | M2-02 |
| M2-04 锁路由、接管、fork 放开、多会话 | `src/routes/locks.mjs`、`src/routes/fork.mjs`、`src/ext/routines.mjs`（仅例程门控）、`src/workspaces.mjs`（仅 `dispatchTask` 与多会话）、`web/src/` 中锁与接管相关文件、对应测试 | M2-02、M2-03 |
| M2-05 Git 改动后端 | `src/routes/changes.mjs`、`test/changes.test.mjs` | — |
| M2-06 Git 改动面板前端 | `web/src/panels/diff/*`、`web/src/lib/diff.ts`、`web/src/lib/turns.ts`、对应测试 | M2-05（接口约定先行，可并行） |
| M2-07 审批绑定运行版本 | `src/ext/approval.mjs`、`src/routes/approvals.mjs`、`src/ext/exec.mjs`（仅 `approval.binding` 核对）、`test/approval.test.mjs` | M2-03（共改 `exec.mjs`，串行） |
| M2-08 先出方案 | `src/ext/planmode.mjs`、`src/routes/workspaces.mjs`（仅 `mode` 与 `plan/approve`）、`web/src/components/NewWorkspaceDialog.tsx`、`WorkspaceStatus.tsx`、`web/src/lib/api.ts`、`types.ts`、对应测试 | M2-02（迁移） |
| M2-09 聊天输入的请求内容冲突 | `src/api.mjs`（仅 `input` 路由）、`web/src/App.tsx`（仅 `sendInput`）、`web/src/lib/api.ts`、`test/api.test.mjs`、`web/test/*` | M2-02 不依赖；可并行 |
| M2-10 中止结果文案 | `src/routes/executions.mjs`、`web/src/lib/reducer.ts`、对应测试、（可选）`src/ext/` 中的 `beforeRequest` 扩展 | — |
| M2-11 集成（编排者） | 共享文件、`test/integration-startup.test.mjs`、文档、旧共享 Sprite 脚本退役 | 全部 |
| M2-12 验收（编排者） | `docs/acceptance/M2/*` | M2-11 |

`package.json` 不改依赖。

### 8.1 共享文件协议

同一个文件被多个任务修改时（并行 worker 共用同一个工作目录）：

1. **只用小范围、精确匹配的编辑**，不要整文件重写——整文件写入会覆盖另一个 worker 刚做的修改。
2. 共享的前端文件 `web/src/lib/api.ts`、`web/src/types.ts`、`web/src/lib/workspaces.ts`、后端 `src/control/store.mjs`：**只追加**新成员/新函数/新类型（放在对应块的末尾），**不修改、不重排、不格式化已有行**。
3. 每个任务开工前先 `git diff -- <文件>` 看是否已有别的任务的改动；有的话在其基础上追加。
4. 发现必须改别人已改的行 → 停下，写进汇报，由编排者合并。
5. 共享文件及先后顺序：

| 文件 | 任务（按先后） |
|---|---|
| `src/control/store.mjs` | M2-02（`locks`、`workspaces` 的 `mode`）→ M2-09（只加 `requests.prune`） |
| `src/ext/exec.mjs` | M2-03 → M2-07（只加 `approval.binding` 核对）；M2-01 不改它 |
| `test/exec.test.mjs` | M2-03 → M2-07（只新增用例） |
| `src/workspaces.mjs`、`src/routes/workspaces.mjs` 及其测试 | M2-08 → M2-04 |
| `web/src/components/WorkspaceStatus.tsx` | M2-08 → M2-04 |
| `web/src/lib/api.ts`、`web/src/types.ts` | M2-09 / M2-10（波 A，追加）→ M2-06 / M2-08（波 B，追加）→ M2-04（波 C，追加） |
| `web/src/lib/workspaces.ts` | M2-06 / M2-08（波 B，追加）→ M2-04（波 C） |
| `web/src/App.tsx` | M2-09（只改 `sendInput`）→ M2-04（如需，只加与锁相关的传参） |

## 9. 依赖与波次

```
波 A（互相独立，可并行）：M2-01  M2-02  M2-05  M2-09  M2-10
波 B：M2-03（要 02）  M2-06（要 05 的接口约定）  M2-08（要 02）
波 C：M2-04（要 02、03）  M2-07（要 03；与 M2-03 共改 exec.mjs，必须在其后）
波 D：M2-11 集成（编排者）→ M2-12 验收（编排者，EGO 浏览器 + 真实 Sprite）
```

`src/ext/exec.mjs` 被 M2-03 与 M2-07 先后修改，不能并行；M2-07 在 M2-03 合入后开始。`src/routes/workspaces.mjs` 被 M2-08 修改，`src/workspaces.mjs` 被 M2-04 修改，二者互不重叠但都要经 M2-11 接线。

## 10. 风险

| 风险 | 影响 | 处理 |
|---|---|---|
| 围栏只在 `execute` 与 env 包装里校验，已在途的一次远端调用无法撤回 | 被接管瞬间可能多写一次 | 接受并写明：围栏保证「之后不再写」，不保证「立刻中止」；接管同时 `conv.abort` + `runner.kill` 缩短窗口 |
| 写锁与例程 `Tick` 的交互 | 例程绕过接管 | M2-04 选定策略并测试 |
| 改动面板每次刷新都要 exec 一次（约 1 秒，且唤醒休眠的 Sprite） | 成本与延迟 | 按需刷新、不轮询、服务端 singleflight + 短缓存 |
| `api.mjs` 的输入路由改动 | 影响所有聊天输入 | 范围限定在该路由，加测试覆盖无 `requestId` 的旧调用行为不变 |
| 先出方案对 `bash` 是软约束 | Bot 仍可能用 bash 写文件 | 界面明确说明；如需硬约束，M3 评估 bash 命令分类 |
| 就绪探针增加新建耗时 | 新建慢几秒 | 只在新建/重建时做，且有上限 |
| 中止文案靠事后推导 | 旧会话记录没有 `runId` 时无法显示 | 没有 `runId` 就退回通用文案 |
