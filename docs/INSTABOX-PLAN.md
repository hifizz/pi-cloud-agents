# 第三种沙箱：InstaBox（Spec）

> 起草：2026-10-25，在独立 worktree（分支 `feat/instabox-sandbox`）完成。目标：在不改 `SandboxEnv` 的前提下接入
> InstaBox（<https://instabox.sh>，REST API，无 SDK 依赖），用 `TARSBOT_SANDBOX=instabox` 选择。线上仍默认
> Sprites，本轮**不部署、不改 Fly 配置**。

## 1. 决策

| # | 决策 |
|---|---|
| I-D1 | 选择方式：`TARSBOT_SANDBOX=sprites`（默认）\| `e2b` \| `instabox`。其他值启动即抛错。Fly 不设该变量 → 线上不变 |
| I-D2 | 与 Sprite/E2B 一样是**一个常驻、所有 Bot 共用**的 machine：名字 `TARSBOT_INSTABOX_NAME`（默认 `pi-cloud-agents`），创建时打 label `app=pi-cloud-agents` |
| I-D3 | 不引入官方 TS SDK，直接用 `fetch` 调 REST（端点少、Node ≥ 24 自带 fetch；避免新依赖）。API 形状以 `GET https://api.instabox.sh/v1/openapi.json` 为真相（文档页与实际 API 有出入，见 §3），operation 包装防御式解析 |
| I-D4 | 运行时只"查找"machine（`GET /v1/machines/{name}` 一次，缓存 id），不创建：找不到报 `INSTABOX_SANDBOX_MISSING`，提示 `node scripts/instabox-setup.mjs`。创建与初始化只在 setup 脚本（与 E2B 一致） |
| I-D5 | 持久化 = `/data` 磁盘 + 空闲 autoSuspend（free plan 固定 30 分钟）。exec 对 suspended/stopped 的 machine 一律 `409 machine_not_running`（P10/P9 实测；文档页"自动唤醒"不实）→ provider 自动 `POST /start`（对 suspended 是 resume、对 stopped 是冷启，文件都在）+ 轮询 operation，成功后重试一次 exec；`409 operation_conflict`（如 idle-suspend 在途）→ `POST /wake` 等待后重试 |
| I-D6 | exec 是同步 HTTP：`POST /v1/machines/{id}/exec {cmd, cwd, envs, timeoutSeconds}` → `{stdout, stderr, exitCode, timedOut, truncated, signal?}`。平台用 `bash -lc <cmd>` 以 guest user（`user`）执行，默认 cwd `/data/home`，`timeoutSeconds` 1..600（超时 kill，`exitCode=124`），`cmd` 上限 **64 KiB**（provider 有快速失败守卫；env.mjs 按 12 KiB 分块写入不受影响）。命令包装与 e2b 相同：`exec /bin/sh -c '<single-quoted>'` |
| I-D7 | `GH_TOKEN` 只经每条命令的 `envs` 传入，不写盘；git credential helper 与 Sprite/E2B 相同（setup 脚本配置） |
| I-D8 | 家目录 `/data/home`（`~` 解析到它），工作目录 `/data/home/workspace`；env id `instabox:<name>` |
| I-D9 | 重试策略与 E2B 同形：只有**确定命令未开始**的失败（resolve 失败、exec 前置网络错误 ECONNREFUSED/ENOTFOUND/EAI_AGAIN、exec 404/409）重试一次；请求已发出后的传输失败 / 5xx / 客户端超时 → `INSTABOX_CONNECTION_ENDED`（"may or may not have run"），不重试 |
| I-D10 | 2026-10-25 已用真实 key 完成：探测 14/14 PASS、setup 全 OK、Bot 在 InstaBox 真跑 bash（见 §7）。free plan 限制：5 个沙箱、只能用 `agent-browser` 模板、每分钟 3 次 start |

## 2. 环境变量

| 变量 | 说明 |
|---|---|
| `INSTABOX_API_KEY` | 密钥（instabox.sh 控制台创建）；不打印、不写日志 |
| `INSTABOX_BASE_URL` | 可选，默认 `https://api.instabox.sh`（测试/探测用） |
| `TARSBOT_SANDBOX` | `instabox` 时启用；shell 变量优先于 `.env` |
| `TARSBOT_INSTABOX_NAME` | machine 名，默认 `pi-cloud-agents`（setup 脚本要求精确等于它） |
| `TARSBOT_INSTABOX_TEMPLATE_ID` | 可选，创建时用的模板 id；默认选 `agent-browser`（free plan 唯一允许，实测自带 git 2.47 / gh 2.102 / node 22 / python3 / jq） |
| `TARSBOT_INSTABOX_AUTO_SUSPEND_SEC` | 可选，创建时的 `autoSuspendAfterSeconds`；free plan 无论设多少都是 30 分钟空闲 suspend |
| `TARSBOT_INSTABOX_LOG` | 设 1 时向 stderr 打每条命令的 `{commandLength, ms, exitCode, retries, outcome, woke, truncated}`（无命令/输出内容） |

