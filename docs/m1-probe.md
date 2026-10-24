# M1-00 探针结果与 M1 设计修正

日期：2026-10-25（UTC+08；证据里的 ISO 时间为 UTC 2026-10-24）。

结果：**PASS，限本文列出的探针范围。可以继续 M1 实现，但必须先修正文末的执行身份、重放边界与绑定校验设计。** 本报告不代表 runner、工作区创建或 M1 端到端功能已经实现或验收。

## 1. 环境、证据与有效性

| 项目 | 实测配置 |
|---|---|
| 仓库提交 | `1c6fd44`，开始时已有 M1 计划与任务 brief 的未提交文档改动 |
| 本机 | macOS / arm64，Node `v24.21.0` |
| 正式 A 部分 | `pi-durable`、`pi-ai`、`chord` 均为 **1.4.0**；`fauxProvider`，临时 SQLite，无真实模型调用 |
| B 部分 | `@fly/sprites` **0.2.3**，真实 Sprites；Linux x86_64，用户 `sprite` |
| 执行身份 | B 只使用本次创建的 3 台 `pca-probe-*` 实例，均带 `app:pi-cloud-agents` 标签 |
| 密钥 | 从环境加载；未发送 GitHub token 到探针实例，输出经脱敏；文本证据另做真实值扫描 |

**先发现了本地依赖不一致**：`package.json` 和 lockfile 指定 1.4.0，但主工作目录 `node_modules` 的三个 Earendil 包实际都是 **1.0.4**。最初的 A 探针因此作废，不能拿来证明 1.4.0 的行为。已在新建的隔离目录安装 lockfile 版本，重新执行全部 A 项；没有修改主工作目录依赖，也没有修改产品源码。

证据与脚本：

- [A1–A6 脚本](../scratch/m1-probe-a.mjs)：启动前检查三包必须为 1.4.0；版本不符退出 2。
- [A1–A6 正式结果](../scratch/m1-probe-a-results.json)：含每轮 SIGKILL 记录、进程间持久状态、消息、断言与重跑记录。
- [B1–B6 脚本](../scratch/m1-probe-b.mjs) 与 [真实环境结果](../scratch/m1-probe-b-results.json)。
- [B4 最坏 URL 编码补充](../scratch/m1-probe-b-boundary.mjs)：纯本地假客户端，不联网。
- [证据校验与泄漏扫描](../scratch/m1-probe-verify.mjs)。
- [EGO 浏览器截图](acceptance/M1-00/01-environment-smoke.png)：只读观察已有部署；作用与限制见 §5。

## 2. A 部分：Pi Durable 与 SQLite

正式执行全量 A 探针两次，最终每次 **195 个断言通过、0 失败**；保留的 JSON 是最后一次完整结果。A2 每次全量包含 safe / unsafe 各 10 次真实子进程 SIGKILL，不用 `harness.close()` 代替崩溃。

