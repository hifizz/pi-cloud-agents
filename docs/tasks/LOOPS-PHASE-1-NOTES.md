# Issue 14 Phase 1 — 实现笔记（worker 设计/约束/验证）

基线 `774f73d`（`spike/issue-loop` HEAD），分支 `feat/loops-phase-1`，PR base `feat/loops`。
范围：§5.7 Phase1（Loop 本体、FIFO 队列、运行引擎；手动 / 定时 / 通用 Webhook）+ §6 Phase1 验收条件。

## 1. 数据模型（`src/control/db.mjs` 迁移 v2）

```
loops(id TEXT PK, workspace_id, name, description, instructions,
      trigger JSON, conditions JSON, capabilities JSON, reasoning TEXT,
      enabled INT, owner TEXT, edit_policy TEXT, version INT,
      webhook_secret_hash TEXT NULL,
      created_at, updated_at)
loop_versions(loop_id, version, snapshot JSON, published_at, published_by, PK(loop_id,version))
loop_runs(id TEXT PK, loop_id, loop_version, workspace_id, trigger_kind, trigger_key,
          payload JSON, entity_ref TEXT NULL, bot_id NULL, branch NULL, pr_number NULL,
          status TEXT CHECK (queued|starting|running|needs_approval|succeeded|failed|canceled|skipped),
          error TEXT NULL, enqueued_at, started_at NULL, ended_at NULL, usage JSON NULL,
          UNIQUE(loop_id, trigger_key))
loop_match_state(loop_id, entity_ref, matched INT, updated_at, PK(loop_id,entity_ref))   -- Phase 2 预留
github_event_cursor(workspace_id PK, last_event_id, polled_at)                            -- Phase 2 预留
github_deliveries(event_key PK, source, received_at)                                      -- Phase 2 预留
```

- `webhook_secret_hash`：scrypt 复用 `src/auth.mjs` 的 `hashPassword`/`verifyPasswordHash`（验证是异步 CPU 密集、salt 内嵌，常量时间语义由 scrypt 比较提供）。rotate 只在响应中返回一次明文；hash 不落日志、不进版本快照外的任何地方（snapshot 不含 secret 字段，见下）。
- `trigger_key`：`manual:<uuid>` / `webhook:<Webhook-Id>` / `schedule:<slotTs>` / `gh:<key>`（Phase2）。`UNIQUE(loop_id, trigger_key)` 是幂等的真相来源：`enqueueRun` 撞约束时返回既有 run + `created:false`。

## 2. 状态机（loop_runs.status）

```
queued ──dequeue──> starting ──bot 建好/提交──> running ──session 结束──> succeeded / failed
  │                  │                                                    │
  └──cancel──> canceled  └──失败──> failed(error)                needs_approval(Phase3, 占位不自动转移)
任何状态 ──取消 queued──> canceled；starting/running 取消 → abort session + failed?/canceled
```

- `queued` / `starting` / `running` / `needs_approval` 占用并发槽；其余为终态。
- `starting` 是瞬态：dequeue 后同步置为 `starting`，runner 协程异步建 worktree+Bot+提交首条消息，然后 `running`。这样崩溃恢复能区分「从未占用过真实 Session」与「Session 由 pi-durable 继续执行」。
- 启动恢复（`queue.restore()`）：`starting`/`running`/`needs_approval` → 查其 Bot/会话是否仍存在且未结束；存在 → 保持占用槽；不存在/已 idle 且无从判断 → `failed`，error=`interrupted`。`queued` 原样保留顺序。恢复不重新建 worktree/Bot。
- 并发上限：`config.loopsMaxConcurrent`（`TARSBOT_LOOPS_MAX_CONCURRENCY`，默认 3）。FIFO 按 `enqueued_at` 序，腾位即启动队首。
- `skipped`：禁用的 loop 被触发时不入队（schedule 路径记 `skipped` run 以备审计；webhook 401/404 不记）。Run now 对禁用 loop 返回 409。