## 3. API 事实（OpenAPI 实测核对 + 真实探测，P* 编号对应 scratch/instabox-probe.mjs，2026-10-25 全部 PASS）

真相来源：`GET https://api.instabox.sh/v1/openapi.json`（文档页 <https://instabox.sh/docs> 与实际 API 有多处出入）。

- 鉴权：`X-API-Key: ibk_...` 头（P1 前所有请求隐式验证）；错误体 `{"error":{"code","message","requestId",...}}`，code 枚举含 `not_found` / `machine_not_running` / `operation_conflict` / `quota_exceeded` 等（P9/P10/P12 实测）。
- `GET /v1/machines/{idOrName}`：按 **id 或名字**取 machine（P2）；不存在 404 `not_found`（P12）。machine 带 `metadata`（字符串标签，创建时设置）、`state`、`guestUser`、`template`。
- `POST /v1/machines` `{name, templateId, metadata, autoSuspendAfterSeconds?}` + `Idempotency-Key` → **202 裸 Operation** `{id, machineId, type, state, error, ...}`；`GET /v1/operations/{id}?wait=25s` 长轮询，终态 `succeeded|failed`，成功带 `machine`（P1）。⚠️ 文档页写的 `template: "universal"` 会被拒（`unknown template`）：实际字段是 `templateId`，且 free plan 只允许 `agent-browser`（`403 template_not_allowed`）。
- `POST /v1/machines/{id}/start|stop|suspend|resume` + `Idempotency-Key` → 202 Operation（P9/P10）。`start` 对 suspended 是 **resume**（带回内存中的进程；带不回则冷启，文件保留），对 stopped 是冷启。`POST /wake`（无 Idempotency-Key）用于等在途的 idle-suspend + 自动恢复。
- `POST /v1/machines/{id}/exec` `{cmd, cwd, envs, stdin?, timeoutSeconds}`（无需 Idempotency-Key）→ 200 `{stdout, stderr, exitCode, timedOut, truncated, signal?}`；stdout/stderr 各截断 1 MiB；`cmd` ≤ 64 KiB；超时 kill 且 `exitCode=124`（P6）。**suspended 和 stopped 的 machine 一律 409 `machine_not_running`，exec 不会自动唤醒**（P10，文档页所述"paused 自动唤醒"与实测不符）——provider 的 start 兜底路径即为此设计（P10b 验证 start 恢复 suspended 后 exec 正常）。
- `GET /v1/machines/{id}/files?path=`：读文件/列目录（P8；provider 暂不使用，文件操作全走 bash）。
- free plan 限制（实测）：org 最多 5 个沙箱（`quota_exceeded`）、每分钟 3 次 start（`slow_down` 类错误，等 60 s 重试即可）、只能用 agent-browser 模板。agent-browser 模板自带 git/gh/node/npm/python3/curl/jq（setup 实测无需安装）。

## 4. 模块契约

### 4.1 `src/sandbox/instabox.mjs`

```js
// 底层 client（setup 脚本与探测共用）：call/getMachine/listMachines/createMachine/startMachine/deleteMachine/exec/waitOperation
export function instaboxApi({ fetchImpl = fetch, apiKey, baseUrl }) 
export async function waitOperation(client, ref, { timeoutMs, pollHttpMs })   // -> 终态 operation
export async function findInstaboxMachine({ fetchImpl, apiKey, baseUrl, name }) // -> machine | null
// 可注入、离线可测
export function createInstaboxBash({ fetchImpl, apiKey, baseUrl, name, env, secrets, defaultTimeoutMs, cwd, log, retryDelayMs, startTimeoutMs })
export async function instaboxBash(command, { timeoutMs })   // 生产实例：读 process.env
export function getInstaboxInfo()                            // { sandbox: "instabox", name }，不含密钥
export { instaboxBash as bash, getInstaboxInfo as info }
```

错误码：`INSTABOX_CONFIG`（缺 key）/ `INSTABOX_SANDBOX_MISSING`（machine 不存在，提示 setup）/ `INSTABOX_CONNECT_FAILED`（重试后仍连不上）/ `INSTABOX_CONNECTION_ENDED`（请求已发出，结果未知）/ `INSTABOX_START_FAILED`（唤醒失败）/ `INSTABOX_OPERATION_TIMEOUT`。错误消息中密钥与命令文本一律替换/隐藏，超长截断。

