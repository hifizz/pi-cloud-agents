# Slice A 报告：当前容量与瓶颈（研究基线 `9faf7c685dfda3f68fdede64a93721416ad99992`）

> **存档说明：本文件保留子任务原始报告，尚未应用复核纠正。** 原文的 PASS 仅表示调研任务完成，不表示已实测或设计获批。历史探针不代表当前线上规格；容量、费用及自动暂停行为未经线上验证。 请以[最终综合报告](07-synthesis.md)为结论，并参照[独立复核](06-independent-review.md)。研究基线为 `9faf7c685dfda3f68fdede64a93721416ad99992`，执行模型为 `magpie/auto/swe-2`，推理强度 `high`。

**状态：PASS** · 方法：仅源码快照 + 已安装依赖副本（`@fly/sprites@0.2.3`）+ 官方公开文档检索（2026-11-02）。无线上探测、无运行测试。

## 1. 已确认的代码事实

**主服务（Fly Machine）**：`fly.toml` 配 `shared-cpu-1x` / `memory=512mb`；`auto_stop_machines="suspend"`、`auto_start_machines=true`、`min_machines_running=0`；单 Machine + 单 volume `/data`（`deploy.strategy="immediate"`，注释明确无法双写）。健康检查 `GET /api/health` 15s。

**Sprite 创建参数**：`createSpritesProvider` 默认 `cpus=4, ramMB=4096`（`src/providers/sprites.mjs:24-25`），生产注册未覆盖（`src/server.mjs:96-103`），创建时传 `config:{cpus,ramMB}` + `waitForCapacity:true`（`sprites.mjs:90-94`）。SDK `SpriteConfig` 含 `cpus/ramMB/region/storageGB`（`types.d.ts:26-38`）。

**该参数实际证明什么**：几乎为零。本仓库探针记录（`docs/SPRITES-PLAN.md:210`）："Sprite 规格（8 核 16 GB）无法调整，`createSprite({cpus,ramMB})` 被服务端忽略"。官方 lifecycle 文档（docs.fly.io/sprites/concepts/lifecycle）一致："8 vCPUs 固定；内存平台托管、可在压力下自动扩容；存储 100 GB；不可自行设置"。计费页口径 "up to 8 CPUs and 16GB for any given run"。另有 `policy/resources` API（`ResourcesPolicy.memory.limitMB/autoscale`，SDK `types.d.ts` 已含）代码**未使用**——这是目前唯一官方可调的资源旋钮。

**SDK 序列化**：`spawn` 的 argv+env 编码进 exec WebSocket URL query；实测上限 ~64K 字符（`MAX_EXEC_QUERY_CHARS=64_000`，`src/sandbox/sprites.mjs:36-39`）。所有 env 值一律走 stdin base64 bootstrap，不进 URL（`sprites.mjs:263-290`）。runner 命令上限 `MAX_CMD_BYTES=126000`（runner.sh），`wait` 每次最多 32 KB。

**harness 启动序**（`server.mjs` 头注释 + assemble）：control db → providers → harness(resume:false) → exec resolver → `workspaces.resumePending()` → 15s grace → `harness.resume()` → `loops.restore()` → listen。SIGTERM 走优雅关闭（`kill_timeout=30`）。

**定时与 Loop**：loops 调度、routines、github-poller 全部基于 pi-durable durable sleep——task 以 `{status:"sleeping", until}` 存库，靠 Harness 进程内 `setTimer`（默认 `setTimeout`）唤醒；逾期醒来的 catch-up 语义为"每槽序列只补一次、不爆发"（`routines.mjs`、`sched.mjs` 头注释）。Loop run 队列：全局 FIFO `maxConcurrent=3`（`config.loopsMaxConcurrent`），**仅覆盖 loop run**。

**普通会话 / runner / PTY / 驻留服务**：会话→工作区→active binding→同一 `provider.bash(runtimeId)`（`server.mjs` setExecResolver）。`createSpritesBash` 无并发上限、无队列——N 会话 = N 并发 exec WebSocket（`sandbox/sprites.mjs`）。终端 console 与 PTY（`spawn tty:true`）每 socket 一路，同样无准入。runner `setsid` 脱离进程组跑命令，状态在 `~/.pca/runs/`；用户启动的 dev server 等驻留进程**无注册表、无清理路径**，worktree 同样只增不减。SDK 的 `createService`（托管服务）未被使用。

