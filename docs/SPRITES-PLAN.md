# TARSBot × Sprites（shell 模式）方案

分支：`feat/sprites-shell`（worktree：`/Users/zilin/side/tarsbot-sprites`，不影响 `main`）。

## 1. 目标与定位

在本地 macOS 运行 Pi Durable（TARSBot server），把 Bot 的执行环境换成远端 Fly.io Sprite，跑通"拉取分支 → 修改 → 测试 → 提交 PR"的写代码流程。

定位：这是 TARSBot 的**另一种执行环境**（shell 型 Bot），不是转型为编码 agent。桌面型 Bot（Cua Space）仍是主线；本分支验证"便宜、可暂停、可 checkpoint 的 shell 执行层"。

```
本地 macOS                                   Fly.io
┌────────────────────────────┐   HTTPS/WSS   ┌──────────────────────────┐
│ TARSBot server (Pi Durable)│ ────────────▶ │ Sprite（Ubuntu 25.10）   │
│  - 模型调用、对话持久化     │  exec / fs    │  ~/workspace/<repo>      │
│  - 审批、定时例程           │               │  git / gh / 构建工具     │
│  - SpritesEnv（ExecutionEnv）│              │                          │
└────────────────────────────┘               └──────────┬───────────────┘
                                                        │ git push / gh pr create
                                                        ▼
                                                     GitHub
```

## 2. 架构改动

现状：`src/env.mjs` 的 `CuaEnv` 把全部文件系统和 shell 操作归约为一个原语
`bash(command, {timeoutMs}) -> {stdout, stderr, exitCode, timedOut}`（默认实现 `spaceBash`，走 Cua Space）。
因此接入 Sprites 只需替换这个原语，Pi Durable 一侧不变。

| 改动 | 内容 |
|---|---|
| `src/sandbox/sprites.mjs`（新增） | `spritesBash(command, {timeoutMs})`：基于 `@fly/sprites` 的 WebSocket `exec`；断线/唤醒时重连并重试一次（语义对齐 `withSpace`） |
| `src/env.mjs` | `defaultBash` 按 `TARSBOT_SANDBOX`（`cua` 默认 / `sprites`）选择原语；`DEFAULT_HOME` 可配置（Sprite 为 `/home/sprite`） |
| `src/config.mjs` | 新增 `sandbox`、`spriteName`；`spaceCwd` 在 sprites 模式下为 `/home/sprite/workspace` |
| `src/runtime.mjs` | sprites 模式下不安装 `Desktop` 扩展 |
| `src/ext/preamble.mjs` | sprites 模式下加入 git/PR 工作流说明（见 §5） |
| `src/ext/approval.mjs` | 普通 `git push` 与 `gh pr create` 不再需要审批；改为只拦截破坏已有 PR / 代码的操作（见 §4.4） |
| `src/routes/space.mjs` / 前端 | sprites 模式下 `/api/space` 返回 `{sandbox:"sprites", name}`，右栏不显示桌面 |
| `scripts/sprite-setup.sh`（新增） | 幂等初始化 Sprite（见 §4.3） |
| `test/sprites.test.mjs`（新增） | `spritesBash` 单测（注入假客户端，离线） |

依赖：`@fly/sprites`（精确锁定 `0.2.3`），要求 **Node ≥ 24**，本分支 `engines` 改为 `>=24`。
不用 SDK 的 `execFileHTTP`：其 README 说明 HTTP exec 帧无长度前缀，大输出可能错位。

## 3. 配置（`.env`，不提交）

| 变量 | 用途 |
|---|---|
| `TOKEN_ROUTER_BASE_URL` / `TOKEN_ROUTER_API_KEY` / `EXA_API_KEY` | 同 main |
| `TARSBOT_SANDBOX=sprites` | 切换执行环境 |
| `SPRITES_TOKEN` | Sprites API token（sprites.dev/account） |
| `TARSBOT_SPRITE_NAME` | 目标 Sprite 名，如 `tarsbot-dev` |
| `GITHUB_TOKEN` | GitHub fine-grained PAT（见 §4）；exec 时以 `GH_TOKEN` 注入 Sprite |
| `TARSBOT_GH_REPO` | 测试仓库 `git@github.com:hifizz/tars-sandbox-playground.git`；Sprite 内用 https 形式 `https://github.com/hifizz/tars-sandbox-playground.git`（token 认证，不放 SSH 私钥） |
| `TARSBOT_GIT_EMAIL` | Sprite 内 git 提交邮箱（GitHub noreply 地址），`sprite-setup.sh` 使用 |
| `TARSBOT_SPRITE_IDLE_MS` | 最后一次 exec 后保活多久（默认 5 分钟，见 S4-keepalive） |
| `TARSBOT_PORT` / `TARSBOT_VIEWER_PORT` | 本分支默认已改为 8090 / 3309（Vite dev 5183），与 main 的 8080 / 3299 / 5173 错开，可同时运行；一般无需设置 |

