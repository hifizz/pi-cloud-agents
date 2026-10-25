# InstaBox 供应商（M1 形态）

> 2026-10-25。目标：把 InstaBox（<https://instabox.sh>）接入 M1 的供应商体系——**每个工作区一台机器**，与 Sprites
> 供应商同接口（`ensure/init/bash/status/list/release` + `isManaged`），用 `TARSBOT_PROVIDER=instabox` 选择。
> 本分支（`feat/instabox-provider-m1`，PR base `feat/m1-workspaces`）是 M1 之后的形态；M1 之前的共享单机 +
> `TARSBOT_SANDBOX` 形态见 `feat/instabox-provider` 分支（PR #7），两者的 exec 原语（`src/sandbox/instabox.mjs`）完全相同。

## 1. 决策

| # | 决策 |
|---|---|
| I-D1 | 选择方式：`TARSBOT_PROVIDER=sprites`（默认）\| `instabox`，决定**新工作区**的首选供应商；既有工作区永远跟随其绑定里记录的供应商（rebuild/re-prepare 亦然） |
| I-D2 | 不引入官方 TS SDK，直接用 `fetch` 调 REST（端点少、Node ≥ 24 自带 fetch；避免新依赖）。API 形状以 `GET https://api.instabox.sh/v1/openapi.json` 为真相（文档页与实际 API 有出入，见 §3） |
| I-D3 | 受管规则与 Sprites 完全一致：机器名 `pca-<sha256(requestId)[:10]>`，metadata `app=pi-cloud-agents`（+ `ws=<workspaceId>`）；`release` 前双重校验（名字 + 实读 metadata）；`ensure` 只在确切 404 后创建 |
| I-D4 | 持久化 = `/data` 磁盘 + 空闲 autoSuspend（free plan 固定 30 分钟）。exec 对 suspended/stopped 一律 `409 machine_not_running` → bash 原语自动 `POST /start`（对 suspended 是 resume、对 stopped 是冷启）+ 轮询 operation 后重试；`409 operation_conflict`（idle-suspend 在途）→ `POST /wake` 等待后重试。`status()` 因此把 suspended/stopped 都报 `available` |
| I-D5 | exec 是同步 HTTP：`POST /v1/machines/{id}/exec {cmd, cwd, envs, timeoutSeconds}` → `{stdout, stderr, exitCode, timedOut, truncated, signal?}`；`bash -lc`、guest 用户 `user`、默认 cwd `/data/home`、`timeoutSeconds` 1..600（超时 kill，exitCode=124）、`cmd` ≤ 64 KiB（原语有快速失败守卫）。命令包装 `exec /bin/sh -c '<single-quoted>'` |
| I-D6 | 初始化复用 `sprites-init.mjs` 的 `initCommon`（gh 探测/安装 + git 身份 + credential helper）；InstaBox 无网络策略 API，跳过该步骤（与 E2B 的 E-D7 同理）。`GH_TOKEN` 只经每条命令的 `envs` 传入，不写盘 |
| I-D7 | home `/data/home`（`~` 与工作区 cwd 的基准），env id `<provider>:<runtimeId>:v<version>`；workspace-env / workspaces / rebuild 均按绑定的供应商解析 home 与 bash |
| I-D8 | 重试策略与 E2B/Sprites 同形：只有**确定命令未开始**的失败（resolve 失败、exec 前置网络错误 ECONNREFUSED/ENOTFOUND/EAI_AGAIN、exec 404/409）重试一次；请求已发出后的传输失败 / 5xx / 客户端超时 → `INSTABOX_CONNECTION_ENDED`（"may or may not have run"），不重试 |
| I-D9 | free plan 限制（实测）：**一个 org 最多 5 台机器**（`quota_exceeded`）、每分钟 3 次 start、只能用 `agent-browser` 模板。多工作区部署需注意配额；`ensure` 的配额错误原样透传 |

## 2. 环境变量

