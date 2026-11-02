# Slice C 报告：Pi Durable 与资源调度的分工

> **存档说明：本文件保留子任务原始报告，尚未应用复核纠正。** 原文的 PASS 仅表示调研任务完成，不表示已实测或设计获批。Durable 允许异步等待与异步 env；单写约束不排除所有执行 worker 扩展。 请以[最终综合报告](07-synthesis.md)为结论，并参照[独立复核](06-independent-review.md)。研究基线为 `9faf7c685dfda3f68fdede64a93721416ad99992`，执行模型为 `magpie/auto/swe-2`，推理强度 `high`。

**状态：PASS** · 基线 SHA `9faf7c685dfda3f68fdede64a93721416ad99992` · 方法：仅源码与已安装包 `.d.ts`/实现检查，无运行测试。证据包 `@earendil-works/pi-durable` 为 **1.4.0**，与 `source/package.json` 锁定的 `1.4.0` 一致。

## 1. Durable 已拥有什么（代码事实）

**持久化**：Session 一条原子提交行（`session/session.d.ts` createSession/SessionImpl）；任务状态机 `pending/running/waiting/sleeping/completing/terminal`（`types.d.ts` TaskState）；checkpoint 即"恢复所需的全部持久状态"；memo 为任务级 first-write-wins 幂等原语。

**调度**：`harness/scheduler.js #reserve()` 一遍内预约**所有** runnable 任务——无并发上限、无优先级、无配额；`waiting.on` + `JoinPolicy` 提供持久 join；`sleeping.until` 是持久截止时间，由宿主 `setTimer`（默认 setTimeout）或 `onWake`/`Harness.wake()` 唤醒（`harness/types.d.ts` HarnessOptions.onWake、Wake）。

**取消**：`abortTask`/`abortConversation` 写 abortRequested 标记并按 ownership 树级联；`restartLimit`（默认 5）把反复被切断的任务停为 `restart_limit`，`retryTask` 重跑（`scheduler.d.ts`、`types.d.ts` ReportInfo）。

**外部副作用**：工具 `replay: "safe"|"unsafe"`；嵌套调用按 key 去重；但 `.d.ts` 明确"**this is not exactly-once execution**"（`harness/types.d.ts` executeTool 注释）。结果不确定时 Durable 不裁决——本项目 `exec.mjs` 用 memo 固定 `{runId, runtimeId, bindingVersion, commandHash}`，绑定变更或状态不明时返回 "结果待确认"且绝不重启（`src/ext/exec.mjs` 第 4-5 步、第 213-237 行）。

**本应用在其上的实现**：cron = 每条 loop 一个持久后台 Tick 任务 `sleepUntil` 后写 `loop_runs` 行（`src/loops/sched.mjs:37-64`）；审批 = `beforeTool` 钩子内的**进程内**等待 + 结果写 memo（`src/ext/approval.mjs:5-6,260-269`）——等待审批不是持久等待状态，仅 verdict 持久；`loop_runs` 的 `needs_approval` 是应用层状态（`db.mjs:12-23`）。Loop 队列是控制库 FIFO，全局 `maxConcurrent=3`（`src/loops/queue.mjs`、`config.mjs:37`）。

## 2. Durable 没有、资源控制必须自己拥有的（代码事实 + 推断）

| 缺口 | 证据 | 归谁 |
|---|---|---|
| 计算资源准入/容量 | scheduler `#reserve` 无上限；无 CPU/内存/磁盘记账，TaskRecord 只有 `startedAt/endedAt` | 资源服务（Orb/Lease） |
| 交互 vs Loop 公平 | 交互 submit 直接进 harness，绕过 loop 队列；loop 队列只约束 loop run | 资源服务：按 Orb/机器的准入门，而非仅 loop 计数 |
| LLM 与计算限额分离 | LLM 并发无开关（`toolExecution` 只控单轮工具并行）；`src/models.mjs` 仅有 cost 表 | 两层独立：模型额度/tokenrouter 侧 vs Orb 槽位侧 |
| 等待资源的持久状态 | Durable `waiting` 只支持等待 TaskId，不支持"等待外部资源"；sleeping 是时间等待 | 应用层需新增 lease 状态或经 submission/工具内等待 |
| 多机/多写 | `SqliteStorage` 假定单一 owning Session；Storage 错误即 Session 失败；`fly.toml` `strategy="immediate"` + `min_machines_running=0` | 单写进程约束直接决定：调度器必须在本进程内，不能横向扩 |
| 挂起时定时任务 | 生产未传 `onWake`（`harness.mjs`），`auto_stop_machines="suspend"` → sleeping 任务在挂起期间不会触发 | 宿主常驻/唤醒方案（owner 决策） |