## 3. 鉴权接缝

- 普通 API：全走现有 `src/routes/auth.mjs` 全局 guard（session cookie + Origin）。loops 路由一律在 guard 之后。
- 通用 webhook（`POST /api/loops/:id/webhook`）：机器认证。两种合法请求头：
  1. `Authorization: Bearer <secret>` — 与 DB 存的 scrypt hash 验证（常量时间由 scrypt 提供）。
  2. Standard Webhooks 签名：`webhook-id` + `webhook-timestamp` + `webhook-signature`（`v1,<base64-hmac>`）。HMAC 需要原始密钥，**不能只存 hash**：材料来自环境变量 `TARSBOT_LOOPS_WEBHOOK_HMAC_KEY`（缺失则该路径 503，不伪造）；签名串为 `<id>.<ts>.<rawBody>`，时间窗 ±5min。
- **raw body**：HMAC 需要对原始字节签名。`api.mjs` 增加受限能力：路由可声明 `rawBody: true`（`app.post(path, {rawBody:true}, handler)` 或 `app.raw`）。仅该 webhook 路径使用：body 上限单独收紧到 64KB，读取先于一切解析/副作用，签名验证在 JSON 解析之前。guard 按 method+path 精确放行这两个入口前先跑 webhook 自身校验——实现为：guard 仍对 `/api/loops/:id/webhook` 要求机器凭据存在（不豁免），校验逻辑在路由内完成，guard 只放行该精确路径的匿名到达（method=POST 且 path 匹配 `^/api/loops/[^/]+/webhook$`），其余 `/api/loops/*` 全部照常 session。
- `POST /api/loops/:id/webhook/rotate`：普通 session 鉴权，生成新 secret→存 hash→响应一次明文。
- 限速：webhook 路径每 loop 每 IP 简单令牌桶（进程内），429；失败认证 401 且不写 run。

## 4. 队列（`src/loops/queue.mjs`）

- 进程内单写者（控制库单进程单写约定）。`enqueue({loopId, triggerKind, triggerKey, payload, entityRef})`：
  - loop 禁用 → `{skipped:true}`（schedule 写一条 `skipped` run；其余调用方自行决定是否记录）。
  - `UNIQUE(loop_id,trigger_key)` 冲突 → 返回既有 run。
  - 否则插入 `queued`，随后 `pump()`。
- `pump()`：`active = count(starting|running|needs_approval)`；`active < max` 时取最老 `queued` 置 `starting` 并触发 runner 协程（注入的 `runOne(runId)`），协程结束/失败→`finish(runId, outcome)`→更新终态→再 `pump()`。`pump` 可重入安全（标志位）。
- `cancel(runId)`：`queued`→`canceled`；`starting`/`running`/`needs_approval`→置 `canceled` 并调 runner 的 `abortRun`（abort 会话），槽位释放由 finish 路径保证。
- `queue` 视图：返回 running/queued 全量 + 每个 queued 的 `position`（按 enqueued_at 序 1..n）。

## 5. 运行引擎（`src/loops/runner.mjs`）

`runOne(run)`：
1. 读 loop 当前版本快照里的 instructions/capabilities/trigger（run 记录 `loop_version`）。
2. 组装首条消息（上下文）：
   - `manual`/`webhook`：loop instructions + 标注不可信的 payload 围栏块。
   - `schedule`：loop instructions + 工作区摘要（名称/分支/仓库）。
   - issue/PR 实体（`entity.issue`/`entity.pr`，Run now 可带）：issue → 复用 discuss 的组装（issue 正文+评论+基线 pin）；PR → 复用 review 的 pin 头 SHA。**复用方式**：`src/routes/workspaces.mjs` 中的 `pickBaseline`/`pinnedSha`/`discussionMessage`/`reviewMessage` 抽为可导出函数（`src/routes/workspaces.mjs` 导出，或下沉到 `src/loops/context.mjs`——选后者避免路由文件膨胀：抽到 `src/loops/context.mjs`，`workspaces.mjs` 改为 import）。
