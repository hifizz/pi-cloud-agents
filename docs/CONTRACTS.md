# pi-cloud-agents 接口契约（worker 必读，不得修改契约；发现缺陷先回报）

## 0. 通用规则

- Node ≥ 24，ESM（`.mjs`），后端不用 TypeScript；前端 `web/` 用 TS。
- 测试：后端 `node --test`（文件放 `test/*.test.mjs`），`npm test` 必须全绿。用 `TARSBOT_NO_DOTENV=1` 跑离线测试。
- 密钥只从 `process.env` 读（`src/config.mjs` 已加载 `.env`）。**禁止**打印、写日志、写入 Sprite 或测试快照。
- 只改分配给你的文件。共享文件（`src/runtime.mjs`、`src/harness.mjs`、`src/bots.mjs`、`package.json`）由编排者集成；需要新依赖时在汇报中列出，不要自行改 package.json（例外：被明确授权）。
- 参考源码：`vendor-ref/durable-examples/*.ts`（pi-durable 官方示例），`vendor-ref/coding-agent-durable/`（官方 durable 编码 Agent），`node_modules/@earendil-works/pi-durable/dist/**/*.d.ts`（类型真相）。
- `TARSBOT_*` 环境变量与 "TARSBot" 字样是历史遗留，暂不改名。

## 1. 已有模块

| 模块 | 导出 |
|---|---|
| `src/config.mjs` | `config`（`port`、`host`、`dataDir`、`dbPath`、`botsPath`、`controlDbPath`、`checkpointDir`、`provider="tokenrouter"`、`defaultModelId="swe-2"` 等）、`defaultModel()`、`ROOT` |
| `src/models.mjs` | `createTarsModels()`、`tokenRouterProvider()`（OpenAI 兼容，`TOKEN_ROUTER_BASE_URL`/`TOKEN_ROUTER_API_KEY`） |
| `src/harness.mjs` | `ctx`（BACKGROUND_CONTEXT）、`openHarness({storage?, models?, extensions?, env?, settings?, resume?})` → `{harness, registry, models}` |
| `src/bots.mjs` | `class BotRegistry(harness, {path?})`：`list()`、`get(idOrName)`、`conversation(idOrName)`、`createBot({name, model?, instructions?, thinkingLevel?, cwd?, extensions?, tools?})`、`register(bot)` |
| `src/runtime.mjs` | `bootstrap({store, providers, resume?, ...})`、`productionExtensions()`、`productionEnv({store, providers})` —— **唯一集成点** |
| `src/ext/preamble.mjs` | `Preamble` 扩展 |

Bot 记录（bots.json）：`{ id, name, conversationId, model:{provider,modelId}, instructions, createdAt }`。

离线测试模板见 `test/harness.test.mjs`（`fauxProvider` + `MemoryStorage`）。

## 2. 沙箱原语契约

沙箱原语是一个函数：`bash(command, {timeoutMs}) -> Promise<{stdout, stderr, exitCode, timedOut}>`（`/bin/sh -c` 语义，非流式）。`src/sandbox/sprites.mjs` 导出实现（`createSpritesBash`、`redactMessage`，Sprites WSS exec）；`src/providers/sprites.mjs` 按 runtime（每个工作区一台 Sprite）提供它（`provider.bash(runtimeId)`）。

`src/env.mjs` 的 `SandboxEnv`（`ExecutionEnv` 实现）只依赖传入的 `bash` 原语（必填，没有全局默认沙箱），文件读写、编辑等均经 `bash` 完成。哪个会话用哪台 Sprite 由 `src/workspace-env.mjs` 决定（§7）。

## 3. pi-durable 关键契约（1.4.0）