| 变量 | 说明 |
|---|---|
| `INSTABOX_API_KEY` | 密钥（instabox.sh 控制台创建）；未配置时 instabox 供应商不注册。不打印、不写日志 |
| `TARSBOT_PROVIDER` | 新工作区的默认供应商：`sprites`（默认）\| `instabox` |
| `INSTABOX_BASE_URL` | 可选，默认 `https://api.instabox.sh`（测试/探测用） |
| `TARSBOT_INSTABOX_TEMPLATE_ID` | 可选，创建机器的模板；默认从 `GET /v1/templates` 选 `agent-browser`（free plan 唯一允许，实测自带 git/gh/node/python3/jq） |
| `TARSBOT_INSTABOX_NAME` | 永不受管的机器名补充（默认含 `pi-cloud-agents`） |
| `TARSBOT_INSTABOX_LOG` | 设 1 时向 stderr 打 `{op, ms, outcome, ...}`（无命令/输出内容） |

## 3. API 事实（OpenAPI 实测核对 + 真实探测，P* 对应 scratch/instabox-probe.mjs，2026-10-25 全部 PASS）

真相来源：`GET https://api.instabox.sh/v1/openapi.json`（文档页 <https://instabox.sh/docs> 与实际 API 有多处出入）。

- 鉴权：`X-API-Key: ibk_...` 头；错误体 `{"error":{"code","message","requestId",...}}`，code 枚举含 `not_found` / `machine_not_running` / `operation_conflict` / `quota_exceeded` 等。
- `GET /v1/machines/{idOrName}`：按 id 或名字取 machine；404 `not_found`。machine 带 `metadata`（字符串键值，创建时设置）、`state`、`guestUser`、`template`。
- `POST /v1/machines` `{name, templateId, metadata, autoSuspendAfterSeconds?}` + `Idempotency-Key` → 202 **裸 Operation** `{id, machineId, type, state, error, ...}`；`GET /v1/operations/{id}?wait=25s` 长轮询，终态 `succeeded|failed`，成功带 `machine`。⚠️ 文档页写的 `template: "universal"` 会被拒（`unknown template`）：实际字段是 `templateId`，free plan 只允许 `agent-browser`。
- `GET /v1/machines?metadata=app:pi-cloud-agents&cursor=&limit=`：按 metadata 键值过滤的分页列表（provider 的 `list()` 另做客户端侧名字/标签复核）。
- `POST /v1/machines/{id}/start|stop|suspend|resume` + `Idempotency-Key` → 202 Operation。`start` 对 suspended 是 **resume**（带回内存中的进程；带不回则冷启，文件保留），对 stopped 是冷启。`POST /wake`（无 Idempotency-Key）用于等在途的 idle-suspend + 自动恢复。
- `POST /v1/machines/{id}/exec` `{cmd, cwd, envs, stdin?, timeoutSeconds}`（无需 Idempotency-Key）→ 200 `{stdout, stderr, exitCode, timedOut, truncated, signal?}`；stdout/stderr 各截断 1 MiB；`cmd` ≤ 64 KiB；超时 kill 且 `exitCode=124`。**suspended 和 stopped 的机器一律 409 `machine_not_running`，exec 不会自动唤醒**（P10 实测；文档页所述 "paused 自动唤醒" 不实）——bash 原语的 start 兜底路径即为此设计。
- `GET /v1/machines/{id}/files?path=`：读文件/列目录（provider 暂不使用，文件操作全走 bash）。

## 4. 模块契约

### 4.1 `src/sandbox/instabox.mjs`（exec 原语，两分支共用）

```js
export function instaboxApi({ fetchImpl = fetch, apiKey, baseUrl })   // call/getMachine/listMachines/listTemplates/createMachine/startMachine/wake/deleteMachine/exec/waitOperation
export async function waitOperation(client, ref, { timeoutMs, pollHttpMs })
export async function findInstaboxMachine({ fetchImpl, apiKey, baseUrl, name }) // -> machine | null
export function createInstaboxBash({ fetchImpl, apiKey, baseUrl, name, env, secrets, defaultTimeoutMs, cwd, log, retryDelayMs, startTimeoutMs })
export async function instaboxBash(command, { timeoutMs })            // 生产单机形态（PR #7 分支使用）
export { instaboxBash as bash, getInstaboxInfo as info }
```

