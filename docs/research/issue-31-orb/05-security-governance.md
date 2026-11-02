# Slice E 报告：安全、隔离与资源治理

> **存档说明：本文件保留子任务原始报告，尚未应用复核纠正。** 原文的 PASS 仅表示调研任务完成，不表示已实测或设计获批。checkpoint 不保证排除秘密；正则不是强隔离；当前等待审批仍占 Loop 槽。 请以[最终综合报告](07-synthesis.md)为结论，并参照[独立复核](06-independent-review.md)。研究基线为 `9faf7c685dfda3f68fdede64a93721416ad99992`，执行模型为 `magpie/auto/swe-2`，推理强度 `high`。

**状态：PASS**（仅源码/证据文件检查，未跑实测、未触网、未读凭据）
**基线**：`9faf7c685dfda3f68fdede64a93721416ad99992`（`/tmp/pca-orb-research-RKFAus/source`）
**方法**：通读 auth、approval、exec、loops、provider、env-config、delegation、terminal/files/git-view/preview、checkpoint、server 组装路径与 issue 20/22、issue-31 讨论稿。

## 1. 当前边界（代码事实）

| 边界 | 事实 | 证据 |
|---|---|---|
| 认证 | 白名单邮箱 + scrypt 密码（限流 5 次/15min）或 Google OAuth+PKCE；session cookie HttpOnly/SameSite=Lax，token 只存 sha256；`AUTH_DISABLED` 在非 loopback 启动即抛错 | `src/auth.mjs`、`src/routes/auth.mjs:87-105` |
| 授权粒度 | 单租户：登录即全部权限。**无 per-user 角色、无 per-session API 权限**；`editPolicy: members/admins/owner` 字段已存但未被任何路由消费 | `src/loops/store.mjs:184` |
| 审批 | `beforeTool` 钩子按正则分类 bash + `send_*`/`deploy*`/`mcp__*` 工具名；verdict 写 durable memo（first-write-wins），重启不重复问。正则对引号、变量、`bash -c`、间接调用不可见——代码注释自认 | `src/ext/approval.mjs:35-50` |
| 机器凭证入口 | loop webhook Bearer（scrypt hash）或 Standard-Webhooks HMAC；GitHub webhook X-Hub-Signature-256；均在全局 guard 内验证，429 限流 | `src/loops/webhook.mjs`、`src/routes/loops.mjs:215-270` |
| Loop 权限降级 | 真实强制而非提示：`code=none` 无 bash/read/write；`code=read` 无 bash/write；`web=false` 移除 web_search；`GH_TOKEN=""` 经 supportsEnv 原语按会话剥离；`gh`/`git push/fetch`/`curl github.com` 硬阻断（人也不能批准绕过）；GitHub 写只能走 `send_github_*`（服务端 token、每次调用都审批、scopeToTrigger 默认限定触发实体、capabilities 在 enqueue 时快照） | `src/loops/runner.mjs:46-79`、`src/loops/tools.mjs`、`src/server.mjs:134-158` |
| 委派 | 深度 ≤2、子数 ≤10、结果缓存 ≤20；子会话独立 worktree/分支但**同一台 Sprite、同一凭据域**（仅去掉 preamble + 文本规则）；loop-run/只读会话禁止委派 | `src/routes/delegation.mjs`、`src/delegation-env.mjs` |
| Fork | 仅允许 `readOnly:true` fork（写锁未实现），继承 workspace link | `src/routes/fork.mjs` |
| 终端 | 命令控制台复用同一危险分类器（deny 即拒，不排队审批）；**PTY 是原始字节流、无法逐命令审批**，对 loopRun/readOnly 会话禁用 | `src/terminal-env.mjs:14-17,161` |
| 文件/Git/预览 | 路径均服务端解析（bot 记录的 dir，非客户端），符号链接/`.env`/`.git`/凭据名被拒；预览 cap = HMAC 绑定（ws, runtimeId, port）15min，rebuild 即失效，响应加 CSP sandbox 不透明源 | `src/files-env.mjs`、`src/git-view-env.mjs`、`src/preview-env.mjs` |
| 资源归属 | `isManaged` = `pca-` 前缀 + `app:pi-cloud-agents` 标签；`release`/`pty` 先过守卫；`ensure` 只在明确 404 后创建；rebuild 不删旧机器（M1 无自动 release） | `src/providers/sprites.mjs` |
| 并发/预算 | 唯一资源上限：`TARSBOT_LOOPS_MAX_CONCURRENCY` 默认 3（全局 FIFO），webhook/GitHub 事件有限流。**无：session 级 exec 并发上限、CPU/内存/磁盘准入控制、运行次数/费用预算、Sprite 台数上限（代码内）、worktree 清理路径** | `src/loops/queue.mjs`、`src/config.mjs` |
| 凭据 | `GH_TOKEN` 走 stdin bootstrap（不进 URL/argv/磁盘），但 git credential helper 写 `~/.gitconfig` 对整台 Sprite 全局生效；`SPRITES_TOKEN`（管理面）留在主进程；用户变量 AES-GCM 加密存 control.sqlite，受限会话拿不到 | `src/sandbox/sprites.mjs`、`src/providers/sprites-init.mjs`、`src/env-config.mjs` |
| 检查点 | git bundle 只含 git 对象，`.gitignore` 文件（.env 等）不进 bundle；服务端按 ws 分目录、sha256 校验 | `src/checkpoint.mjs` |