- `ExecutionEnv = FileSystem & Shell`，见 `node_modules/@earendil-works/pi-durable/dist/env/index.d.ts`。所有方法返回 `Result`（`ok()`/`err()`，失败用 `FileError(code, msg, path)` / `ExecutionError(code, msg)`），不抛异常。
- CodingTools 实际用到：`exec`、`absolutePath`、`joinPath`、`exists`、`canonicalPath`、`fileInfo`、`readTextFile`、`writeFile`、`openBinaryReader`（`info`/`read`/`scanLines`/`close`；可用 `LineScanner` 在内存中计算）。
- 工具：`defineTool({name, description, parameters: Type.Object(...), replay?: "safe", execute: async (args, api, context) => ({output:[{type:"text",text}|{type:"image",data,mimeType}], details?})})`（1.2.0 起 `content` 改名为 `output`）；`Type` 从 `@earendil-works/pi-ai` 导入。
- 文档：`defineDoc({..., checkpointWhen})`，1.4.0 起 `checkpointWhen` 必填（`() => false` 保持增量写入）。
- 定时等待：1.4.0 移除 `TaskRuntime.sleep()`；任务以 `runtime.sleepUntil(until, checkpoint, ctx)` 或 `commit()` 返回 `{status:"sleeping", until, checkpoint}` 结束当前阶段，持久化休眠，到点后从 checkpoint 恢复。时钟用 `HarnessOptions.now` / `setTimer` 注入。
- 扩展：`defineExtension({name, tools?, sections?, hooks?, tasks?})`。
- 事件流：`watchEvents(harness, conversationId, ctx)` → `{snapshot, start(listener(events)), stop()}`；事件类型见 `dist/harness/events.d.ts`（`snapshot`、`run_start/end`、`message_start/update/end`、`tool_execution_start/update/end`、`inbox_update`、`usage_changed`、`task_failed`、`compaction_start/end`、`entry_appended`、`agent_changed`、`submission`…）。
- 提交：`conv.submit({type:"input", content, whenBusy?:"steer"|"followUp"|"reject", requestId?}, ctx)`；`conv.abort(ctx,{background?})`、`conv.compact(instr, ctx)`、`conv.reset(note, ctx)`、`conv.fork(entryId, {ownership:{kind:"ownerless"}, agent?}, ctx)`、`harness.usage(ctx)`、`conv.viewState(ctx)`（`docs["pi.usage"]`、`docs["pi.live"]`、`docs["pi.inbox"]`）。

## 4. 扩展注册约定

每个扩展文件导出一个具名扩展常量，编排者在 `src/runtime.mjs` 的 `productionExtensions()` 里按序安装（Approval 必须最后）：

| 文件 | 导出 | 扩展 name |
|---|---|---|
| `src/ext/preamble.mjs` | `Preamble` | `tarsbot.preamble` |
| `src/env.mjs` | `SandboxEnv`（`ExecutionEnv` 实现）、`shellQuote(argv)` | — |
| `src/ext/search.mjs` | `Search` | `tarsbot.search` |
| `src/ext/approval.mjs` | `Approval`、`approvals`（待审批队列） | `tarsbot.approval` |
| `src/ext/routines.mjs` | `Routines` | `tarsbot.routines` |
| `src/ext/exec.mjs` | `Exec`、`setExecResolver` | `tarsbot.exec` |

（以代码为准；导出名与上表不符时回报。）

## 5. API 约定

- `src/api.mjs` 导出 `createApi({harness, bots, routes?: Array<(app) => void>, extraCtx?})` → `{ server, listen(port, host), close() }`。
- 路由插件：以 `src/routes/<name>.mjs` 导出 `register(app)` 形式添加路由，**不改 api.mjs 本体**；`app` 提供 `app.get/post(path, handler)`（`:id` 路径参数）、`app.ws(path, handler)`、`app.guard(fn)`、`app.ctx = {harness, bots}`。
- 所有响应 JSON；错误 `{error: string}` + 合适状态码。生产绑定 `0.0.0.0:8080`（Fly），本地默认 `127.0.0.1:8090`。

## 6. 鉴权契约（摘要）

完整契约见 `docs/CLOUD-PLAN.md` §4，此处不重复。要点：

