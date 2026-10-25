# M2-03：围栏——Exec 与 env 的写锁校验

依赖：M2-02（`store.locks`）。**与 M2-07 共改 `src/ext/exec.mjs`，本任务先做，M2-07 在其后。**

先读：`docs/M2-PLAN.md` §3.1；`src/ext/exec.mjs`（意图 memo 的固定、绑定核对、`wait` 循环、`handleAbort`）；`src/workspace-env.mjs`（env 工厂、`SandboxEnv` 的 `bash` 原语）；`src/env.mjs`（哪些方法写、哪些只读——**逐个看，不要凭印象**）；`docs/m1-probe.md` 的 A2（安全重放会跳过 `beforeTool`，所以权威检查必须在 `execute` 与 env 里）；`src/control/store.mjs` 的 `locks.assertHolder`（M2-02 产出）。

## 你只能创建/修改
- `src/ext/exec.mjs`
- `src/workspace-env.mjs`
- `test/exec.test.mjs`、`test/workspace-env.test.mjs`

## 持有者身份
一个会话对应一个持有者：`{ kind: "conversation", id: String(conversationId) }`。**工作区没有锁行或锁空闲时，第一个写入者自动取得锁**（`store.locks.acquire`，本任务做）；围栏拒绝"被别人持有"和"已被接管"。判定规则：

| `assertHolder` 的结果 | 写入 |
|---|---|
| 本会话持有，且 `epoch` 与固定时一致 | 允许 |
| 锁空闲（`released` / `no-lock`） | **先 `store.locks.acquire` 取得锁再允许**（"谁先写谁拿锁"）；取不到（并发被别人抢先）→ 拒绝 |
| 别人持有（`other-holder`）或 `epoch` 已变（`taken-over`） | 拒绝 |

**自动取锁就在这里做**，不要等路由：Exec 的 `execute` 和 env 的写类调用都是"第一次写"必经的地方，并且都能拿到 `store`。这样 `src/api.mjs` 不需要任何改动。取得锁之后，把取得的 `epoch` 作为 `lockEpoch` 固定进 memo。

**共享文件规则**见 `docs/M2-PLAN.md` §8.1（精确小编辑，只在自己负责的区域改，发现冲突写进汇报）。

## 要求
### Exec
1. 把 `lockEpoch`（固定时刻的当前 `epoch`；无锁行时为 `null`）加入 memo 固定的意图，与现有的绑定核对放在同一位置。**memo 里已有的字段与顺序不变**（M1 的重放测试依赖它们）。
2. 在固定意图之后、`prepare` 之前核对：被拒绝 → 以「结果待确认」之外的**明确拒绝**结束：`isError`，诊断码 `lock_lost`，文案说明"工作区已被 X 接管 / 由其他会话写入"，**不 prepare、不 start、不 kill**。
3. `wait` 循环里每轮复查。发现自己已被接管（`taken-over` / `other-holder`）→ 请求 `runner.kill`（带确认），随后以诊断码 `lock_lost` 结束，文案区分「已停止」与「停止待确认」。复查必须很便宜（同步读库）。
4. 重放（崩溃后重入）时使用 memo 里的 `lockEpoch` 与当前对比：若期间被接管 → `lock_lost`，且**不重新启动**。

### env 工厂
5. `createWorkspaceEnv` 返回的 `SandboxEnv` 所用 `bash` 原语外包一层：**写类**远端调用前核对持有者，被拒绝则抛 `Error("工作区已被接管：…")`；**读类**调用（读文件、列目录、`stat`、`exists`、`watch` 轮询）不核对。先在 `src/env.mjs` 里逐个方法确认哪些是读、哪些是写——如果同一个原语承载了读和写，需要在包装层按命令内容判断，则改为在 `SandboxEnv` 构造参数里新增 `guard`（读写两个入口）并在 `src/env.mjs` 中调用；`src/env.mjs` 不在你的可改清单里，所以**优先用不改它的做法**，做不到就在汇报里说明并停下，由编排者决定。
6. 包装层的开销：一次同步读库；不做网络调用。

### 不做
- 不实现接管、交还与路由（M2-04）；不改 `db.mjs` / `store.mjs`。自动取锁用的是 M2-02 已提供的 `store.locks.acquire`。
- 不处理 `beforeTool`（它在安全重放时被跳过，所以只能作为提示，不属于围栏）。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。
- **FT-M2-1（各 ≥10 次）**：持有者在 `prepare` 与 `start` 之间被接管 → 命令不启动；`start` 之后被接管 → `runner.kill` 被调用、结果 `lock_lost`、旧持有者随后的 `write`/`bash` 全部被拒；崩溃重放时发现已被接管 → 不重启。
- 必测：无锁时第一次写入取得锁（`epoch` 递增、`holder` 为该会话），第二个会话随后写入被拒；两个会话几乎同时首次写入只有一个成功；别人持有时拒绝且**假 runner 的调用记录里没有 prepare/start**；`epoch` 变化被检出；读类调用在被接管后仍可用；`lockEpoch` 进入 memo 且重放读回原值；M1 的全部 Exec 用例保持通过；env 包装对写拒绝、对读放行；输出与错误里没有令牌。
- 不连网、不用真实 Sprite。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项（尤其：已在途的一次远端调用无法撤回）。