| 编号 | 操作与实测 | 结论与影响 |
|---|---|---|
| A1 | 依次安装 `CodingTools` 与自定义同名 `bash`；模型看到一个自定义描述的 bash，执行得到 `CUSTOM:echo hi`。反序安装得到内置 `hi`。`wrapTool`、独立组合 read/write/edit/bash 两个对照也通过。 | **最后注册者生效**。M1-06 可以在 CodingTools 后注册 Exec，不必修改 pi-durable。这只证明覆盖机制，不等于可把所有会话的 shell 都标 safe。 |
| A2 | 已确认旧 progress 持久化后 SIGKILL，再从同一个 SQLite 重开。safe **10/10** 重入 execute，callId、taskId 均与原调用相同；unsafe **10/10** 不重入，生成 interrupted 错误并保留旧输出。 | **safe 的恢复入口成立，但副作用幂等必须自己实现**。仍需 runner 与命令记录。 |
| A3 | 同会话同 requestId：重启前提交两次，重启后再提交，随后用同编号提交不同内容。四次均返回同一 submission `9`，每阶段都是 1 条用户消息、1 条 assistant 消息，实际 faux 模型调用总计 1 次。 | 原生支持请求去重，跨重启有效。**同编号不同 input 内容会静默复用原消息**，应用层仍应比较 payload，冲突返回 409。不同 submission type 则会抛错。 |
| A4 | 工厂直接抛错 / 返回仅 exec 报错的 env，分别跑 bash、纯聊天、read，共 6 组。两种 bash 都形成可见 tool_error，模型可继续；两种纯聊天都完成。抛错工厂阻断 read；只封 exec 的 env 仍进入文件读取。 | 推荐未就绪时工厂直接抛明确错误。只封 exec 不是完整的执行环境门禁；若做 FailingEnv，全部文件方法也必须封住。工具错误不等于系统暂停，派发层仍需 readiness 检查。 |
| A5 | 一个子进程每 20 ms 在同一事务向两张表各写 4 行；另一个 DatabaseSync 在 WAL 写入期间做 5 次 backup。副本两表行数分别为 16、32、44、60、72；每次两表一致、键值核对正常、integrity_check=ok；每个副本 12,288 字节。 | `node:sqlite` **提供 backup()，此并发写入样本下 5/5 一致**。不需要把复制 SQLite/WAL 文件作为备份方案。不是多库或 Git 文件的一致性保证。 |
| A6 | 真正通过 BotRegistry.createBot({cwd}) 建会话，传入不存在目录，对照 NodeExecutionEnv 和注入假 bash 的 SandboxEnv。全部 EnvTarget.cwd 原样保留路径；bash 缺目录报错；NodeExecutionEnv 的 write 自动建父目录并成功。 | cwd 是透传配置，**不是就绪验证或只读边界**。必须显式检查 workspace 状态、绑定和实际仓库。假 SandboxEnv 用来证明调用传递与错误处理，未模拟真实 Sprite 文件系统。 |

### A2 的额外发现：需要先改计划

**执行编号会碰撞。** 在同一个会话中连续两轮都用 `callId = c1`，实测两个工具任务为：

```text
conversationId=2, callId=c1, taskId=13
conversationId=2, callId=c1, taskId=17
```

现计划的 `runIdFor(conversationId, callId)` 会把两条不同命令当成同一条。应使用持久的应用/存储命名空间加 **taskId** 生成执行编号。命名空间需要随控制数据备份恢复；从备份启动新执行代际时再单独管理 generation，避免误接不属于该代际的旧命令。不能每次服务重启都随机换命名空间，也不能跨独立库裸用 taskId。

**safe 恢复跳过 beforeTool。** 10 次 safe 样本中，beforeTool 都仅在崩溃前调用一次，恢复 execute 时不再经过它。原 hook 写入的 `initialBinding={version:1}` memo 保留；重启时尝试给同 key 写 version 2，仍返回首次的 version 1。由此可用 memo 固定初次命令意图，但必须在 **execute 内、每次远端操作前**比较当前运行绑定。只在审批 hook 或 env 工厂里找“当前实例”不够。

**旧 progress 被清空。** 重启 resume 前能读到 `first:0\nfirst:1\n`；safe execute 入口的 retainedOutput 已为空，第一份新 progress 只有 `second:0\n`；最终结果严格只有三行 second 输出。本探针工具 return `{}`，结果完全来自 api.output，没有用返回文本掩盖旧输出。runner 接回命令后应从日志偏移 **0** 给这次工具重放输出，不能直接从“上次已给 UI 的 offset”继续，否则最终工具结果缺开头。

**safe 不会让任意 shell 自动变得幂等。** safe 样本故意在 execute 里追加记录，恢复后记录确实追加了第二次；这正是 safe 的重入行为。M1-06 里“无 runner 则退回 api.env.exec”的旧共享会话路径不能沿用同一个 safe 声明，应保留内置 unsafe bash，或为 legacy 会话选择单独的工具策略。

## 3. B 部分：真实 Sprites

本轮起止：`2026-10-24T17:32:45.876Z` 至 `17:33:31.504Z`，即本地 2026-10-25 01:32–01:33。创建前 `pca-probe-` 列表为空，同时实例最多为 3。