- 全局守卫由 `app.guard(fn)` 注册；`/api/*` 与全部 WS 默认要求有效 session cookie（`pca_session`），放行 `/api/auth/*` 与 `/api/health`；非 GET/HEAD 与 WS 校验 Origin。
- 白名单 `TARSBOT_ALLOWED_EMAILS`；登录方式为 Google OAuth 与邮箱密码；无注册接口；密码由 `scripts/set-password.mjs` 设置。
- 登录数据存 `<dataDir>/auth.sqlite`。
- `TARSBOT_AUTH_DISABLED=1` 仅限 loopback，`TARSBOT_HOST` 非 loopback 时启动即抛错。

## 7. 工作区、控制库、供应商、runner（M1）

完整设计与取舍见 `docs/M1-PLAN.md`；此处只记最终接口，**与代码冲突时以代码为准**。

- **控制库** `src/control/store.mjs`：`openControlStore({path, now?})`，单写者同步事务；表 projects / workspaces / workspace_steps / runtime_bindings / conversation_links / intents / requests / executions / checkpoints / meta。会话 id 在控制库里一律是**字符串**（Pi Durable 的会话 id 是数字，调用处 `String()`）。`meta.ensure("namespace" | "generation")` 在启动时写入，`runId = sha256(namespace:generation:taskId)` 前 24 位。
- **GitHub** `src/github.mjs`：`createGithubClient({token?, fetch?, apiBase?})`，`ensurePull(..., {intents, requestId})` 超时后核对再决定；`GithubError.code` = not_found / unauthorized / rate_limited / conflict / unknown；token 不进任何错误与返回值。
- **供应商** `src/providers/sprites.mjs`：`createSpritesProvider({client, ghToken?, gitEmail?, log?, cpus?, ramMB?, legacyNames?})`；`runtimeName(requestId)` = `pca-<10 hex>`；`isManaged(name, labels?)` 要求前缀 `pca-` 且标签 `app:pi-cloud-agents`，旧共享 Sprite 永不受管；`ensure` 只在确切 404 后创建；`release` 只给受管 Sprite，M1 不对 UI 开放。
- **runner** `src/runner/runner.sh` + `client.mjs`：`createRunnerClient({bash, runnerPath?, home?})` → `install / prepare({id,cwd,command}) / start(id) / wait({id,from,maxSeconds}) / status(id) / kill(id)`。`prepare` 另需命令的 sha256（客户端自动给），`start` 先 `mkdir starting` 做至多一次闩锁；崩溃在闩锁与进程身份之间 → `claimed` 且 `launched=1`，视为「结果待确认」。`wait` 返回 `{state, exit, offset, size, bytes, text, done}`（单次最多 32 KiB），状态 `running | exited | lost | claimed | missing`，后三者**不得自动重启**。M1 不向 runner 传环境变量（Sprites 原语不声明 `supportsEnv`，`GH_TOKEN` 已在 provider.bash 的 exec 环境里并被子进程继承）。
- **执行工具** `src/ext/exec.mjs`：扩展 `Exec`（`tarsbot.exec`），装在 `CodingTools` 之后覆盖内置 `bash`，`replay: "safe"`；`setExecResolver(({conversationId}) => ({store, runner, workspace, binding}) | undefined)`；memo 固定首次的 binding，重放时与 `store.bindings.current` 比较，不一致 → 「结果待确认」，不 prepare / start；解析不到工作区 → 明确报错，不回退 `api.env.exec`。
- **环境路由** `src/workspace-env.mjs`：`createWorkspaceEnv({store, providers}) -> ({conversationId, cwd}) => SandboxEnv`，未就绪一律抛带原因的错误。
- **工作区服务** `src/workspaces.mjs`：`createWorkspaceService({store, github, providers, bots, ctx, runnerFor?, ...})` → `create / run / retry / resumePending({wait?}) / idle / get / list`。`resumePending()` 默认**只把运行排进队列就返回**（不等 clone/安装），要等用 `{wait:true}` 或 `idle()`。首条任务在工作区变为 `ready` 之后提交（requestId `ws:<id>:task`）。
- **检查点** `src/checkpoint.mjs`：`createCheckpointService({store, dir})` → `save({workspace,bash}) / apply({checkpoint,bash,cwd}) / list / verify`；检查点只含已跟踪与未跟踪（非忽略）的文件，存服务器磁盘。
- **重建** `src/workspace-rebuild.mjs`：`rebuildWorkspace({svc,store,github,providers,cps,runnerFor?}, {workspaceId, checkpointId, requestId?}) -> Binding`；旧 Sprite 不删；旧调用不重放（由 Exec 的绑定核对保证）。
- **启动顺序**（`src/server.mjs` 的 `assemble()`）：控制库 → github / providers / 检查点 → `bootstrap({resume:false})` → `setExecResolver` + 工作区服务 → `await resumePending()` → **最后** `harness.resume()` → `createApi({extraCtx})`。`extraCtx` = `{workspaces, github, control, checkpoints, rebuild, runtimeBash}`，路由插件从 `app.ctx` 取；缺依赖时对应路由不注册。
- **会话规则**：每个会话必须属于一个工作区；创建会话的唯一入口是 `POST /api/workspaces`（`POST /api/bots` 已删除）；fork 只允许只读并继承父会话的工作区关联。
- **API**：`GET /api/github/repos|branches`、`POST|GET /api/workspaces`、`GET /api/workspaces/:id`、`POST .../retry|pr|checkpoint|rebuild`、`GET .../checkpoints`；错误统一 `{error}`；响应不含 token 与服务器绝对路径（工作区视图不返回 `requestId`、`cwd`）。