错误码：`INSTABOX_CONFIG` / `INSTABOX_SANDBOX_MISSING` / `INSTABOX_CONNECT_FAILED` / `INSTABOX_CONNECTION_ENDED` / `INSTABOX_START_FAILED` / `INSTABOX_OPERATION_TIMEOUT` / `INSTABOX_COMMAND_TOO_LARGE`。错误消息中密钥与命令文本一律替换/隐藏，超长截断。

### 4.2 `src/providers/instabox.mjs`（M1 供应商）

`createInstaboxProvider({ apiKey, baseUrl?, ghToken?, gitEmail?, templateId?, log?, fetchImpl? })` →
`{ kind: "instabox", home: "/data/home", runtimeName, isManaged, ensure, init, bash, status, list, release }`，
与 `createSpritesProvider` 同形（差异：无 cpus/ramMB 参数、metadata 代替 labels、init 无 network 步骤、status 把 suspended/stopped 视为 available）。

### 4.3 接线（对 M1 文件的最小改动）

- `src/server.mjs`：`INSTABOX_API_KEY` 存在时注册 `instabox` 供应商；`runnerFor(runtimeId, provider?)` 接受绑定解析出的供应商（Exec resolver 传入）；redact 列表加入 key。
- `src/workspaces.mjs` / `src/workspace-rebuild.mjs`：新增 `providerKind`（`TARSBOT_PROVIDER`，默认 sprites）选择默认供应商；home 按绑定的供应商解析（`provider.home ?? 默认`）。
- `src/providers/sprites-init.mjs`：抽出共享 `initCommon`（gh + git 步骤），`initSprite` 行为不变（+ network 步骤）。

## 5. 测试

- `test/instabox.test.mjs`（29 项）：exec 原语全行为（包装语义、超时、409 唤醒、404 重建重解析、网络错误分级重试、64 KiB 守卫、脱敏、日志形状）。
- `test/providers-instabox.test.mjs`（18 项）：供应商契约（命名/受管规则、ensure 幂等与疑义不建、409 确认、list 过滤、release 双重校验、bash 缓存与 GH_TOKEN 传递、init 幂等与脱敏、错误保形）。
- 全量 `TARSBOT_NO_DOTENV=1 npm test`：384 项 0 fail（`test/runner.test.mjs` 的计时用例在高负载下偶发抖动，与 InstaBox 改动无关，单独重跑稳定通过）。

## 6. 真实验证状态（2026-10-25，另一形态分支完成，原语完全相同）

- 探测 14/14 PASS（自建 `pca-probe-*` 自动清理）；setup、bot exec、swe-2 沙箱内编码、以及从沙箱内完成真实开源 PR（hifizz/jev-readability#1）——详见 `feat/instabox-provider` 分支的 `docs/acceptance/instabox-ui/`。
- **M1 形态（本分支）尚未做过真实端到端**（需要带 `INSTABOX_API_KEY` + `TARSBOT_PROVIDER=instabox` 起 server 建
  工作区跑一条任务）；离线测试已全绿。注意 free plan 5 台配额：实测 org 已占用 4 台（用户的 pi-agent/claude/devin/kiro）+ 1 台
  `pi-cloud-agents`（PR #7 验收时创建，可 `--delete` 或在控制台释放以腾配额）。

## 7. 规则（红线）

- InstaBox 远端只操作：`pca-` 前缀 **且** metadata `app=pi-cloud-agents` 的机器（即 `isManaged`），以及探测脚本自建的 `pca-probe-*`（结束必须删）。账户里其他机器（pi-agent/claude/devin/kiro 等）一律不动。
- `TARSBOT_INSTABOX_NAME` 指向的机器名永不受管。