## 2. 主服务 suspend 的影响（区分事实与推断）

| 对象 | 判定 | 依据 |
|---|---|---|
| durable 定时器（loops schedule/routines/poller） | **suspend 期间不触发；唤醒后按逾期补一次** | 事实：deadline 存库 + 进程冻结时无 CPU；catch-up 语义代码注释明确。suspend 不产生入站流量 → 无自唤醒机制 |
| 模型流式调用 | 推断（未证实）：suspend 中活动答案大概率断流；恢复靠 pi-durable 重启语义或 submission 失败 | TokenRouter 走 HTTP fetch，`stream.timeoutMs=180s`；Fly suspend 以入站流量为准，bot 答案期无 UI/WS 时可能挂起 |
| Sprite 侧 runner 进程 | 事实：不受影响（不同机器）；唤醒后 `wait` 轮询恢复接续 | runner 状态在 Sprite 文件系统，boot_id 校验 |
| Sprite warm/cold | 事实：idle→warm 秒级、compute 不计费（官方），与主服务 suspend 独立 | 官方文档 |

`fly.toml` 的 `min_machines_running=0` 与定时 loops 并存 = **已确认的配置级风险**：无人访问时定时任务至多"醒来后补一次"，间隔可任意长。修复方向：常驻（min=1）或外部定时 HTTP 唤醒，属 owner 决策。

## 3. 可观测性与准入缺口盘点

现有：`/api/usage`（token 用量）、`/api/loops/queue`（队列视图）、workspace steps 状态、`[sprites]` 结构化日志（op/ms/outcome，需 `TARSBOT_SPRITES_LOG`）、会话 busy/queued 读 `pi.live`/`pi.inbox`。
缺口：无 per-Sprite CPU/RAM/磁盘指标、无 exec 并发计数、无 Sprite 进程/驻留服务清单、无 org 配额可见性（`listSprites` 返回 `runningLimit/warmLimit` 但 `provider.list()` 丢弃）、无主服务 RSS/event-loop 指标、无费用口径。准入：仅 loop 全局 FIFO；普通会话 bash、PTY、workspace 准备链均无容量准入（跨工作区并行无界）。

**最小未来测量（不执行，仅指定）**：①一台活 Sprite 跑 `nproc; free -m; cat /sys/fs/cgroup/memory.max; df -h` 定真实 guest 上限；②`provider.list()` 顺手记录 `runningLimit/warmLimit`（零新依赖）；③bash 原语包一层并发计数器打日志；④主服务 `process.memoryUsage()` + event-loop 延迟采样；⑤无流量过夜 + 1 分钟 loop，醒来后验证定时器迟到行为；⑥`ps aux` + `ls ~/.pca/runs` 盘点驻留进程与 run 目录增长。

## 4. 过期/冲突声明勘正

- issue-20 "GH_TOKEN 走 exec env"：**已变**，本 SHA 起 env 值走 stdin bootstrap；loop run 还经 per-call env 剥除 `GH_TOKEN`（`server.mjs` exec resolver）——凭据面比 issue-20 基线改善，credential helper 仍是 global gitconfig 级共享。
- issue-20/issue-31 "cpus=4/ramMB=4096 是申请参数非实测"：仍准确，且官方文档进一步确认服务端不可设置；16GB 应视作软性上限（计费口径），非保证值。
- "单台内会话数无平台限制"：仍无文档证据，维持未知。

## 5. 迁移含义与 owner 决策点

- Orb/Lease 落地前的容量真相只有三条硬边界：org `runningLimit`、单 Sprite 8vCPU/托管内存、主服务 512MB。任何"容量规划"先补 §3 的测量，再谈调度器。
- exec URL 64KB、命令 126KB、wait 32KB 是跨 provider 契约设计时的硬约束参照。
- 待 owner 决定：主服务常驻 vs 外部唤醒；共享信任域是否写为产品语义；`policy/resources` 内存限额是否启用（当前唯一的官方容量旋钮）。

**三条最高影响结论**：①`cpus/ramMB` 参数是死参数，真实容量=8vCPU+平台托管内存，只能靠 guest 内测量证实；②`min_machines_running=0`+进程内定时器使定时 loops 在无人访问时失去准时性保证（仅补一次）；③容量准入只有 loop 全局 FIFO，普通会话/PTY/驻留进程对单台 Sprite 的争抢完全无界，且无任何 per-Sprite 资源可见性——这是 Orb 化之前必须先补的测量层。