### 用户环境变量（ENV-DEMO）

- **存储**：`control.sqlite` 迁移 v4 的 `env_vars`（工作区默认）与 `session_env_overrides`（按 conversation id 的 `set`/`disabled` 覆盖）。`value` 列是 AES-256-GCM 密文 `v1:<iv>:<tag>:<data>`（base64url），明文永不落库。
- **主密钥**：`TARSBOT_ENV_KEY`（>=16 字符，env/Fly secret），`src/env-config.mjs` 以 scrypt 派生 AES key。缺失：服务 `enabled=false`，写入 503，读取返回 masked 列表；**存了密文但缺 key 时 `effectiveEnv` 抛 `disabled`**（有配置的 Session 不会静默无配置跑命令），无存储时仍返回空——**无明文后备**。丢失/轮换后主密钥与已存密文不匹配，解密报“解密失败”，需重新录入。
- **解析规则**：普通 Session 有效值 = 工作区默认 ∪ 本会话覆盖；`set` 替换（空字符串是合法值）、`disabled` 是 unset（不是空串）、`inherit` 删除覆盖恢复默认。覆盖按 conversation id 存——fork / 委派子会话是新 id，不复制父会话覆盖，仅各自继承工作区默认。
- **受限 Session**：`readOnly` fork 与 `loopRun` 会话不得读写用户变量（路由 409/面板拒绝），exec 只拿 `{GH_TOKEN:""}` 能力裁剪。
- **保留名**：`PATH HOME SHELL USER LOGNAME PWD OLDPWD BASH_ENV ENV ENVIRONMENT CDPATH GLOBIGNORE UID EUID PPID SHELLOPTS BASHOPTS PROMPT_COMMAND PS0-PS4 NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS PYTHONSTARTUP PYTHONPATH PYTHONINSPECT PERL5OPT RUBYOPT GIT_SSH_COMMAND GIT_SSH GIT_EXEC_PATH GIT_ASKPASS SSH_ASKPASS GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN SPRITES_TOKEN FLY_API_TOKEN AWS_*` 与前缀 `TARSBOT_ PCA_ LD_ DYLD_ TOKEN_ROUTER_ EXA_ GOOGLE_ SPRITES_ FLY_ BASH_FUNC_ GIT_` 一律 400。
- **注入路径（值绝不进 exec URL / argv / 文件）**：SDK `spawn(options.env)` 会把值序列化进 exec URL query，所以**所有值都走 stdin bootstrap**——
  - **Agent bash / 命令控制台**：runner `prepare` 只落变量名（set 名进 `--env-file`，禁用名进 `--unset-file`），`start` 以 per-call env 传给 `createSpritesBash`；后者把值序列成一行 base64 `export`/`unset` 语句，作为 spawn 后第一帧 stdin 写入，argv 换成固定 bootstrap 脚本（`read` 该行 → `eval` → `exec sh -c <command>`）。注入失败以退出码 124/125 拒绝，绝不跑半配置的命令。
  - **PTY**：`provider.pty` 握手 bootstrap——argv 固定 `bash -c <script>`，脚本先在 `/dev/tty` 上 `stty -echo -icanon`（关回显+canonical，突破 4096 行上限）、读固定 probe、打印 `PCA_READY_1` ACK、再读 base64 payload 行；客户端在 `spawn` 时发 probe、见到 ACK 才发 payload，再等 `PCA_APPLIED_1` 确认逐条应用成功后才返回 shell handle / 发送 started，之前不接收用户按键。两种标记均跨 chunk 解析并从 UI 输出过滤；probe/payload/client 截止时间分别为 30/60/90 秒，失败 kill/close。probe 错误/超时/坏 payload 退出 124/125 并关 socket，不开半配置 shell。
  - **disabled/unset**：禁用名不出现在 `set` 里，而是经 `PCA_ENV_UNSET` 传给 runner wrapper / PTY payload 里的 `unset` 语句——是真 unset，不是空字符串，父环境的同名值不会泄漏。Loop/readOnly 受限 Session 无任何用户变量。`env` 参数仍是 TERM/COLORTERM/LANG 显示白名单（非秘密值）。