| 编号 | 操作与实测 | 结论与影响 |
|---|---|---|
| B1 | 连续创建 3 台，均传 labels 与 waitForCapacity=true。创建返回耗时 **551 / 445 / 531 ms**；创建响应、get、list 都能读到标签。同名再创建返回 APIError、**statusCode=409**；get 不存在与 delete 不存在均 **statusCode=404**。 | 可用确定性名字找回，供应商原生重名创建不幂等，删除不存在也不幂等；适配器补齐。错误字段是 statusCode / errorCode，不能只认 status / code。本次未遇容量不足，不能据此承诺 waitForCapacity 的排队行为。 |
| B2 | 新镜像为 Linux x86_64；uid/gid 1001，HOME=/home/sprite。setsid、flock、git、gh、node、base64、sha256sum、tar、perl、dash 和 /proc/stat、boot_id 均可用。gh、node 路径分别为 /.sprite/bin/gh、/.sprite/bin/node。 | runner 的 Linux 实现依赖可用；init 应先探测 gh/node，再决定安装，不能照旧记录认定缺少 gh。 |
| B3 | setsid 后台运行 sh+sleep，stdin/stdout/stderr 脱离 exec，原 exec 返回并关闭后，两次新 exec 均看见原进程。PID/PGID/SID=12，boot_id 一致，startTicks=9692 稳定。对 PGID 发 TERM 后组内无进程，后续 done 文件未产生。另一个脱离连接的 3 秒命令写出 done。 | **脱离 exec 的后台执行与进程组取消成立**，可采用 setsid + 重定向 + 身份核对。只证明这组父子进程；不能承诺能取消自行 setsid/daemonize 逃出的子进程。 |
| B4 | 20/40 KiB 原始随机二进制，分别形成 27,308 / 54,616 字符 base64，经 exec 传入后 SHA-256 全匹配；20/40 KiB 长的 base64 参数也通过。stdout 48 KiB / 200 KiB 本轮完整，哈希一致。12 KiB 原始数据往返 **5/5** 一致。 | **保留 12 KiB 原始数据分块**。本轮大数据成功不推翻历史的大输出丢失记录，也不能扩大通用 argv 上限。见下方最坏编码补充。 |
| B5 | 同时有 3 台 Sprite，各在相同路径 /tmp/pca-own-marker 写入 sprite-1 / 2 / 3，分别读回自己的内容；3/3 正常。 | 3 实例的创建与独立执行可用。没有创建第 4 台、没有探测耗尽配额，不能得出账户最大容量。也没有验证并发端口/预览隔离。 |
| B6 | 新实例默认网络策略 rules=[]，GitHub 返回 200。应用现有 allowlist + 尾部 deny=* 后，策略读回一致；GitHub 与 npm 均 200，example.com 为 000。结束前恢复原策略，再读回 rules=[]。 | 新实例可用现有网络策略接口。000 单独只说明 curl 失败；结合成功应用的策略与允许站点对照，本轮符合阻断预期，不推论所有网络协议。 |

### B4 最坏 URL 编码补充

使用全 `0xff` 数据形成大量 `/` 的 base64，纯本地假 client 记录是否到达 spawn，不发送网络请求。实测：

| 原始数据 | base64 长度 | 包装 exec 的 URL 编码字符数 | 结果 |
|---|---:|---:|---|
| 12 KiB | 16,384 | 小于 64,000 | 通过长度检查，到达假 spawn |
| 20 KiB | 27,308 | **82,099** | SPRITES_COMMAND_TOO_LARGE，未到 spawn |
| 40 KiB | 54,616 | **164,023** | SPRITES_COMMAND_TOO_LARGE，未到 spawn |

所以不能给 runner 设计“任意长 cmd/env 直接放一个 --cmd-b64 参数”。应先按安全大小分块上传命令描述，完成校验与原子发布后，start 只传执行编号/描述引用。环境密钥不允许因此落进描述文件；GitHub 凭据继续由供应商 exec 环境注入，不能写入 cmd、meta 或检查点。

### 资源清理

本次创建的名字：

```text
pca-probe-1792863165876-a4d9-1
pca-probe-1792863165876-a4d9-2
pca-probe-1792863165876-a4d9-3
```

