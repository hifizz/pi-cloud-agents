# 独立复核：有数项足以改变架构选择的证据错误

> 本文件保存独立复核原文。执行模型为 `magpie/relay/gpt-6-astra`，推理强度 `high`。原文 A/B/C/D/E 分别对应本目录 01–05 报告；行号指原始报告，添加存档说明后可能偏移。临时路径只说明当时检查范围，不作为长期依赖。最终采纳结论见[综合报告](07-synthesis.md)。

**状态：ISSUES。**

**基线 SHA：`9faf7c685dfda3f68fdede64a93721416ad99992`**
方法：仅检查指定冻结源码、依赖副本、五份报告及父级笔记；补查官方文档搜索摘录。未修改文件、运行测试或访问云账号。直接抓取官方网页遭 SSRF 防护拦截，未绕过；以下网页结论来自搜索服务返回的官方页面摘录，不是实测。

下文 `src/` 均指冻结 `source/src/`；`durable/` 指 `evidence/dependencies/@earendil-works/pi-durable/dist/`。依赖副本版本与项目锁定版本均为 **1.4.0**，但版本一致不等于逐字节验证过安装包。

### 1. Session 归属与 Run 租约不是二选一

**纠正 B §3、C §3–4：**应拆开三个概念：

- **Session → 逻辑 Orb**：保存环境亲和关系、工作副本与恢复策略；不意味着永久占用运行中的机器。
- **Run → Lease → Orb**：记录本次使用权、用途、并发额度与回收条件。
- **Orb → provider incarnation/generation**：记录当前实际实例。重建、恢复覆盖或替换实例时，不能让旧命令继续匹配新的执行环境。

同一 Session 的 agent、PTY、文件、Git、预览必须解析到一致的逻辑环境，但不必永远是同一物理实例。PTY、后台服务还可能需要独立于首次回答生命周期的使用权；Run 结束不能直接等同安全回收。

迁移可先把现有 workspace binding 包装为共享 Orb，让原有 Session 保持共享，再逐步加入 Session 显式绑定。**不要先把数据库键直接改成 session，也不要把 generation 当租约版本。**现有 `exec` 固定实例与版本、变更后返回“结果待确认”的行为应保留。独立 Orb 也不会自动实现可写 fork 的状态复制与路由。

证据：`src/workspace-env.mjs:34–52`、`src/control/db.mjs:75–86`、`src/ext/exec.mjs:166–171,209–217`；B 的“Run 不应持有资源”过强。

### 2. Durable 可以异步等待；没有现成资源调度器，不等于禁止等待资源

**C:48 的拒绝理由错误。**源码先 `await` phase handler，**handler 返回后**才检查是否有持久进度；不是 await 期间自动 fault。

需区分：

| 等待形式 | 实际语义 |
|---|---|
| 普通 Promise／异步 env factory | 可以等待外部资源；等待本身不跨重启持久化 |
| `waiting.on` | 持久等待其他 TaskId，不接受任意外部资源键 |
| `sleepUntil` | 持久时间等待，释放 invocation；可承载应用层重查策略 |
| 应用持久队列 | 保存资源申请、授权、取消、恢复对账；需应用实现 |

`HarnessOptions.env` 明确允许 async，并且 **不在 Session 提交串行路径上调用**。因此 env 是可用集成缝，但每次读取 env 都重新申请租约会出问题：申请必须有稳定 ID、幂等查询及取消语义。不要在持久提交回调内长时间等待外部服务。

可用自定义 Durable task 包装申请流程，再让其他 task join；也可应用队列授权后再启动执行。两者都不需要发明 Durable 禁令，也都不能凭 memo 宣称外部副作用 exactly-once。

证据：`durable/harness/types.d.ts:565–566,209–219`；`durable/types.d.ts:235–246,285–292`；`durable/harness/scheduler.js:1594–1614,1693–1697`。

### 3. 单写约束不排除所有 worker 扩展

**C:25“调度器必须在本进程内，不能横向扩”不能由现有证据推出。**

当前部署应维持单一存储写入者，不能直接增加多个共享数据库的 harness 写进程；但可以由一个协调者持久化状态，多个外部执行 worker 通过受控接口领取任务、回报结果。那需要 fencing、失联对账与幂等协议，**不是本轮应立即实现的分布式平台**。

另需区分库的 owning `Session` 与产品里的每个 Bot/Conversation，避免误把底层存储所有者当产品会话容量限制。父级笔记目前缺少对 C 此项错误的明确更正。

### 4. 供应商应按恢复能力分级，不能一票否决

**纠正 D:45,57–59：**

