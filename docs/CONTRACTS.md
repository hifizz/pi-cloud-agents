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
| `src/config.mjs` | `config`（`port`、`host`、`dataDir`、`dbPath`、`botsPath`、`provider="tokenrouter"`、`defaultModelId="swe-2"` 等）、`defaultModel()`、`ROOT` |
| `src/models.mjs` | `createTarsModels()`、`tokenRouterProvider()`（OpenAI 兼容，`TOKEN_ROUTER_BASE_URL`/`TOKEN_ROUTER_API_KEY`） |
| `src/harness.mjs` | `ctx`（BACKGROUND_CONTEXT）、`openHarness({storage?, models?, extensions?, env?, settings?, resume?})` → `{harness, registry, models}` |
| `src/bots.mjs` | `class BotRegistry(harness, {path?})`：`list()`、`get(idOrName)`、`conversation(idOrName)`、`createBot({name, model?, instructions?, thinkingLevel?, cwd?, extensions?, tools?})`、`register(bot)` |
| `src/runtime.mjs` | `bootstrap(overrides)`、`productionExtensions()`、`productionEnv()` —— **唯一集成点** |
| `src/ext/preamble.mjs` | `Preamble` 扩展 |

Bot 记录（bots.json）：`{ id, name, conversationId, model:{provider,modelId}, instructions, createdAt }`。

离线测试模板见 `test/harness.test.mjs`（`fauxProvider` + `MemoryStorage`）。

## 2. 沙箱原语契约

沙箱接口：`src/sandbox/<provider>.mjs` 导出

- `bash(command, {timeoutMs}) -> Promise<{stdout, stderr, exitCode, timedOut}>`
- `info() -> {sandbox, name}`

`src/env.mjs` 的 `SandboxEnv`（`ExecutionEnv` 实现）只依赖这两个原语，文件读写、编辑等均经 `bash` 完成。现有实现：`sprites.mjs`（Fly.io Sprites，WSS exec，工作目录 `/home/sprite/workspace`）、`e2b.mjs`（E2B，暂停即持久化，工作目录 `/home/user/workspace`，见 `docs/E2B-PLAN.md`）。`src/sandbox/index.mjs` 的 `loadSandbox(kind = config.sandbox)` 按 `TARSBOT_SANDBOX`（`sprites` 默认 / `e2b`，其他值启动即抛错）懒加载实现；`config` 提供 `sandbox`、`sandboxName`、`home`、`spaceCwd`，env id 为 `<sandbox>:<sandboxName>`。`GET /api/space` 返回 `{sandbox, name, cwd}`。新增沙箱：新增满足该接口的文件，并在 `config.sandboxSettings` 与 `SANDBOXES` 中登记。

## 3. pi-durable 关键契约（1.0.4）

- `ExecutionEnv = FileSystem & Shell`，见 `node_modules/@earendil-works/pi-durable/dist/env/index.d.ts`。所有方法返回 `Result`（`ok()`/`err()`，失败用 `FileError(code, msg, path)` / `ExecutionError(code, msg)`），不抛异常。
- CodingTools 实际用到：`exec`、`absolutePath`、`joinPath`、`exists`、`canonicalPath`、`fileInfo`、`readTextFile`、`writeFile`、`openBinaryReader`（`info`/`read`/`scanLines`/`close`；可用 `LineScanner` 在内存中计算）。
- 工具：`defineTool({name, description, parameters: Type.Object(...), replay?: "safe", execute: async (args, api, context) => ({content:[{type:"text",text}|{type:"image",data,mimeType}], details?})})`；`Type` 从 `@earendil-works/pi-ai` 导入。
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

（以代码为准；导出名与上表不符时回报。）

## 5. API 约定

- `src/api.mjs` 导出 `createApi({harness, bots, routes?: Array<(app) => void>})` → `{ server, listen(port, host), close() }`。
- 路由插件：以 `src/routes/<name>.mjs` 导出 `register(app)` 形式添加路由，**不改 api.mjs 本体**；`app` 提供 `app.get/post(path, handler)`（`:id` 路径参数）、`app.ws(path, handler)`、`app.guard(fn)`、`app.ctx = {harness, bots}`。
- 所有响应 JSON；错误 `{error: string}` + 合适状态码。生产绑定 `0.0.0.0:8080`（Fly），本地默认 `127.0.0.1:8090`。

## 6. 鉴权契约（摘要）

完整契约见 `docs/CLOUD-PLAN.md` §4，此处不重复。要点：

- 全局守卫由 `app.guard(fn)` 注册；`/api/*` 与全部 WS 默认要求有效 session cookie（`pca_session`），放行 `/api/auth/*` 与 `/api/health`；非 GET/HEAD 与 WS 校验 Origin。
- 白名单 `TARSBOT_ALLOWED_EMAILS`；登录方式为 Google OAuth 与邮箱密码；无注册接口；密码由 `scripts/set-password.mjs` 设置。
- 登录数据存 `<dataDir>/auth.sqlite`。
- `TARSBOT_AUTH_DISABLED=1` 仅限 loopback，`TARSBOT_HOST` 非 loopback 时启动即抛错。