所有密钥只在本地 server 进程环境中；禁止打印、写日志、写入 sqlite 或测试快照。

## 4. GitHub 层

### 4.1 凭证

**MVP：fine-grained PAT**
- Repository access：仅测试仓库 `hifizz/tars-sandbox-playground`（不使用 `hifizz/tars`）。
- Permissions：Contents = Read and write，Pull requests = Read and write，Metadata = Read（自动）。
- 过期时间：7 天。
- 不使用本机 `gh` 登录的 `gho_` token（作用于账号下全部仓库）。

**正式：GitHub App**
- App 安装到指定仓库；TARSBot 在本地用 App 私钥为每个任务签发 installation token（1 小时过期）。
- PR 作者显示为 `tarsbot[bot]`；泄露影响限于 1 小时、单仓库。

### 4.2 凭证注入方式

- token **不写入 Sprite 磁盘**。`spritesBash` 每次 exec 时通过 env 传入 `GH_TOKEN`。
- Sprite 内 git 凭证助手从环境变量读取：
  ```bash
  git config --global credential.https://github.com.helper \
    '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
  ```
- `gh` CLI 直接读取 `GH_TOKEN` 环境变量，无需 `gh auth login`。
- 结果：Bot 的命令能用 token，但 token 不会出现在 Sprite 文件、bash 历史或对话记录里（Bot 主动 `echo $GH_TOKEN` 仍可读到——这是沙箱模型的固有边界，靠 §4.4 的约束兜底）。

### 4.3 Sprite 初始化（`scripts/sprite-setup.sh`，幂等）

1. 若 Sprite 不存在则创建（`TARSBOT_SPRITE_NAME`）。
2. 安装 `gh`（Ubuntu 25.10 已带 git、Node、Python）。
3. 写入上面的 credential helper；设置 `git config --global user.name "TARSBot"`、`user.email`（使用 GitHub noreply 地址）。
4. `mkdir -p /home/sprite/workspace`。
5. 设置 network policy：出站仅放行 `github.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`，以及 npm / PyPI 镜像。
6. 创建 checkpoint `v-setup`，便于随时回到干净环境。

### 4.4 约束

- 不需要审批：普通 `git push`（推送新分支或快进已有分支）、`gh pr create`、`gh pr comment`、`gh pr edit`。
- 需要人工批准（破坏已有 PR 或代码）：
  - 改写远端历史：`git push --force` / `-f` / `--force-with-lease` / `--force-if-includes`、`+refspec`；
  - 删除远端分支或标签：`git push --delete` / `-d`、`git push origin :<ref>`、`--mirror`、`--prune`；
  - 直接推送到受保护的基线分支：命令中显式出现 `main` / `master` / `dev` 作为目标；
  - `gh pr merge`、`gh pr close`、`gh repo delete`、`gh repo edit`、`gh release delete`；
  - `gh api` 写操作（`-X POST/PUT/PATCH/DELETE`、`-f`/`-F`/`--input`）。
- 审批规则无法识别"`git push` 不带参数、但上游是 `dev`"的情况。测试仓库决定**不开启分支保护**（2026-10-13，均为测试代码），因此这类推送没有服务端兜底，只靠 preamble 约束 Bot 只推 `tarsbot/*` 分支。Bot 不能合并 PR（`gh pr merge` 需审批）。
- PR 描述末尾固定注明 "Opened by TARSBot"。

### 4.5 进阶（L2 之后再做）

沙箱内完全不放 token：Bot 只在 Sprite 内 commit；本地 TARSBot 用 `git bundle` 拉回提交，由本地 push 并 `gh pr create`。最安全，但需要额外的工具与审批流。

