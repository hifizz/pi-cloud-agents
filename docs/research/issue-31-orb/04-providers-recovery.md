# Slice D 汇报：四家供应商能力与恢复语义

> **存档说明：本文件保留子任务原始报告，尚未应用复核纠正。** 原文的 PASS 仅表示调研任务完成，不表示已实测或设计获批。供应商适用性、内存恢复、幂等创建和跨云迁移存在过度概括，按综合报告及证据备注读取。 请以[最终综合报告](07-synthesis.md)为结论，并参照[独立复核](06-independent-review.md)。研究基线为 `9faf7c685dfda3f68fdede64a93721416ad99992`，执行模型为 `magpie/auto/swe-2`，推理强度 `high`。

**状态：PASS（切片完成）**。方法：源码快照（SHA `9faf7c685dfda3f68fdede64a93721416ad99992`）+ 官方文档检索（检索日期 2026-11-02），无真实账号调用、无实测。区分：代码事实（file:line）/ 文档声明（URL）/ 推断。

## 一、项目侧基线（代码事实）

- Provider 契约：`ensure/init/bash/status/list/release/pty/isManaged/runtimeName`；确定性名 `pca-<sha256(requestId)[:10]>`，`ensure` 仅在确切 404 后创建、409 视为并发已建（`src/providers/sprites.mjs:74-104`）。任何删除路径先过 `isManaged`（前缀 `pca-` + 标签 `app:pi-cloud-agents`）。
- 检查点（`src/checkpoint.mjs`）：`git bundle`，只含已跟踪 + 未忽略未跟踪文件；**不含** .gitignore 文件（node_modules、.env）、staged/unstaged 区分、子模块、空目录、**不含进程/内存/本地 DB 服务状态**。bundle 存服务器磁盘（≤20MB），重建 = 新机器 + clone baseCommit + apply + binding version+1；旧机器永不删除（`src/workspace-rebuild.mjs`）。
- Runner（`src/runner/runner.sh`）：`~/.pca` 文件协议，prepare→start 闩锁→ident（pid+pgid+boot_id+startTicks）。`claimed`/`lost`/`missing` **永不自动重启**，状态为「结果待确认」。服务器重启后可靠接回；**机器丢失则 run 全部丢失**（run 目录在机器磁盘上）。Exec 用 memo 固定 `{runtimeId, bindingVersion}`，重建后旧调用拒绝重放（`docs/CONTRACTS.md` §7）。
- Sprites 已测怪癖（`docs/sprites-probe.md`、`docs/m1-probe.md`）：exec URL 携带 argv+env（上限 ~64k 字符）→ 秘密值走 stdin bootstrap；启动即输出 >64KB 有概率全丢 → `sleep 0.1` 规避；exit -1 = 结果未知不可重试；`status` 字段（cold/running）在 exec 期间抖动，不可作存活判断；请求规格（4c/4G）被忽略实际 8c/8G；checkpoint 为纯文件系统快照、平台分配 id、restore 自动产生 `pre-restore` 快照；按域名出站白名单（DNS 层拦截）。

## 二、能力矩阵（文档声明，2026-11-02 检索）

