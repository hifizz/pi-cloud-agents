# Slice B 报告：产品 / 领域模型（Session–Loop–Run–Orb 归属与生命周期）

> **存档说明：本文件保留子任务原始报告，尚未应用复核纠正。** 原文的 PASS 仅表示调研任务完成，不表示已实测或设计获批。Session 环境归属与 Run 使用权不是二选一；原文检索日期占位符无效，成本排序没有实测依据。 请以[最终综合报告](07-synthesis.md)为结论，并参照[独立复核](06-independent-review.md)。研究基线为 `9faf7c685dfda3f68fdede64a93721416ad99992`，执行模型为 `magpie/auto/swe-2`，推理强度 `high`。

**状态：PASS** ｜ 基线 SHA：`9faf7c685dfda3f68fdede64a93721416ad99992`（仅读 `/tmp/pca-orb-research-RKFAus/source` 快照）｜ 方法：源码与官方文档检查，无实测、无资源操作、无实现。直接抓取 ampcode.com 被 SSRF 检查拦截，Amp 事实来自搜索服务返回的官方页面原文（检索 2025-XX，见引用 URL），未绕过检查。

## 1. 代码已确认事实

| 事实 | 证据 |
|---|---|
| 环境路由是 Session→Workspace→active binding→provider.bash→SandboxEnv；**解析到 runtimeId 的粒度是 workspace，不是 session/run** | `src/workspace-env.mjs:34-49` |
| binding 唯一约束在 workspace 级：`UNIQUE INDEX runtime_bindings_one_active ON runtime_bindings(workspace_id) WHERE state='active'` | `src/control/db.mjs:81` |
| 同工作区所有会话共享同一 Sprite：issue-loop、手动 session、review、loop run、delegation 子会话都只是 `git worktree add` 到同一 Sprite 上不同目录 | `src/routes/workspaces.mjs:455-540`、`src/loops/runner.mjs:265-277`、`src/routes/delegation.mjs:277` |
| fork 继承父会话的 workspace link；**可写 fork 被显式拒绝**（"同一工作区暂不支持第二个可写会话"），只许 readOnly | `src/routes/fork.mjs:38-50` |
| Loop run = 新建 Session + 新 worktree + 新分支 `loops/<slug>/<runId>`，同 binding；run 结束只等"首次回答落定"，Session 留给人继续用 | `src/loops/runner.mjs:201,280-296` |
| delegation 子会话：同 Sprite、独立 worktree、独立分支 `tarsbot/task-*`，MAX_DEPTH=2、MAX_CHILDREN=10；结果**不自动回流**，需用户显式 `POST /delegation/:taskId/read` 才把摘要作为消息送回父会话；子→父消息只能由用户经 `/message` 转发 | `src/routes/delegation.mjs:14-16,363-404` |
| PTY 终端走同一 binding（workspace 级），是完全信任边界 | `src/server.mjs:187-192`、`src/terminal-env.mjs:12-16` |
| `provider.release()` 存在但**无任何调用方**；workspace 只设 `archived` 状态、无释放路径；worktree 无清理路径 | `src/providers/sprites.mjs:336-357`、`src/control/store.mjs:176`、全库 grep |
| rebuild 换 binding（version+1，旧 binding `replaced` 但**旧 Sprite 不删**） | `src/workspace-rebuild.mjs:6-10,229` |
| Loop 并发上限为进程内全局 3，run 级 FIFO；普通 session 的 bash 不经过该队列 | `src/loops/queue.mjs`、`src/config.mjs:37` |

## 2. 三种归属模型比较

| 维度 | A. 工作区共享 Orb（现状） | B. Session 归属 Orb（Amp 式） | C. Run 归属 Orb |
|---|---|---|---|
| 归属粒度 | 每 workspace 一台 | 每会话一台 | 每次执行一台 |
| 改造面 | 0 | binding 键从 workspace→session，全部入口（bash/PTY/Files/Git/Preview/delegation）改解析键 | 介于两者；session 无 run 时无机器或复用池 |
| 隔夜继续 | 机器一直在，warm/cold 自动续 | 同一会话唤醒原 Orb，体验最顺（Amp orb 随 thread 睡醒） | 需"同 session 续跑恢复原 Orb"规则，否则丢失未提交状态 |
| fork | 只读 fork 免费；可写 fork 目前被禁 | 可写 fork 天然可行（新 thread 新 Orb）——**这正是当前 fork 409 的解锁条件** | fork=新 run→新 Orb，同样可解 |
| 3 个委派子任务 | 同机互踩端口/.git/凭据（Issue #20 已列） | 每子任务独立 Orb 或同 Orb 分目录——Amp 公开口径是 agent 可在新 orb 中派生 agent | 每委派=run，各自 Orb，最干净 |
| 每小时 Loop + 续用 | 免费复用，但挤占交互容量 | Loop 每 run 独占 Orb，冷启动摊销每小时一次 | run 结束释放 Orb；续用需恢复语义 |
| 手工终端改文件+agent 续做 | 天然共享（同一文件系统），**B/C 下成为反例**：PTY 与 agent 若分属不同 Orb 就互相看不到未提交修改 | 要求"session 内所有入口绑定同一 Orb"即可覆盖 | 同左；归属必须以 session 为键而非单次 run |
| 成本/配额 | 机器数最少 | 机器数最多（Amp 突发 20 orb 后排队） | 活跃时才占机，冷启动最多 |