3. 按 `capabilities.code` 准备目录（同 Sprite `runtimeBash`）：
   - `none`：`dir = <home>/loops/<ws>/run-<id>/empty`（mkdir，空目录，无 git 检出）；cwd 指向它。
   - `read`：`git -C <ws.cwd> fetch origin <baseBranch>` + `worktree add --detach <dir> <sha>`。
   - `readwrite`：`worktree add -b loops/<slug>/<runId> <dir> <sha>`。
   - pin SHA：实体触发 → issue 用基线分支 pin（同 discuss）；manual/schedule/webhook → 仓库默认分支当前 SHA（`getRepo.defaultBranch`→`getBranch`）。
4. `createBot`：`loopRun{loopId,runId,version}`、`workspaceId`、cwd、`instructions` = loop instructions + LOOP_RULES 安全块、`extensions:{remove:[Preamble]}`（同 spike 做法）、`tools` 按 capabilities 组装：
   - `code=none`：不装 `bash`/`read`/`edit`/`write`（移除 Exec/bash 与 CodingTools 的文件写工具；只留 read？——none 的语义是「不检出代码」，不是「不能读」，但为硬约束：`none` 去掉 bash+write/edit；`read` 去掉 write/edit/apply_patch；`readwrite` 全量）。工具收窄用 `agent.tools` 显式名单（`tools:[...]` 白名单）+ `extensions.remove` 去掉 Exec。
   - `web=false`：移除 `web_search`/`web_fetch` 类工具。
   - Phase1 不装 GitHub 写工具（Phase2 才有）；`scopeToTrigger`/`tools[]`/`github.*` 字段校验收进 schema 但 Phase1 不实现工具本体。
   - `LOOP_RULES`（替代 SPIKE_RULES，适配 readwrite）：不改写远端历史、不删远端 ref、**不 merge/close PR**、不改仓库设置、不打印凭据；`read`/`none` 额外禁 push；`readwrite` 允许 `git push origin loops/...` 但合并仍须人工（bash 里 `gh pr merge`/`git push` 到基线分支仍走 Approval 规则兜底——Approval 扩展保持安装且最后）。
5. `submit` 首条消息 → 状态 `running`；`conv` 的首次完成（`waitForIdle` 或 run 提交 settle）→ `succeeded`（Phase1：`submit().wait()` 结算一次即算 run 结束；会话仍可继续对话，状态由人来转，Bot status 置 `awaiting`）。
   - 为可测与断点恢复：`runner` 里建 Bot/链接/提交全部经注入的 `deps`（bots、store、runtimeBash、github、homeDir），与 spike 路由同形。崩溃时 run 停在 `starting`/`running` 由恢复逻辑接管。
6. `usage`：`pi.usage` doc 在结束时读出写回 `loop_runs.usage`（尽力而为）。

## 6. 定时（schedule）

`trigger.schedule` = `{freq: hourly|daily|weekly|monthly|yearly, interval≥1, days? , at:"HH:MM", tz, startAt}`。