| 维度 | Sprites | E2B | Instabox | Modal |
|---|---|---|---|---|
| 规格 | SDK `cpus/ramMB`（实测被忽略→8c/8G）；宣传上限 8CPU/16GB | 模板构建时 `cpuCount/memoryMB`；默认 2vCPU/512MiB；Hobby ≤8/8GiB | 按套餐：默认 4/8192，Pro≤8/16G，Builder≤16/32G，Team≤32/64G；停机可 PATCH 变档；盘 20GiB 可扩至 200G–1T | 每 sandbox `cpu`/`memoryMiB`（可分数）+limit；可选 GPU |
| 生命周期 | 平台管理 warm（内存冻结，~0.1–0.5s 醒）→cold（丢进程，1–2s）；磁盘永存 | 连续运行上限 1h(Hobby)/24h(Pro)；超时 kill 或 pause（`onTimeout`）；**暂停无限期保留** | 无 TTL；`autoSuspendAfterSeconds`（免费固定 30min）；`maxRunMinutes` 触发 pause + 5–20min 冷却期 | `timeout`≤24h + `idle_timeout`→**terminate**（无 pause）；默认 5min |
| 快照 | 文件系统 checkpoint（平台 id v1..vn），restore 原地覆盖、自动留 pre-restore 快照 | pause=内存+文件系统快照；`mode:"filesystem"` 可选仅盘；killed 不可恢复 | `POST /snapshots`（root+/data 盘，**不含内存**）；restore 原地保留 ID/URL；可从 snapshot 创建 | fs snapshot→Image（默认 30 天 TTL）；memory snapshot 实验性、**创建即终止原沙箱**、7 天过期；exit snapshot best-effort |
| exec | WSS spawn；argv+env 进 URL；kill 远端进程；exit -1 语义模糊 | `commands.run` 非零→`CommandExitError`；per-call `envs`；argv 单参 ~128KB；后台+按 pid 重连 | REST `/exec`（cmd/argv），`timeoutSeconds`≤600，stdin≤1MiB；**连接断开即杀进程组（文档明示）**；jobs API 后台任务 | `exec` 返回 ContainerProcess（stdin/stdout 流、timeoutMs）；进程独立存活于客户端 |
| PTY/预览 | `spawn(tty)`、tmux session；`proxyPort`；每 Sprite 域名网络策略 + URL auth | `pty.create` 可断线重连；`getHost(port)` 公网 URL（可限访问） | SSH/web terminal；公开/私有端口（token 鉴权，访问可唤醒 idle-pause 机） | `exec(pty)`；tunnels（TLS/裸 TCP）；`blockNetwork`+出站域名白名单 |
| 幂等 | 创建非幂等（409）；删除 404；需 ensure 模式 | `Sandbox.list(metadata)` 查找 = 事实去重 | **`Idempotency-Key` 头 + operations API**（queued/running/succeeded/failed） | 按 name/tags 查找；未见幂等键文档 |
| 计费 | 活跃时按秒 CPU/内存；存储 GB·h（休眠仅冷存储 ~$0.02/GB·月） | 运行按秒；暂停/停止不计费；盘含套餐 | 套餐月额度 + 磁盘 GiB·月（停机仍计） | 按秒计算；snapshot/Volumes 存储另计 |

来源：`docs.fly.io/sprites/{concepts/lifecycle,concepts/checkpoints}`、`fly.io/pricing`、`docs.e2b.dev/sandbox{/persistence,/auto-resume,/pty}`、`docs.e2b.dev/billing`、`instabox.sh/docs/{api/machines,api/lifecycle,api/commands,idle-suspend,limits,sdk}`、`modal.com/docs/guide/{sandboxes,sandbox-snapshots,sandbox-exit-snapshots,sandbox-spawn}`、`modal.com/docs/sdk/js/latest/Sandbox`。

## 三、恢复语义对照与集成含义

| 故障场景 | Sprites | E2B | Instabox | Modal |
|---|---|---|---|---|
| 我方 server 崩溃 | run 在机器上继续，runner 接回（已测 R1–R5 PASS） | 后台命令继续，connect 恢复 | exec 随连接死亡；jobs 存活 | 进程继续，可重连流 |
| 空闲暂停 | warm/cold 自动；cold 丢进程 | `onTimeout:pause` 保内存+盘 | suspend 保内存+进程；stop 仅保盘 | 无暂停，只能 snapshot 后重建 |
| 机器内原生恢复 | checkpoint restore（仅盘） | resume（内存+盘，最强） | resume（尽量保内存）/start（仅盘） | memory snapshot→新实例（原机死） |
| 跨供应商重建 | 我方 git-bundle + init 幂等（唯一通用路径） | 同 | 同 | 同 |