## 5. Bot 工作流（写入 preamble）

1. `cd ~/workspace`；仓库不存在则 `git clone https://github.com/<owner>/<repo>.git`，存在则 `git fetch origin`。
2. `git checkout <base>` 并 `git pull --ff-only`；新建 `tarsbot/<简短描述>` 分支。
3. 修改代码；运行仓库的测试/lint 命令（先读 README / package.json 确定命令）。
4. `git commit`（信息说明改动目的）。
5. `git push -u origin <branch>`（只推自己的 `tarsbot/*` 分支，不带 `--force`）。
6. `gh pr create --base <base> --fill` 或带标题/正文；回复 PR 链接。
7. 失败时报告具体命令与输出，不重复无效尝试。需要 force push 或修改他人分支时，先说明原因，等待审批。

## 6. 验收标准

使用测试仓库 `hifizz/tars-sandbox-playground`。

| 级别 | 内容 | 验证 |
|---|---|---|
| L0 连通 | `SpritesEnv` 在 Sprite 内实现 read / write / edit / bash | `TARSBOT_SANDBOX=sprites npm run test:env` 全绿；`npm test`（离线）全绿 |
| L1 Bot 操作 shell | UI 中让 Bot 在 Sprite 建 `~/workspace/hello.txt` | `sprite exec cat /home/sprite/workspace/hello.txt` 可见 |
| L2 PR 流程 | 一句指令："在 tars-sandbox-playground 的 `dev` 分支上把 X 改成 Y，跑测试，提交 PR"。Bot 自主完成 §5 全流程，push 与开 PR 不出现审批；中途要求它 force push 时出现审批条 | Bot 回复 PR 链接；`gh pr view <n>` 可见；diff 符合预期；CI 通过 |
| L3 持久性 | ① clone 后、push 前 `kill -9` server，重启后任务续上；② Sprite 暂停后唤醒，任务继续 | 只产生一个 PR、无重复 commit；`grep` `data/` 与 `logs/` 找不到任何 token 原文 |

L2 证明"能像编码 agent 一样工作"；L3 证明 Pi Durable 的差异化价值。

## 7. 实施步骤

1. 本分支切 Node 24（`engines`、README），`npm install @fly/sprites@0.2.3 --save-exact`。
2. 实现 `src/sandbox/sprites.mjs` + 单测；`env.mjs`/`config.mjs` 接入开关 → **L0**。
3. `runtime.mjs` 按模式移除 `Desktop`；`/api/space` 与前端右栏降级 → **L1**。
4. `scripts/sprite-setup.sh`、preamble 工作流、审批规则 → **L2**。
5. Tasks API 保活（Bot 运行期间注册 task，`run_end` 时释放）、kill 测试 → **L3**。

## 8. 风险与待验证

| 项 | 说明 |
|---|---|
| 暂停与长命令 | Sprite 空闲约 30s 暂停，TCP 连接断开。Bot 运行期间需 Tasks API 保活；未验证 WebSocket exec 在长命令（如 `npm install`）期间是否计为活动 |
| exec 超时上限 | Sprites 单条 exec 的最长时长未查到，需实测 |
| network policy 粒度 | 是否支持按域名放行、能否覆盖包镜像，需实测 |
| Node 24 兼容 | pi-durable、`@trycua/cua`、vitest 在 Node 24 下是否正常，需在 L0 时跑全量测试确认 |
| 成本 | Sprites 按秒计费（约 $0.0385/CPU·h、$0.021875/GB·h），空闲不计算费；以 Fly 定价页为准 |
| 凭证可读 | Bot 能执行 bash 就能读取 `GH_TOKEN`；靠最小权限 PAT、短有效期、network policy、审批共同控制 |

## 9. 开工前需要准备（U1 检查结果，2026-10-13）