### 4.2 `scripts/instabox-setup.mjs`

`node --env-file=.env scripts/instabox-setup.mjs [--recreate|--delete|--no-init]`。幂等：找名字精确等于 `pi-cloud-agents` 的 machine；存在且无我们的 metadata → 拒绝操作；删除路径要求**名字 + metadata `app=pi-cloud-agents`** 双验证。创建用 `templateId`（默认 `agent-browser`，`TARSBOT_INSTABOX_TEMPLATE_ID` 可覆盖）。初始化：workspace、工具盘点（缺则尽力 `sudo -n apt-get` 安装；agent-browser 模板实测全齐）、git 身份 + credential helper、自检 exec、marker 文件。注意 free plan 每分钟 3 次 start：紧跟探测脚本之后跑可能报 `sandbox start limit reached`，等一分钟重跑即可（幂等）。

## 5. 登记

- `src/config.mjs`：`SANDBOX_KINDS` 加入 `instabox`；`sandboxSettings` 返回 `{sandbox, sandboxName, spriteName: undefined, home: "/data/home", spaceCwd: "/data/home/workspace"}`。
- `src/sandbox/index.mjs`：`SANDBOXES` 加入 `instabox`。
- `src/ext/preamble.mjs`：instabox profile（提示工具可能缺失，先 `command -v` 确认）。
- `web/src/types.ts`、`SessionHeader`、`EnvironmentPane`、`ComposerContext`：显示 "InstaBox" / "IB"。

## 6. 规则（红线）

- InstaBox 远端只操作：名字 `pi-cloud-agents`（或 `TARSBOT_INSTABOX_NAME` 精确值）且 label `app=pi-cloud-agents` 的 machine，以及探测脚本自建的 `pca-probe-*`（结束必须删除）。账户里其他 machine 一律不动。
- setup 的 `--recreate/--delete` 在删除前双验证（名字 + label），验证不过直接 FAIL 退出。

## 7. 验收状态

- 后端 `TARSBOT_NO_DOTENV=1 npm test`：196 通过（`test/instabox.test.mjs` 29 个，含 wake/64 KiB 守卫路径）。
- 前端 `npm run typecheck`、`npm test`（96）、`npm run build`：通过。
- **真实 InstaBox 探测（2026-10-25，临时 key）**：`scratch/instabox-probe.mjs` 14/14 PASS（自建 `pca-probe-*` 已清理）。
- **真实 setup**：`pi-cloud-agents`（id `m_agqw6y6o6xdga33z553nhaltiy`，agent-browser 模板）创建 + 初始化 6 步全 OK。
- **端到端**：`TARSBOT_SANDBOX=instabox` 起 server，UI 给 tars bot 发任务，Bot 经 InstaBox exec 返回 `Linux 6.18.54-instabox /data/home/workspace ...`；截图 `docs/acceptance/instabox-ui/05-live-bot-exec.png`。
- 沙箱唤醒路径（suspended → exec 409 → start → 重试）由离线测试 + P10b 实测共同覆盖；线上自动 suspend（30 分钟空闲）后的第一条命令会多花约 6 s（start 恢复）。
- **真实开源 PR 全流程（2026-10-25 追加）**：swe-2 在 `hifizz/jev-readability` 自主定位并修复真实 bug、测试全绿、push 分支并创建 [PR #1](https://github.com/hifizz/jev-readability/pull/1)；审批流拦下了 `gh api` 写请求与一次 `title=test` 占位 PR（拒绝后 bot 按规范停下汇报，符合设计）。截图见 `docs/acceptance/instabox-ui/09-oss-pr-created.png`。

## 8. 已知事项（真实运行发现，后续处理）

1. **GitHub git 认证**：GitHub 已不接受 PAT 作为 git HTTPS 密码，setup 配置的 `credential.helper`（echo password=$GH_TOKEN）对 push 无效；有效路径是 `gh auth setup-git`（gh 用 `GH_TOKEN`）或 GitHub App installation token / SSH。setup 脚本应改为 `gh auth setup-git`（待改）。
2. **`.env` 的 GITHUB_TOKEN 是只读 fine-grained PAT**：API 写操作一律 `403 Resource not accessible by personal access token`。需要 Bot 推代码时须换 `contents:write` 的凭据（本轮验收临时借用 thread-chatbot 的 GitHub App `tc-workbench-acceptance` 铸 1 小时 token，用后即删）。
3. **审批规则误报**：`curl -s -D -`（dump 响应头）会被 "curl/wget --data" 规则误判为改远端状态而进审批；可考虑收窄匹配（待议）。