## 2. 威胁/权限矩阵（当前模型）

| 主体 | 能获得什么 | 现有防线 | 残余风险 |
|---|---|---|---|
| 登录用户 | 一切：任意 session 的 bash/PTY/文件/审批决定/委派/换模型/env 变量 | 单租户白名单 | 无内部 RBAC；委派 `contextPaths` 可达 ws 内任意非保护文件 |
| 普通 Bot 会话 | 同 Sprite 全部：GH_TOKEN、credential helper、其他会话 worktree/进程/端口、runner 目录 | 审批扩展（正则级）、preamble 文本 | 提示注入即可用凭据 push 任意可达仓库；正则绕得过间接命令；`auto` 审批策略一键解除 |
| Loop run 会话 | 按 capabilities 裁剪的工具面 + 无 GH_TOKEN 的 shell | 硬阻断 + 审批 + 快照 | 仍是同 Sprite 进程：可读其他会话目录、`~/.gitconfig`、kill 他人进程（无 OS 级隔离） |
| webhook 调用方 | 触发 enqueue（payload 进 prompt，标注不可信） | HMAC/Bearer + 限流 + dedup | payload 是提示注入面，靠能力裁剪兜底 |
| Sprite 内任意进程 | 同上 | Sprite 级 DNS 白名单 | 单机内无边界（这是既定语义，非缺陷） |

## 3. 对 issue 20/22 的校准

**Issue 20 仍然成立**：同 Sprite = 同信任域、无写锁、exec 无并发上限，均经新 SHA 复核确认。**已失效/部分失效**：

- 「凭据 per-session 注入不可行」→ **已实现**：`createSpritesBash.supportsEnv` + stdin bootstrap，loop 会话已按会话剥离 GH_TOKEN（`src/server.mjs:134`）；但 credential helper 常驻 `~/.gitconfig` 仍未变，**非 loop 会话仍全局持凭据**——加固只做了一半。
- 「委派/预览开发中」→ 已合入并带防护（路径包含、cap 绑定）。
- 「#14 FIFO/recovery 缺口」→ 部分补齐：cancel 有 abort+grace 语义、restore 有 `isRunSessionLive` 探针；但**「run 等审批时仍占槽」语义未落地**：`needs_approval` 在 `LOOP_RUN_ACTIVE`（`src/control/db.mjs:23`），代码注释未说明审批挂起的 run 的槽位/超时行为。

**Issue 22 仍未实现**（其自述）：`capabilities.tools[].autoApprove` 字段已解析但**无人消费**（grep 仅命中注释），每日次数上限、per-tool 审批白名单均不存在。

## 4. Orb 模型下的必要控制（建议）