- 新增 `src/loops/schedule.mjs`：`nextSlot(spec, afterMs)` 纯函数，tz 用 `Intl`（`en-CA` locale 取各部件，DST 由 Intl 处理；小时槽用 UTC 网格对齐 `interval`：hourly 的槽 = startAt 起每 interval 小时的整点网格）。
- 触发本体：复用 pi-durable 持久 sleep 机制，但**不**改 `src/ext/routines.mjs` 现有 Tick（AGENTS 约束原 routine 行为不变）。做法：`src/loops/sched.mjs` 定义 `LoopTick` 任务（新扩展 `LoopsSched`，`name: "tarsbot.loops.schedule"`），每个启用 schedule 的 loop 一个会话级任务？任务需要 carrier：用 `harness.commit`（Session 级 commit，需 conversationId —— ownerless 任务不能挂在不存在的会话上）。**方案**：一个「调度器会话」——server 启动时 `harness.root(ctx)` 或直接 `createConversation({ownership:{kind:"ownerless"}})` 作为 carrier，所有 LoopTick 挂其上（conversation 内 background task）。控制库 `meta` 记 carrier conversationId，重启复用。任务 abort/重建由 loop 的 enable/disable/PATCH 驱动（存 taskId 在 meta/`loop_runs` 无关——存 `loops` 表外字段？不，存 session doc 或 meta key `loops.schedTasks` → {loopId: taskId}）。
- exactly-once：`trigger_key = schedule:<slotTs>` + `UNIQUE(loop_id,trigger_key)` 双保险；任务侧 requestId 语义由 DB 唯一约束承担（崩溃重放最多重复一次 enqueue，被唯一约束吸收）。补跑沿用 routine 语义：错过多个槽只补最近一个（`nextSlot` 直接算 `after=now` 的下一槽，逐槽不重放）。
- PATCH 改 trigger / disable / delete：重建或 abort 对应任务（先 abort 旧任务再建新的，版本无关）。

## 7. API（`src/routes/loops.mjs`）

| 方法+路径 | 说明 |
|---|---|
| GET `/api/workspaces/:id/loops` | 列表（含最近 run 摘要） |
| POST `/api/workspaces/:id/loops` | 创建（校验：name≤64, description≤255, conditions≤8, trigger/capabilities schema） |
| GET `/api/loops/:id` | 详情 |
| PATCH `/api/loops/:id` | 修改 → version+1 + `loop_versions` 快照（snapshot 不含 `webhook_secret_hash`） |
| DELETE `/api/loops/:id` | 删除（连带版本/运行记录删除策略：runs 保留但 loop_id 悬空？——选 `ON DELETE CASCADE` 之外手动：runs 属于审计历史，删除 loop 时保留 runs 并将其 `loop_id` 置 NULL? 方案定为：runs 外键 `ON DELETE SET NULL`? sqlite 需迁移重建。简化：删 loop 时同时删 versions，runs 保留（loop_id 不再 join，UI 容错）。**决定**：runs 不加外键约束，删 loop 只删 loop+versions+sched task。 |
| POST `/api/loops/:id/enable` `/disable` | 开关；disable 不动 queued（其 dequeue 时 loop 若仍禁用→skipped） |
| POST `/api/loops/:id/run` | `{entity?:{issue?:n,pr?:n}}` → `{runId,status}`；disabled→409 |
| GET `/api/loops/:id/runs?limit&cursor` | 运行历史 |
| POST `/api/loop-runs/:runId/cancel` | 取消 |
| GET `/api/loops/queue` | `{maxConcurrent, running:[…], queued:[{runId,position,…}]}` |
| POST `/api/loops/:id/webhook` | 机器认证，raw body，202 `{runId}`（dedup 返回原 runId） |
| POST `/api/loops/:id/webhook/rotate` | session 鉴权， `{secret}` 一次 |

PATCH/DELETE 需要 router 支持：`api.mjs` 增加 `app.patch`/`app.delete`（最小改动，无业务逻辑）。body 读取对 PATCH 同 POST。

## 8. Bots 元数据

`bots.mjs` `createBot` spec 增加 `loopRun:{loopId,runId,version}` 白名单字段（同 issueLoop 形态持久化）。`update` 不变。

## 9. 前端