删除前逐一核对“本次精确名字 + 前缀 + 应用标签”，**3/3 删除成功**。结束查询以及随后独立的 `--check` 查询均返回 `pca-probe-` **空列表**。没有修改旧共享 Sprite `pi-cloud-agents`、Fly app 配置或原有用户数据。

## 4. 需要修改 M1-PLAN 的地方

以下是**待应用的修改清单**，本任务没有修改 `docs/M1-PLAN.md` 或各 brief。

| 优先级 | 当前位置 / 相关任务 | 建议修改 |
|---|---|---|
| 必改 | §3.3、§4.4；M1-04/06 | 将 `runIdFor(conversationId, callId)` 改成基于持久 namespace + taskId；同命令还需保存 command hash、cwd、bindingVersion。原编号方案已被重复 callId 样本证伪。 |
| 必改 | §4.5；M1-05/06/10 | 初次 execute 发出命令前，用 memo 固定 `{runId, provider, runtimeId, bindingVersion, cwd, commandHash}`。恢复时必须先比对绑定，再查询原命令；不匹配进入“结果待确认”，绝不对新实例 start。当前 M1-10 指望在新实例上得到 missing 不够，因为 start 本身会把 missing 变成新命令。 |
| 必改 | §4.5；M1-06/13 | managed 工作区才选用 runner-backed safe bash；legacy 会话保留 unsafe 内置 bash。不得保留“safe 工具找不到 resolver 就直接 env.exec”的回退。缺少应有的 runner 是错误，不是回退条件。 |
| 必改 | §4.4/4.5；M1-04/06 | 规定恢复工具输出从日志 offset=0 重放；UI 展示状态与 runner 日志偏移分别管理。新协议的命令/大数据先分块上传、校验，再启动，保留 12 KiB 原始块大小。 |
| 必改 | §3.2、§4.5/4.6；M1-05/07/13 | 未就绪时 env 工厂直接抛明确错误；同时在派发层禁止开始该需求。启动顺序应是：控制库与绑定/解析器可读 → Harness.open(resume:false) → 核对未完成动作 → 开调度。当前 openHarness 默认立即 resume，必须避免先恢复工具后装绑定解析器。 |
| 应改 | §2 AC04.2、§4.1/4.6/4.8；M1-01/07/08 | 原生 requestId 去重已验证；新增相同编号的 payload 指纹校验。相同内容返回原结果，不同内容 409，不能静默当新指令丢掉。初始任务提交直接用确定性 requestId，不用“会话里已有任意消息”推断已提交。 |
| 应改 | §4.3；M1-03 | 以 statusCode=404 判不存在，409 后 get 并核对归属；字段兼容 errorCode。创建响应只表示对象创建成功，不等同 exec-ready。init 检查 gh/node 已存在；label 是可读取并用于归属检查的条件。资源 release 的重复删除可将404视为已不存在，但不得对其他状态直接删除或重建。 |
| 应改 | §4.4；M1-04 | runner 支持范围明确为 Linux + setsid + /proc，进程身份核对 boot_id 与 startTicks；本机 macOS 测试使用假 transport / Linux 实测，不必为了本机 /proc 缺失加入另一套生产进程身份实现。 |
| 应改 | §4.1/4.4；M1-01/04/06 | 增加最小 Execution 记录与明确的 prepare/start/query 边界。只有目录存在就不启动，存在“写描述后、真正启动前崩溃”的窗口，不能据此宣称恰好一次。需要原子认领、命令 hash 比较、prepared/starting/running/unknown 状态；不确定是否启动过时不得自动重跑。此项是从实测重放行为推出的设计缺口，未实现验证。 |
| 应改 | §4.5；M1-06 | 写明 user abort / timeout 要终止进程组，控制服务崩溃/重连只接回；审批与 binding 再校验必须位于安全重放路径可到达的位置。取消后的退出码持久化仍是实现验收项，本探针只证实能向进程组送达信号。 |
| 应改 | §8 与实施前提；M1-00/13 | 加依赖版本门禁，以实际安装包为准，并在1.4.0下跑测试。不要基于当前工作目录旧依赖的 .d.ts 定1.4.0契约。 |