## 3. 关键分析

- **Lease 粒度**：现状绑定粒度是 workspace（`runtime_bindings` 每 workspace 至多一个 active，`db.mjs:86`；`workspace-env.mjs` 解析链 conversation→workspace→binding）。Orb 化后最小变更粒度是 **binding 行**（版本递增已存在），但 `executions.binding_version` 核对意味着切绑定会让在途执行落入"结果待确认"而非自动迁移（`exec.mjs:213-217`）——Lease 应挂在新对象（Orb 或 Run）而非复用 binding 版本语义，否则 rebuild 的"旧命令不重放"语义会被稀释。子任务/子对话（`createConversation{ownership:{kind:"task"}}`、`executeTool` 子任务）目前是继承父 env（`env` 按 conversationId 解析），要独占 Orb 需让 env 工厂能按 conversation→不同 binding 解析，而不改 Durable。
- **等待模型**：审批和"等待 Orb"同构——都是进程内 Promise + 持久意图记录。Durable 无"等待外部资源"原语，最小方案是复用 memo/工具内等待模式，而不是把 lease 等待塞进 `waiting.on`（那只能等 TaskId）。
- **环 FIFO 与公平**：`loop_runs` FIFO + 固定 3 槽已是正确的应用层先例；交互工作负载完全无门控（issue-31 讨论 §3.1 已列"容量管理缺口"，本 SHA 依旧成立）。资源准入应作为 env/runner 解析路径上的统一前置门，覆盖 exec、runtimeBash、ptySession 三条入口（`server.mjs:130-190`）。
- **单写与重启**：`queue.restore()` 的 `isRunSessionLive`+`resumeRun` 模式（`queue.mjs:176-215`、`runner.mjs`）证明：重启后先探测 Durable 实况再对账，而不是信控制库——Orb/Lease 状态机应照抄此模式。

## 4. 最小集成缝（提案，非已实现 API）

```text
// 提案：在现有解析链中插一层，不改 pi-durable
resolveCompute({ conversationId, cwd })
  -> { env: SandboxEnv, lease: LeaseHandle }   // env 工厂（HarnessOptions.env）内调用
lease.acquire({ workspaceId, runId?, class }) -> LeaseHandle | Queued
runnerFor(binding) / provider.bash(runtimeId)  // 保持不变
executions.binding_version 核对                 // 保持不变，Orb 化后改记 orbVersion
```

缝点候选（按侵入性排序，**建议**）：(1) `createWorkspaceEnv` 内 `bindings.current` 处插 lease 门；(2) `setExecResolver`/`runtimeBash`/`ptySession` 三处统一改为先过 lease；(3) Durable 侧无需改动——`env` 本来就是按需调用（`ToolExecutionApi.env`、`HarnessOptions.env` 每次使用都调）。

**拒绝的替代**：让 Durable 任务自己排队等资源（阻塞 phase 违反其"无持久进度即 faulted"契约，且会占住 invocation）；用 `waiting.on` 表达资源等待（只能等 TaskId）。

## 5. 未决与最小验证

- **多 Orb 同 workspace**：`UNIQUE(workspace_id, version)`+单一 active 索引不阻止多 binding 概念扩展，但 `bindings.current` 语义会歧义——需决定按 Run 还是按 Session 归属（owner 决策，issue-31 未决问题 2）。
- **loop_runs "needs_approval"** 是否真被写入：本 SHA 中未见写点（疑 dead status，最小验证：`grep needs_approval src/` 全量核对）。
- **挂起唤醒**：`min_machines_running=0` 下 sleeping 任务是否实际丢失触发——最小验证：线上 suspend 后放一个 1 分钟 routine 观察。

**三条最高影响结论**：(1) Durable 调度器无容量概念，一切资源准入必须在应用层、且要同时拦在 env 工厂与 runtimeBash/PTY 三条入口；(2) binding-version 核对 + "结果待确认"已是正确的副作用安全先例，Orb/Lease 应在其上扩展而非绕过；(3) LLM 与计算限额天然分层——前者走 `Models`/tokenrouter，后者走 binding→provider 解析缝，不要在同一队列里混合。