- `web/src/lib/loops.ts`：类型 + API 客户端（list/create/get/patch/delete/enable/disable/run/runs/cancel/queue/rotate）。
- `web/src/types.ts`：`BotSummary.loopRun?`。
- `LoopsList.tsx`：workspace 下 loop 列表（名称、触发器摘要、enabled 开关、最近 run 状态、Run now、进编辑器）。
- `LoopEditor.tsx`：Trigger（kind 选择 + schedule 字段）/ Instructions / Capabilities（code 三档、web、scopeToTrigger、reasoning）+ Save。
- `LoopRuns.tsx`：run 历史 + 队列视图（queued 显示 `#n`、可取消；running 显示运行中；点 run 打开 botId 会话）。
- `SessionHeader.tsx`：`bot.loopRun` 时灰色小字「来自 Loop：<name> · 运行 #<runId 后缀>」，点击切到该 workspace 的 loops 视图。
- `BotList.tsx`/`App.tsx`：workspace 行加 "Loops" 入口（选中工作区后 overview 之上显示 Loops 段；导航状态 `pickedBotId` 之外加 `view: overview|loops|loopRuns`——最小改动：pickedBotId 保持，另加 `loopsView` 状态 `null|{mode:"list"}|{mode:"edit",loopId?}|{mode:"runs",loopId}`）。

## 10. 风险 → 测试办法

| 风险 | 覆盖 |
|---|---|
| 并发上限/FIFO/取消/失败腾位 | `test/loops-queue.test.mjs`：内存 store + 注入假 runner（可控完成/失败），假时钟 |
| 重启恢复不重复建 Bot、queued 保留、interrupted 标 failed | 同文件：预置各状态行 → `restore()` 断言 |
| trigger_key 幂等 | 同文件：重复 enqueue 返回同 run |
| 调度网格/DST | `test/loops-schedule.test.mjs`：固定 `America/New_York`、`Asia/Singapore`，逐 freq + interval + days + startAt |
| webhook 401/202/dedup/rotate/标准签名/时间窗/大小限 | `test/loops-webhook.test.mjs`：真 createApi + 真路由 + 内存 store，fetch 直接打 |
| worktree 三分支 + pin + Bot 元数据 + 首条消息围栏 | `test/loops-runner.test.mjs`：fakeBots/fakeRuntimeBash/fakeGithub（同 issue-loop 测试形态） |
| store CRUD/校验/version 快照/禁用约束 | `test/loops-store.test.mjs` |
| 前端列表/编辑器/排队显示/回链 | `web/test/loops.test.tsx` |
| 审批不被绕过 | runner 测试断言 `extensions.remove` 仅 `[Preamble]`，Approval 在链上 |
| secret 不落库明文/不进 snapshot/log | webhook 测试断言 DB 只有 hash、响应仅一次含明文、payload 中 secret 不出现在首条消息 |

## 11. 不可验证/限制（汇报用）

- 浏览器验收、真实 Sprite 现场：归父级。
- `starting` 崩溃于「已建 Bot 未写 bot_id」缝隙：恢复时该 run 标 failed(interrupted)，可能遗留孤儿 worktree/会话（记录在案，不自动清理）。
- Standard Webhooks 的 HMAC key 是环境级（所有 loop 共用），loop 级 secret 仅 Bearer 路径可用——文档明确。
- `needs_approval` Phase1 只作状态存在（Approval 扩展阻塞期间 run 停留 running；Phase3 才联动）。
- pi-durable「会话是否仍活着」的判定用于恢复：`harness.conversation(id)` 存在 + `viewState` 可读 + inbox/live 无 run → 判定空闲→interrupted。判定启发式，现场验证归父级。

## 12. 测试修复记录（worker 续跑发现）