## 3. 推荐（最小默认 + 例外）

- **默认：Orb 以 Session 为归属键**（B），不是 Run。理由：手工终端 + agent 混合工作、隔夜续用、可写 fork 三个场景都要求"会话内一切入口指向同一台机器"；Run 只是 Session 内一次执行的记录，不应持有资源。Run 归属（C）只在 Loop 这类一次性执行里有优势，可作为例外而非默认。
- **例外 1：Loop run 可用"临时 Orb"**——run 独占、终态归还/释放；但注意代码现状是 loop run 的 Session **留给人继续用**（runner.mjs:201 注释），若 Orb 随 run 释放，续用就变成了"同一 Session 绑定新 Orb"，这要求 binding 支持按 session 换绑——这正是要新设计的状态机。
- **例外 2：短期保留共享**。#20 的 C 方案（默认共享 + 高风险可选独立）在迁移期仍成立；不必一步到每会话一机。
- **不需要七张表**：现有 `runtime_bindings` 把主键从 workspace 换成"绑定主体（session 或 workspace）"+ 一个 `orbs` 状态表（状态：等待/准备/执行/空闲/暂停/失败/释放）+ 一个 lease/归属列即可表达全部七概念。`conversation_links`、`loop_runs`、`executions` 已覆盖 Session/Run/Loop 持久侧。Project/Workspace 是既有表。**推断，非已定设计**。

## 4. 其他语义结论

- **父子通信**：现状只有"父→子任务文本 + 用户显式 read 摘要回流"，无子→父自动汇报、无结果结构化通道；Amp 公开口径"agents spawn agents in fresh orbs, send messages"。Orb 化不需要新通信模型，但若子任务跨机，"父会话由用户读结果"的人工环节仍在——**属产品决策**。
- **分支/workcopy 归属**：现状 worktree+分支归 session 记录（`bot.worktree`/`loopRun`/`delegation`），仓库 `.git` 归 workspace/Sprite 共享。Orb 化后 workcopy 必须随 Orb 走或转为"commit/patch 跨 Orb 传递"（#31 例子即此语义）；**同 Orb 不同 worktree 共享 .git 对象库的耦合会消失**——这是独立 Orb 的真实收益之一。
- **持久与删除**：现状没有任何删除路径（无 workspace 删除、无 worktree 清理、release 无调用方）。Orb 模型必须新增：暂停/恢复承诺（哪些文件、进程、服务存活）、产物保留期、销毁前 checkpoint 校验。Amp 公开口径：archive thread 即暂停 orb、paused orb 免费、快照复用 ≤72h、删 thread 删 orb——**可作产品参照，不可推断其内部实现**。

## 5. #20 与 #31 的方向冲突（事实记录，非裁决）

#20 推荐"默认共享、选择性独立"（混合 C）；#31 长期建议"独立写任务默认独占 Orb，共享需明确选择"。两者是**方向级差异**：前者把共享当默认、独立当例外，后者相反。#31 自己也标注这是"需要决策的方向差异，不是已批准的变更"。本报告建议的"Session 归属 + 迁移期保留共享"是中间路径，但**默认开关方向属 owner 决策**。

## 6. 待核实与最小验证

- Sprites 平台暂停/恢复是否保留运行中进程与文件系统、计费口径——最小验证：对已有一台 `pca-*` 测试 Sprite 做 cold 唤醒 + `ps` 对比（受管资源内只读操作）。
- E2B/Instabox/Modal 生命周期能力差异——本 slice 未覆盖（其他 slice）。
- 线上 Sprite 实际规格与 org 配额——`SPRITES_TOKEN` 只读 `listSprites`/`getSprite`。

## 7. 三个最高影响结论

1. **Orb 归属键应选 Session 而非 Run**：现有全部场景（fork、委派、手工终端、隔夜续用）都以会话为边界；Run 归属只在 Loop 有优势，作为例外策略即可。这一选择同时解锁当前被禁的可写 fork。
2. **不需要七张表**：核心改动是把 `runtime_bindings` 的绑定主体从 workspace 换成 session、加一张 Orb 生命周期表；其余概念已有承载。
3. **删除/回收语义是当前最大空白**：代码里不存在任何释放路径，`release()` 无调用方。Orb 化之前必须先定义暂停、产物保留、销毁前 checkpoint 的契约，否则机器数随会话数增长且永不回收。