| 控制 | 最小实现 | 理由 |
|---|---|---|
| per-Orb/Run 权限快照 | 沿用 enqueue 时 capabilities 快照模式，扩到 Orb 绑定：`{provider, size, caps, leaseTtl, maxRuns}` 入 run payload | 已验证模式，编辑不扩权旧 run |
| 递归 fanout 上限 | delegation 已有 MAX_DEPTH=2/MAX_CHILDREN=10；Orb 场景须加**全局并发 Orb 数上限 + 创建速率限制 + 每 run 最多申请 N 台 Lease**；子会话不得继承「创建 Orb」能力，除非快照显式授予 | 否则一个被注入的会话可递归烧机器 |
| 机器归属守卫 | `isManaged` 模式推广为 `{provider, name→label}` 映射表；**provider.bash 本身也应校验 isManaged**（当前只 pty/release 校验，bash 不校验——delegation/file 路径靠 server 端 dir 控制兜底，Orb 时代 runtimeId 来源更多，需在原语层加闸） | `src/providers/sprites.mjs:106` 现无校验 |
| 凭据最小化 | 沿用 stdin bootstrap 模式 per-call 注入；Orb 默认**不带** GH_TOKEN/credential helper，GitHub 写走服务端 scoped tool；`SPRITES_TOKEN` 类管理凭据永不下放 Orb | issue 20 推荐的单点加固已有一半先例 |
| 不可信代码/setup | repo setup 脚本、`.pca` 类用户脚本、依赖安装应默认在 `code=none`/`read` 级或低权限 Orb 预检后执行；`capabilities` 增加 `setup: untrusted|trusted` | 仓库内容是攻击面 |
| 预算/排队语义 | 定义**队列态**而非抢占：`waiting_resource` 显式状态；额度耗尽时入队/拒绝并如实显示，**不承诺免费**（费用未知不显示免费，issue 22 原话）；先次数上限后费用上限（同 issue 22 建议） | 防 runaway 且可观测 |
| 取消语义统一 | 已有 cancel=abort+grace+terminal 守卫，推广到 Lease：`cancel run → revoke lease → 确认 Orb 进程组退出或标 lost`；审批挂起的 run 明确是否占槽（建议：不占 exec 槽但保留 lease，带审批超时） | 当前 cancel 只到 session 级 |
| 快照/secret 保留 | checkpoint 已不存 .env；Orb 快照须明文承诺：env 变量、credential helper、runner 状态不进快照；snapshot 保留期与删除即删机写进契约 | 对齐 Amp 口径 |

## 5. 非保证项（必须写明）

- 审批正则不是沙箱：间接命令、变量、包装脚本可绕过；它防"明显危险"，不防"有意的注入"。
- 同 Sprite 共享凭据域在任何 worktree/委派/fork 组合下成立——除非每 Orb 一机且默认无凭据。
- durable memo 的审批 verdict 不防"同一危险操作换个 taskId 再问一次"。
- PTY 原始字节流永不可能有逐命令审批，只能按会话级门控。
- `auto` 审批策略存在，Orb 高危 run 应强制 `ask`（当前无此约束——新增建议）。

## 6. 产品决策（owner 定）

1. 「同工作区=同信任域」是否继续作为默认（影响是否每 Orb 一机）。
2. Orb 创建能力是否允许 agent 自助申请（建议：人申请/loop 快照申请，agent 只能提议）。
3. 额度维度：并发台数 + 每日 run 次数先做；费用上限待有真实定价来源。
4. 受限 run 的 Orb 是否可降级为更小规格/无网络。
5. 审批等待期间的 lease 计费/回收策略。

## 7. 最小验证测试（离线可跑）

1. `isManaged` 绕过：构造非 pca 名 runtimeId 调 provider.bash（应拒，目前会过——先写失败测试再修）。
2. capabilities 快照：enqueue 后编辑 loop 放宽权限，旧 run 仍按快照执行（已有模式，补断言）。
3. 委派子会话尝试创建孙 Orb：应 409。
4. 额度耗尽：fake provider 满额 → run 进入 `waiting_resource` 且不占 exec 槽。
5. loop 会话 `GH_TOKEN` 剥离：fake bash 断言 env 无 token；且 read `~/.gitconfig` 路径被 files/delegation 防护拒。
6. 快照脱敏：构造含 `.env.local`/`.pem` 的工作副本，checkpoint bundle 不含其内容（已有 ERE 规则，补端到端断言）。

## 三大结论

1. **权限模型已从「提示级」演进为「结构级」且方向正确**：capabilities 快照 + 工具白名单 + 按会话剥凭据 + 硬阻断 + 审批 memo，Orb 化应沿用同一套模式（快照权限、presence=capability、服务端持有凭据），而不是新造授权层。
2. **最大的真实缺口不是隔离而是治理**：无任何 exec 并发上限、无台数/次数/预算上限、无 `provider.bash` 的 isManaged 校验、无 `auto` 审批对受限 run 的禁用——这些是递归 fanout 与 runaway 的直接通道，先于多 provider 接入补齐成本最低。
3. **「共享信任域」在 Orb 模型下必须变成显式选择**：当前所有降级防护（loop/委派/fork/预览 cap）都在「同一台机器内」打转；只要默认独占 Orb + 默认无凭据，现有大部分防护面可从「必须拦截」退化为「纵深防御」，这是架构解耦最大的安全红利。