- `queue.restore()`：原实现对 `starting`/`running` 的 run 直接重建 Bot + worktree → 重复创建已改为**探测** `isRunSessionLive(run)`（bot 存在且 conversation 活着且 inbox/live 显示仍有 run/inbox 排队），活则保留 slot（不重建）；死则 `failed(interrupted)`，`queued` 行保留顺序。测试 `restore: queued keep order; starting/running marked failed(interrupted) when dead, kept when live` 覆盖双路径。
- `cancel()` 的 slot 释放时机：改为 `cancel` 先置 `cancelRequested`，再 `await abortRun` + 有界 `abortGraceMs`（默认 10s，测试传 30ms）等待在途 runOne 落地后才 `pump()` 腾位。`finish` 对 cancel-requested 的迟到落地一律落成 `canceled`（迟到的 succeeded 不会把已取消 run 升级）。
- `idle()` bug：原 `while(inflight.size)` 会在 inflight 清空后再 `pump` 新 queued 进入继续循环 → 挂死。修复为只 await 当前 inflight 集合一次。测试 `a finished run frees the slot; queue head starts next` + `idle()` 在 dedup/失败用例里被间接覆盖（它们 settleAll 后 idle 必须返回）。
- `store.mjs` `loopRuns.update` bug：`values.push(id)` 缺失导致 WHERE 绑定错参（静默 no-op）→ 已修，dedup/cancel/restore 测试覆盖 update 实际生效。
- `test/loops-queue.test.mjs` dedup 用例曾在 node --test 下挂起：根因是 enqueue 后 runOne 由 `Promise.resolve().then(runOne)` 异步调用，测试在 microtask 落地前同步 `settleAll()`（map 为空）→ parked 无人 resolve。加 `await tick()`（10ms setTimeout）让 runOne 先落地再 settle——非实现 bug，是测试时序。
- `sched.mjs` API 面验证：与 `src/ext/routines.mjs` 用同一组调用（`runtime.sleepUntil/snapshot/commit`, `conv.commit`/`tx.createTask`, `harness.snapshot/abortTask/commit`, `harness.createConversation({ownership:{kind:"ownerless"}})`, `harness.conversation(id,ctx)`）。pi-durable `dist/harness/types.d.ts` 均存在且签名匹配；`LoopSchedDoc` 是 session-scoped doc、在 `conv.commit`/`tx.doc` 中使用与 RoutinesDoc 相同方式。**未跑真实 harness 的端到端 schedule tick**（无 fake harness 测试），归父级 EGO 验收。

## 13. 当前测试结果（实测）

- `npm test`（backend）：401 tests，400 pass / 0 fail / 1 skipped（原有 skip）。
- loops 专项（40 tests）：store 7 / queue 10 / schedule 10 / webhook 6 / runner 7 —— 全 pass（`node --test test/loops-*.test.mjs`）。
- `web/`：`npx tsc --noEmit` 0 error；`vitest run test/loops.test.tsx` 5/5 pass；`vite build` 成功（outDir /tmp/loops-web-build-*）。
- 语法：`node --check` 全部新增/修改 .mjs 通过。

## 14. 独立审查修复（B1 + 安全 + 元数据 + 恢复）

**B1 — 取消 `starting` run 竞态（已修）**
- `store.loopRuns.update`：终态（succeeded/failed/canceled/skipped）后 status 不可再变更（`已终结` invalid 拒绝）；非 status 审计字段（botId/branch/startedAt/usage）仍可写——被遗弃协程晚建 Bot 时 botId 落库留痕而不是丢孤儿。
- `runner.runOne` 新增 `checkNotCanceled()`（queue `isRunCanceled` 旗标 ∪ 行已终态）：worktree 完成后、createBot 前、submit 前两道闸；命中即抛 `code:"canceled"`，createBot 后命中还会 `conv.abort` 回收孤儿会话。
- runner 终态写全部改走注入的 `finishRun`（= `queue.finish`）：终态 no-op + `cancelRequested→canceled` 映射一处生效；runner 不再直写 succeeded/failed（无 finishRun 注入时保留直写兜底，供单测）。
- 测试：真实 Harness + MemoryStorage + faux + 真实 BotRegistry/runner 的 `test/loops-cancel-real.test.mjs`——worktree 门控中取消→不建 Bot、行不复活；Bot 已建未 submit 时取消→会话被 abort、行仍 canceled、botId 留痕。

**安全 — `code=read` 曾留无限制 bash（已修）**
- `toolPlan`：read 档现在 deny `bash`+`write`+`edit`（无 shell 才是真只读——`printf > file` 绕过 write/edit 移除）；`search_history` 是本地历史检索（非网络），不再受 `web` 开关连坐，`web=false` 仅移 `web_search`。
- runner 测试断言 read 档被移除集 = `{bash, edit, web_search, write}`，none 档保留 `search_history`。

