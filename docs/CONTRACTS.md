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

沙箱原语是一个函数：`bash(command, {timeoutMs}) -> Promise<{stdout, stderr, exitCode, timedOut}>`（`/bin/sh -c` 语义，非流式）。`src/sandbox/sprites.mjs` 导出 Sprites 实现（`createSpritesBash`、`redactMessage`，WSS exec）；`src/sandbox/instabox.mjs` 导出 InstaBox 实现（`createInstaboxBash`、`instaboxApi`、`waitOperation`，REST exec、停机自动唤醒，见 `docs/INSTABOX-PLAN.md`）。供应商按 runtime（每个工作区一台机器）提供它：`provider.bash(runtimeId)`。

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
- **供应商** `src/providers/instabox.mjs`：`createInstaboxProvider({apiKey, baseUrl?, ghToken?, gitEmail?, templateId?, log?})`，同一接口；机器命名/受管规则同 Sprites（`pca-` + metadata `app=pi-cloud-agents`，`kind: "instabox"`、`home: "/data/home"`）。默认供应商由 `TARSBOT_PROVIDER`（默认 `sprites`）选择；`INSTABOX_API_KEY` 未配置时不注册。共享的 gh/git 初始化步骤在 `sprites-init.mjs` 的 `initCommon`（InstaBox 无网络策略步骤）。
- **runner** `src/runner/runner.sh` + `client.mjs`：`createRunnerClient({bash, runnerPath?, home?})` → `install / prepare({id,cwd,command}) / start(id) / wait({id,from,maxSeconds}) / status(id) / kill(id)`。`prepare` 另需命令的 sha256（客户端自动给），`start` 先 `mkdir starting` 做至多一次闩锁；崩溃在闩锁与进程身份之间 → `claimed` 且 `launched=1`，视为「结果待确认」。`wait` 返回 `{state, exit, offset, size, bytes, text, done}`（单次最多 32 KiB），状态 `running | exited | lost | claimed | missing`，后三者**不得自动重启**。M1 不向 runner 传环境变量（Sprites 原语不声明 `supportsEnv`，`GH_TOKEN` 已在 provider.bash 的 exec 环境里并被子进程继承）。
- **执行工具** `src/ext/exec.mjs`：扩展 `Exec`（`tarsbot.exec`），装在 `CodingTools` 之后覆盖内置 `bash`，`replay: "safe"`；`setExecResolver(({conversationId}) => ({store, runner, workspace, binding}) | undefined)`；memo 固定首次的 binding，重放时与 `store.bindings.current` 比较，不一致 → 「结果待确认」，不 prepare / start；解析不到工作区 → 明确报错，不回退 `api.env.exec`。
- **环境路由** `src/workspace-env.mjs`：`createWorkspaceEnv({store, providers}) -> ({conversationId, cwd}) => SandboxEnv`，未就绪一律抛带原因的错误。
- **工作区服务** `src/workspaces.mjs`：`createWorkspaceService({store, github, providers, bots, ctx, runnerFor?, ...})` → `create / run / retry / resumePending({wait?}) / idle / get / list`。`resumePending()` 默认**只把运行排进队列就返回**（不等 clone/安装），要等用 `{wait:true}` 或 `idle()`。首条任务在工作区变为 `ready` 之后提交（requestId `ws:<id>:task`）。
- **检查点** `src/checkpoint.mjs`：`createCheckpointService({store, dir})` → `save({workspace,bash}) / apply({checkpoint,bash,cwd}) / list / verify`；检查点只含已跟踪与未跟踪（非忽略）的文件，存服务器磁盘。
- **重建** `src/workspace-rebuild.mjs`：`rebuildWorkspace({svc,store,github,providers,cps,runnerFor?}, {workspaceId, checkpointId, requestId?}) -> Binding`；旧 Sprite 不删；旧调用不重放（由 Exec 的绑定核对保证）。
- **启动顺序**（`src/server.mjs` 的 `assemble()`）：控制库 → github / providers / 检查点 → `bootstrap({resume:false})` → `setExecResolver` + 工作区服务 → `await resumePending()` → **最后** `harness.resume()` → `createApi({extraCtx})`。`extraCtx` = `{workspaces, github, control, checkpoints, rebuild, runtimeBash}`，路由插件从 `app.ctx` 取；缺依赖时对应路由不注册。
- **会话规则**：每个会话必须属于一个工作区；创建会话的唯一入口是 `POST /api/workspaces`（`POST /api/bots` 已删除）；fork 只允许只读并继承父会话的工作区关联。
- **API**：`GET /api/github/repos|branches`、`POST|GET /api/workspaces`、`GET /api/workspaces/:id`、`POST .../retry|pr|checkpoint|rebuild`、`GET .../checkpoints`；错误统一 `{error}`；响应不含 token 与服务器绝对路径（工作区视图不返回 `requestId`、`cwd`）。