- **脏文件/未跟踪文件**：我方 bundle 已覆盖非忽略未跟踪文件 → 代码态可移植到任意供应商；`.gitignore` 内容（node_modules、.env）在四家里同样只能重装，属设计内损失。
- **本地 DB/后台服务**：SQLite 等数据文件若在仓库目录且未忽略可随 bundle 走；运行中的 DB/服务进程只有同机原生恢复（E2B resume、Instabox resume、Sprite warm）能保留；跨机重建一律丢，须靠幂等 setup 脚本重建。
- **丢失响应**：intents + 确定性命名已覆盖 Sprites；Instabox 的 Idempotency-Key+ops API 更强应优先用；E2B 用 metadata list 等价于 ensure；Modal 需 find-by-name 兜底。
- **exec 取消**：Instabox「断连即杀进程组」语义反而比 Sprites「may or may not have run」干净，但意味着 runner 仍是必需品（不能靠连接保活）；E2B 背景命令+pid 重连与 runner 模型接近。
- **stdin 秘密注入是 Sprites 特有**（env 进 URL）；E2B/Instabox envs 走请求体、Modal 走 exec 参数，不存在该泄漏通道，但各家错误信息是否回显 argv 需实测。
- **PTY/preview**：四方均有 PTY 与端口预览原语；我方 preview 用 bash+curl 转发本已供应商无关。

## 四、建议

**第二家供应商推荐 E2B**（条件性）：仓库内已有 E1 探测与 `docs/E2B-PLAN.md`/`e2b-probe.md` 实证（pause/resume 透明恢复、内存快照、per-call envs 不落盘），恢复语义最贴合 Orb「原机恢复」模型；PTY、preview URL、JS SDK 齐备。**否决项核查**：Hobby 1h 连续上限与 runner 长命令（timeoutMs 可超 10min）的组合需实测确认暂停不杀进行中命令。
**Instabox 为强备选**：生命周期 API 最完整（幂等键、ops、原地快照恢复、唤醒语义），但 SDK 仅 0.6.0、服务较新、exec 断连杀进程改变 runner 假设。**Modal 不适合工作区 Orb**：无暂停、磁盘临时、快照杀源机，仅适合无状态一次性 Run。
**被拒绝的替代**：直接把 Sprite checkpoint 当跨机迁移（平台绑定、无导出）；用 Modal memory snapshot 做工作区恢复（7 天 TTL + 杀源机）。

## 五、未决事实与最小探针（本次未执行）

1. E2B：运行中命令遇自动暂停/connect 恢复的确切行为（一次 create+`commands.run(sleep)`+onTimeout pause+connect）。
2. Instabox：auto-paused 机器上 `/exec` 是否内联唤醒成功；`envs` 是否出现在错误回显。
3. Modal JS SDK 固定版本的 `filesystem`/`env` 成熟度与 fs-snapshot 恢复延迟。
4. Sprites：`restart()`/cold wake 对 runner 进程的杀伤是否与 boot_id 核对一致（runner 已有防护，需一次真实验证）。

## 六、最高影响的三个结论

1. **E2B 是唯一「暂停即完整快照（内存+盘）且暂停无限期」的供应商**，与 Orb「同 Session 恢复原 Orb」的语义天然对齐，且已被本项目实测过一遍——作为第二家供应商证据最充分。
2. **跨供应商恢复只有一条路：我方 git-bundle 检查点 + 幂等 init/runner**。原生快照（Sprites checkpoint、Instabox snapshot、Modal image）全部只能同供应商同机或同账号内使用；Orb 抽象里「native restore」与「cross-provider rebuild」必须是两条显式契约。
3. **进程/内存态在任何跨机路径上都不可携带**，且 Modal 完全无暂停——Orb 的恢复承诺应分级声明：代码与未提交文件可保证；运行中进程、本地 DB 服务、runner run 只在同机原生恢复（E2B resume / Instabox resume / Sprite warm-cold 窗口内）才有希望。