- **E2B**：默认 pause 保存内存和文件系统，但自动暂停持续遭拒时可降级为 filesystem-only，恢复将重启、丢失内存。应读取实际 `pause_mode`，不能承诺“每次暂停都保进程”。可继续作为第二家优先探针候选，理由是已有项目经验，而非“唯一完整恢复者”。
  [官方 persistence 文档](https://docs.e2b.dev/sandbox/persistence)
- **Modal**：文件系统快照可配置 TTL，包括不失效；Volumes 可承载跨实例文件持久化，但有 commit/reload 语义。因此“不适合任何工作区 Orb”过宽。内存快照则有七天到期、终止源实例、运行中的 `exec` 阻止快照、exec 启动的后台进程不能正确恢复等限制。
  [Snapshots](https://modal.com/docs/guide/sandbox-snapshots) · [Filesystem Access](https://modal.com/docs/guide/sandbox-files)
- **Modal JS 支持仍 BLOCKED**：指南称 exit snapshots 仅 Python，最新 JS 文档却列出 `experimentalGetExitSnapshot`。需核对固定 SDK 版本，不能任择其一当兼容性结论。
  [指南](https://modal.com/docs/guide/sandbox-exit-snapshots) · [JS API](https://modal.com/docs/sdk/js/latest/Sandbox)
- **Instabox**：幂等键保留 **七天**，不是永久去重；已失败 operation 的同键重试可能重放失败结果。超窗口恢复仍需本地意图和资源对账。
  [API overview](https://instabox.sh/docs/api)

metadata/name 查询只是发现机制，不天然提供原子创建；断连杀进程也不会撤销先前副作用。git bundle 是**当前实现的**可移植路径，不是所有可能路径；“任何跨机都不能携带内存”同样应删除。

### 5. checkpoint 不提供秘密清除保证

**E:23、E §4/7 与 D:8 应纠正。**

代码将文件加入临时索引后检查名字，生成的警告明确是：

> `possible secret file is not ignored and is included`

它不是删除或拒绝秘密文件；bundle 还可能包含未被排除的历史 Git 对象。活跃数据库文件被复制，也不等于一致性备份。

原生内存快照更不能承诺“env 不进快照”：注入进程的秘密可能已在内存中。应分别定义代码 checkpoint、文件系统快照和内存快照的秘密保留政策。

证据：`src/checkpoint.mjs:168–184,199–207`。父级 `provider-verification.md:15` 的纠正成立。

### 6. 正则阻断不是隔离；审批目前确实占 Loop 槽

- 匹配到危险命令后不能人工覆盖，**不等于所有等价 shell 程序都被禁止**。工具裁剪、每进程去 token 有效，但共享 UID/worktree 仍不构成强隔离。
- 全局 credential helper 保存的是读取 `$GH_TOKEN` 的程序，不是 token 本身；不能据此称 token 全局落盘。
- **E:41“等审批仍占槽未落地”错误**：run 已标记 `running`，等待 submission 完成；审批 Promise 未结束时，计数仍包含该 run。缺少 `needs_approval` 显示转移不等于释放槽位。未来可分离“执行槽”和“保留使用权”，但这是行为变更。
- 独立 Orb 不能让鉴权、路径保护和预览隔离变成可选项。

证据：`src/loops/tools.mjs:28–33`、`src/providers/sprites-init.mjs:6`、`src/ext/approval.mjs:258–268`、`src/loops/runner.mjs:345,373–379`、`src/control/store.mjs:763–770`。

### 7. 容量、成本和验证记录的注意标记

- **A:11,42；B:27–29：ISSUES。**历史探针不能证明当前所有实例忽略规格参数；“免费复用”、固定成本排序、每台可承载多少 Session 均无测量支持。创建参数、平台上限、实际 guest 限额、有效吞吐必须分开。
- **A 的 suspend 风险方向合理，但条件需保留**：进程冻结时本地 timer 不执行；是否实际进入 suspend、各调度器如何补跑，不能统一宣称已经实测。
- **B:3：无效日期 `2025-XX`。**Amp 引用需补可追溯日期与准确 URL，不能作为内部架构证据。
- **`processes.md:6–16`、`decisions.tsv:2–3`：作为过程记录 PASS。**它们明确是启动回执／待审状态，不证明研究结论正确，也不独立证明每个子进程遵守全部安全约束。本次未查子 transcript。
- **父级笔记总体纠偏正确。**本次独立核对支持其 checkpoint、审批占槽、E2B fallback、Modal 文档冲突及 Instabox 七天窗口判断；`provider-verification.md:8–12` 其余套餐与生命周期陈述未全部重查，仍应标作文档声明，而非账号验证。

## 推荐模型与下一道有限验证门

**推荐：Session 保持逻辑 Orb 亲和；Run／PTY／服务分别持有有期限的使用权；Orb 绑定可替换的 provider incarnation，并以 generation 阻断旧执行。先保留共享迁移路径，不强制七张新表。**

下一步须另获实施授权，先做**离线单一故障恢复探针**：fake provider 满额入队 → 授权响应丢失 → 协调者重启 → 取消与授权竞争 → generation 更换。通过标准：

1. 同一申请不重复创建／启动；
2. 旧 generation 不能接管新环境；
3. 结果未知不自动重放；
4. 等审批、PTY、后台进程不会被错误计为空闲；
5. Session 各入口保持一致路由。

通过后才申请有资源数、时长和费用上限的第二供应商探针。默认独占方向、恢复承诺、审批保留期限由 owner 决定。

**最高影响三点：消除“Session 或 Run”的伪二选一；撤销 Durable 禁止外部等待的错误前提；先明确恢复与秘密保留契约，再选供应商。**