**loopRun 元数据（已修）**
- `bots.createBot` 的 `loopRun` 现携 `{dir, pinnedSha, branch, capabilities:{code,web}}`：EnvironmentPane 显示 run 自己的「会话目录 + detached@sha / 分支」，SessionHeader `gitLabel` 显示 loopRun 的钉住状态——不再回落到 workspace.cwd / 工作分支。Phase 2 集成从 `capabilities` 读限制。

**恢复槽位释放（已修）**
- `queue.restore` 对探活为 live 的 run 改为「收养」：`resumeRun` 经 `pi.live.run.inputs[0]` + `harness.submission(id).wait(ctx)` 真实等待首个提交落地，resolve→succeeded / reject→failed 走 `finish()` 释放槽位。无 live 输入（probe 与 resume 间已结算）立即返回。runner 增加 `deps.harness` 注入。
- `createLoopScheduler.sync` 原硬编码 `Date.now()` → 注入 `now`（fake-clock 测试因此发现此 bug 并修复）。

**测试**：`test/loops-sched-real.test.mjs`——真 harness + fakeClock：schedule loop 每槽恰好一次、5 个错过槽压缩为一次补跑（armed 槽）、补跑后回到 7h 网格续走；`enqueueScheduled` 同槽 3 次调用 = 1 run，disabled/manual 不入队。loops 全部 50 tests 通过；backend 411/410/1skip；web 156/156。

## 15. 现场验收后的 UI/编辑修复（第三次跟进）

- **删除 Loop**：`LoopsList` 每行新增「删除」——两次点击确认（第一击变「确认删除？」红字，第二击才 `loopsApi.remove` + reload）。此前 UI 完全无删除入口。
- **Webhook secret 一次性显示**：原实现在 `save()` 里 `setSecret` 后立即 `onSaved` 跳转 → 编辑器卸载、secret 永远看不见。改为 `pendingSave` 门控：有 secret 时不调用 `onSaved`，编辑器停在独立「显示/复制/我已保存好 secret」步骤；reveal 或 copy 后 ack 才放行跳转（ack 未 reveal 时 disabled）。Cancel/Save 在 pendingSave 期间禁用。同一流程复用于「轮换 secret」（编辑 webhook loop 时 `hasWebhookSecret` → 显示轮换按钮 → `loopsApi.rotateSecret` → 同样 reveal/ack）。
- **schedule.startAt**：`buildTrigger` 留空时默认 `Date.now()+60_000`（下一分钟；原 `Date.now()` 提交时已是过去→服务端 400）。标签改为「按本机时区选择；留空 = 下一分钟」。
- **编辑已过期 startAt**：服务端 `validateTrigger` 新增 `allowStartAt`——PATCH 时若提交的 startAt 与已持久化值逐位相同（未修改）则豁免过去校验；改成别的过去值仍 400。`src/loops/store.mjs` `update` 传入现有 trigger 的 startAt。测试：时间前进后 PATCH 同 startAt 成功，改成另一过去值拒绝（`test/loops-store.test.mjs` 第 8 例）。
- **Loops 界面残留会话 chrome**：`loopsOpen` 时隐藏 `SessionHeader`、`ApprovalBar`、other-pending 横幅和右侧 `PanelHost`（`WorkspaceShell.panel`/`panelOpen` 同样门控）；SessionHeader 的「来自 Loop」回链 `onOpenLoop` 现在同时 `setPickedBotId(null)`。
- **测试**：`web/test/loops.test.tsx` 新增 3 例——create-with-webhook 保存后 `onSaved` 未被调用、secret 需 reveal 才显示、ack 后才导航；rotate 走同一门控；删除需第二击确认且 reload。web 159/159、loops 后端 51/51（含新增 store 用例）、tsc 0 error。
