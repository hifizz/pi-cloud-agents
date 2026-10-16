# 第二种沙箱：E2B（Spec）

> 起草：2026-10-16。目标：在不改 `SandboxEnv` 的前提下接入 E2B（`e2b` JS SDK 2.56.0，已精确锁定在 `package.json`），用 `TARSBOT_SANDBOX` 选择沙箱。线上仍默认 Sprites，本轮**不部署、不改 Fly 配置**。

## 1. 决策

| # | 决策 |
|---|---|
| E-D1 | 选择方式：`TARSBOT_SANDBOX=sprites`（默认）\| `e2b`。其他值启动即抛错。Fly 不设该变量 → 线上不变 |
| E-D2 | 与 Sprite 一样是**一个常驻、所有 Bot 共用**的沙箱：用 metadata `{ app: "pi-cloud-agents", name: <TARSBOT_E2B_NAME> }` 标识，`TARSBOT_E2B_NAME` 默认 `pi-cloud-agents` |
| E-D3 | 持久化靠 E2B pause：创建时 `lifecycle: { onTimeout: "pause" }`，空闲超时后自动暂停（保留文件系统与内存），下次 `bash()` 时用 `Sandbox.connect(id)` 恢复。不 kill，不每次新建 |
| E-D4 | 运行时只"查找"沙箱，不创建：找不到时报错 `E2B_SANDBOX_MISSING`，提示运行 `scripts/e2b-setup.sh`。创建与初始化只在 setup 脚本里做（与 Sprite 一致） |
| E-D5 | 模板 `TARSBOT_E2B_TEMPLATE`，默认 `base`；用户 `user`，HOME `/home/user`，工作目录 `/home/user/workspace`（E1 探测确认，不符时回报） |
| E-D6 | `GH_TOKEN` 只经每条命令的 `envs` 传入，不写入沙箱磁盘；git 用与 Sprite 相同的 credential helper（读 `$GH_TOKEN`） |
| E-D7 | 不做网络白名单（Sprite 有）；列为后续项 |

## 2. 环境变量

| 变量 | 说明 |
|---|---|
| `E2B_API_KEY` | 密钥，已在本地 `.env`；不打印、不写日志 |
| `TARSBOT_SANDBOX` | `sprites` \| `e2b`。注意本地 `.env` 里是 `sprites`；shell 中设置的值优先于 `.env`（`process.loadEnvFile` 不覆盖已有变量），所以本地用 `TARSBOT_SANDBOX=e2b npm start` 切换 |
| `TARSBOT_E2B_NAME` | 默认 `pi-cloud-agents` |
| `TARSBOT_E2B_TEMPLATE` | 默认 `base` |
| `TARSBOT_E2B_IDLE_MS` | 空闲多久后自动暂停，默认 `600000`（10 分钟） |

## 3. 模块契约

### 3.1 `src/sandbox/e2b.mjs`（E1）

与 `sprites.mjs` 同形：

```js
// 可注入、离线可测
export function createE2bBash({ Sandbox, apiKey, name, template, idleTimeoutMs, env, secrets, defaultTimeoutMs, cwd, log }) // -> bash(command, {timeoutMs})
// 查找 metadata 匹配的沙箱（running + paused），连接（必要时恢复）并返回 SDK Sandbox 实例；找不到返回 null
export async function findE2bSandbox({ Sandbox, apiKey, name, timeoutMs })
export async function e2bBash(command, { timeoutMs })   // 生产实例：读 process.env，懒加载 "e2b"
export function getE2bInfo()                            // { sandbox: "e2b", name }，不含任何密钥
export { e2bBash as bash, getE2bInfo as info }
```

`bash` 返回 `{ stdout, stderr, exitCode, timedOut }`：非零退出码是**结果**不是异常（SDK 会抛 `CommandExitError`，必须转换）；超时返回 `timedOut: true` 且远端进程被 kill；连接/恢复失败抛带 `code` 的错误（`E2B_CONFIG` / `E2B_SANDBOX_MISSING` / `E2B_CONNECT_FAILED` / `E2B_CONNECTION_ENDED`），错误信息中所有密钥值替换为 `***`。仅在命令确定未开始时重试一次。

### 3.2 `src/sandbox/index.mjs`（E2）

```js
export const SANDBOXES = ["sprites", "e2b"];
export async function loadSandbox(kind = config.sandbox) // -> { bash, info }，懒加载 ./<kind>.mjs
```

### 3.3 `src/config.mjs`（E2）

`sandboxSettings(vars)` 返回 `{ sandbox, sandboxName, spriteName, home, spaceCwd }`：

| sandbox | sandboxName | spriteName | home |
|---|---|---|---|
| `sprites` | `TARSBOT_SPRITE_NAME \|\| undefined` | 同左 | `/home/sprite` |
| `e2b` | `TARSBOT_E2B_NAME \|\| "pi-cloud-agents"` | `undefined` | `/home/user` |

`spaceCwd = ${home}/workspace`。Env id：`${sandbox}:${sandboxName}`（Sprites 下与现在一致：`sprites:pi-cloud-agents`）。

### 3.4 `GET /api/space`（E2）

`{ sandbox: "sprites" | "e2b", name, cwd }`，`cwd = config.spaceCwd`。前端按 `sandbox` 显示 "Sprite" / "E2B"，工作目录取 `cwd`。

## 4. 任务

| 任务 | 内容 | 依赖 |
|---|---|---|
| [E1-e2b](tasks/E1-e2b.md) | `src/sandbox/e2b.mjs` + 离线测试 + 真实 E2B 探测（只用临时探测沙箱） | — |
| [E2-select](tasks/E2-select.md) | 沙箱选择：config、loader、env、space 路由、preamble、前端、相关测试 | 契约 §3 |
| [E3-setup](tasks/E3-setup.md) | `scripts/e2b-setup.sh`：创建并初始化正式沙箱 `pi-cloud-agents`，含暂停/恢复验证 | E1 |
| E4（编排者） | 集成、全量测试、E2B 上跑 env conformance、本地 EGO 验收、文档（AGENTS/CONTRACTS/HANDOFF） | E1–E3 |

## 5. 规则

- 并行规则同 `docs/CLOUD-PLAN.md` §7：只改自己任务文件列出的文件，不 commit、不 `npm start`、不读 `.env`。
- E2B 远端资源：只能创建/操作 metadata `app=pi-cloud-agents` 的沙箱。E1 的探测沙箱 name 用 `probe-<时间戳>`，结束时必须 kill；E1 不得碰 name=`pi-cloud-agents` 的沙箱。账户里其他沙箱一律不动。
- GitHub 只操作测试仓库 `hifizz/tars-sandbox-playground`（只读或 `tarsbot/*` 分支）。