- **API**（`src/routes/env-vars.mjs`，全部过 auth 守卫）：`GET /api/workspaces/:id/env`、`POST /api/workspaces/:id/env/:name {value}`、`POST .../env/:name/remove`、`GET /api/bots/:id/env`、`POST /api/bots/:id/env/:name {mode,value?}`。**值只写不读**；返回仅有 name / mode / masked / enabled / restricted。
- **容量**：每 scope 最多 100 项，单值最多 8 KiB；变量名、值及分隔开销合计每 scope 最多 32 KiB，workspace + session 合并最多 64 KiB。PTY 支持单引号最坏膨胀后的 512 KiB base64 传输上限；超过保存预算原子拒绝。
- **旧 runner / 恢复**：Agent 新执行在 prepare 前运行幂等 install（同时比较 version 与 SHA），不依赖先打开控制台。当前 runner 声明版本仍为 2，新增 unset 协议通过 SHA 差异升级；旧 run 重连不 install/prepare/start，也不解密当前配置，因此丢 key 不影响 status/wait/kill。新任务有存储配置但缺 key 则明确拒绝。
- **生效边界**：只影响保存后新启动的进程（新 bash 命令、新控制台 run、新 PTY）；已运行服务或已开终端不追溯，需重启。不修改服务器 `process.env`、不写 Sprite 全局 shell 配置；预览继承其启动进程环境，无单独配置层。
- **每调用 env 快照（并发安全）**：`createSpritesBash` 的 per-call env/payload 每次调用冻结成不可变快照显式传给每次 attempt——并发两调用不会互相覆盖 env，pre-open 重试也复用同一快照（Loop 的 `GH_TOKEN=""` 限制不会在重试丢）。
- **隔离边界（用户已接受）**：同工作区 Session 共享一台 Sprite，用户变量可被同机其他进程读到（`/proc/*/environ`、ptrace、共用户），**不是强隔离**；用户程序自行 `echo $VAR` 无法拦截，文档不承诺绝对保密。