本次没有要求增加新供应商、OAuth、完整终端或更多产品范围；上述更改用于让已批准的最小核心流程成立。

## 5. 自动化、浏览器与限制

- 正式 A：195/195 断言，0 失败；safe / unsafe 各 10 次 SIGKILL，全量最终跑两次均通过。
- 后端回归：隔离的 1.4.0 副本执行 `TARSBOT_NO_DOTENV=1 npm test`，**164/164 PASS**。主工作目录仍是旧依赖，不能把它描述为“主目录直接跑全绿”。
- B：六项均有真实观察，传输哈希和清理记录校验通过；3 台创建、3 台删除、0 残留。
- EGO：按本地已安装的 ego-browser 技能使用指南操作现有 `https://pi.zilin.im`，查看已登录的会话列表、原会话、Environment 面板，截图保存到 `docs/acceptance/M1-00/01-environment-smoke.png`。没有发送消息、创建 Bot 或触发远端命令，TaskSpace 已关闭。**只读烟测 PASS；不是新功能端到端验收。**
- 未新增/修改产品界面，因此未做前端构建和回归。未启动读取真实 data/ 的本地 server。
- 未注入容量耗尽、暂停/重启整台 Sprite、账号撤销或网络重连；没有完整 runner 可测，未完成90秒命令中的控制服务 SIGKILL 实测。这些属于后续 M1-04/06/14。
- backup 仅验证单个 SQLite；alice/control/auth/bots.json 的跨文件一致备份仍需后续停调度或备份清单方案。
- 后续真实模型测试按用户2026-10-25约定仅使用 SWE-2、GLM 5.3 或 GPT-6.1-sol；本次探针没有调用这三者或其他真实模型。GPT-6.1-sol 的网关 ID 尚未核实。
- EGO 提示版本可更新（当前0.6.0.16）；未升级。

## 6. 失败、修正与重跑记录

保留失败原因，不将探针脚本错误算成产品测试通过：

1. 最初在主工作目录 1.0.4 下跑 A，随后发现版本不匹配；该轮无效。正式脚本新增版本门禁，在旧依赖上运行已证实退出2。
2. 临时安装先遇到固定目录删除被自动审批拒绝，改用 mktemp 新目录；npm --prefix 调用报项目选择错误，进入该新目录后 npm ci 成功。未删除既有目录、未改项目依赖文件。
3. A 脚本修正了 ESM 包版本定位、1.4.0 output 字段、异步 conversation handle、snapshot 入口与模型工具观察方式。首次 A2 因探针 snapshot 入口错误超时，修正后重跑。
4. A2 大 JSON 输出曾在 process.exit 前未 flush，改成等 stdout 写完；随后完整全量两次均195/195。
5. A5 最初高速写入样本导致备份快速增大；改成20ms节流，正式5轮副本一致且仅12KiB，子进程与该用例临时数据均清理。
6. 后端回归首次163通过/1失败：隔离副本缺 scripts/set-password.mjs fixture，复制该文件后164/164。正式结果保留两轮摘要。
7. B1–B6 无探针异常；409、404与允许/拒绝网络请求是预期观察。B4 最坏编码的本地错误为预期保护测试，没有对远端重复发送大命令。

## 7. 重现

A 脚本要求模块解析到1.4.0；本次通过“复制 package.json、lockfile、src、scripts、test、探针到新临时目录，再 npm ci --ignore-scripts”建立隔离副本。在匹配依赖的仓库/副本根目录运行：

```bash
TARSBOT_NO_DOTENV=1 node scratch/m1-probe-a.mjs
```

B 会产生真实费用和资源；只执行本脚本创建的3台，自动清理。只读复核使用 --check：

```bash
node --env-file=.env scratch/m1-probe-b.mjs --check
```

完整 B：

```bash
node --env-file=.env scratch/m1-probe-b.mjs
```

最坏 URL 编码保护（纯本地）：

```bash
TARSBOT_NO_DOTENV=1 node scratch/m1-probe-b-boundary.mjs
```

证据校验与文本泄漏扫描（只报告命中计数，不打印值）：

```bash
node --env-file=.env scratch/m1-probe-verify.mjs
```