| # | 项 | 状态 |
|---|---|---|
| 1 | `SPRITES_TOKEN` | ✅ 有效（org `stack-fizz`，`GET /v1/sprites` 200）。Sprite `tarsbot-dev` 尚不存在，由 S0-probe / S3-setup 创建。org 下已有 7 个其他项目的 Sprite，所有脚本只能操作 `TARSBOT_SPRITE_NAME` |
| 2 | `TARSBOT_GIT_EMAIL=noreply@tarsbot.com` | ✅ 已写入 `.env` |
| 3 | `GITHUB_TOKEN` 权限 | ✅ 已重新签发：fine-grained PAT，私有仓库仅 `tars-sandbox-playground` 可见；可 push 测试仓库，push `hifizz/tars` 返回 403；可读 PR 与 Actions。⚠️ 过期时间 2026-11-12（约 30 天，方案建议 7 天） |
| 4 | 测试仓库内容 | ✅ 已推送 tarsbot 当前已提交的代码（`3157db0`，3 个提交）到 `main` 与 `dev`；未包含本分支未提交改动与 `docs/SPRITES-PLAN.md` 等未跟踪文件。推送前确认历史中无 `.env` 密钥 |
| 5 | 分支保护 | ➖ 不配置（测试代码，用户决定）。风险见 §4.4 |
| 6 | 本机 Node | ✅ 当前 `v24.21.0`（S0-node24 仍需改 `engines`、`.nvmrc`，安装 SDK） |

## 10. 任务拆分

任务文件在 `docs/tasks/S*.md`，格式与 `B*` 任务一致（先读 / 只能改的文件 / 要求 / 验收），可直接交给 `tarsbot-worker`。

| 任务 | 内容 | 依赖 | 主要文件 | 达成 |
|---|---|---|---|---|
| U1（人工） | ✅ 已完成（见 §9） | — | — | — |
| [S0-node24](tasks/S0-node24.md) | 切 Node 24，安装 `@fly/sprites@0.2.3` | — | `package.json`、`.nvmrc` | — |
| [S0-probe](tasks/S0-probe.md) | 实测 SDK API、大输出、长命令、暂停/唤醒、保活、network policy、checkpoint | S0-node24、U1 | `scratch/sprite-probe.mjs`、`docs/sprites-probe.md` | — |
| [S1-bash](tasks/S1-bash.md) | `spritesBash` 原语 + 离线单测 | S0-probe | `src/sandbox/sprites.mjs` | — |
| [S1-env](tasks/S1-env.md) | `TARSBOT_SANDBOX` 开关、home/cwd/id 可配置、conformance 双模式 | S1-bash 接口 | `src/config.mjs`、`src/env.mjs` | L0 |
| [S2-runtime-ui](tasks/S2-runtime-ui.md) | sprites 模式去掉 Desktop、`/api/space` 与右栏降级 | S1-env | `src/runtime.mjs`、`src/routes/space.mjs`、`web/` | L1 |
| [S3-setup](tasks/S3-setup.md) | 幂等初始化 Sprite | S0-probe | `scripts/sprite-setup.sh` | — |
| [S3-approval](tasks/S3-approval.md) | 放行普通 push 与开 PR；拦截 force push、删分支、推基线分支、merge/close、`gh api` 写操作 | — | `src/ext/approval.mjs` | — |
| [S3-preamble](tasks/S3-preamble.md) | sprites 模式系统提示 + PR 工作流（含恢复时的幂等检查） | S1-env | `src/ext/preamble.mjs` | — |
| [S3-pr-e2e](tasks/S3-pr-e2e.md) | 端到端 PR 流程验收脚本 | S2、S3-* | `scripts/pr-e2e.sh` | L2 |
| [S4-keepalive](tasks/S4-keepalive.md) | 活动租约保活（替代 §7 中的 `run_end` 方案，不碰 harness） | S1-bash、S0-probe | `src/sandbox/sprites.mjs` | — |
| [S4-recovery](tasks/S4-recovery.md) | kill -9 / 审批挂起 / Sprite 暂停 / 泄漏检查 | S3-pr-e2e、S4-keepalive | `scripts/sprites-kill-test.sh` | L3 |

执行顺序（同一行可并行）：

1. U1 · S0-node24 · S3-approval
2. S0-probe
3. S1-bash · S1-env · S3-setup
4. S2-runtime-ui · S3-preamble · S4-keepalive
5. S3-pr-e2e
6. S4-recovery

同一时间不能有两个任务修改同一文件：S1-bash 与 S4-keepalive 都改 `src/sandbox/sprites.mjs`，S4-keepalive 必须在 S1-bash 合入后开始。`src/runtime.mjs` 只有 S2-runtime-ui 修改。
