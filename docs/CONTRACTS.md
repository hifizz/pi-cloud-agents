# TARSBot 接口契约（worker 必读，不得修改契约；发现缺陷先回报）

## 0. 通用规则

- Node 22，ESM（`.mjs`），后端不用 TypeScript；前端 `web/` 用 TS。
- 测试：后端 `node --test`（文件放 `test/*.test.mjs`），`npm test` 必须全绿。用 `TARSBOT_NO_DOTENV=1` 跑离线测试。
- 密钥只从 `process.env` 读（`src/config.mjs` 已加载 `.env`）。**禁止**打印、写日志、写入 Space 或测试快照。
- 只改分配给你的文件。共享文件（`src/runtime.mjs`、`src/harness.mjs`、`src/bots.mjs`、`src/space.mjs`、`package.json`）由编排者集成；需要新依赖时在汇报中列出，不要自行改 package.json（例外：被明确授权）。
- 参考源码：`vendor-ref/durable-examples/*.ts`（pi-durable 官方示例），`vendor-ref/coding-agent-durable/`（官方 durable 编码 Agent），`node_modules/@earendil-works/pi-durable/dist/**/*.d.ts`（类型真相）。

## 1. 已有模块（编排者已实现，可直接 import）

| 模块 | 导出 |
|---|---|
| `src/config.mjs` | `config`（`port`、`host`、`dataDir`、`dbPath`、`botsPath`、`provider="tokenrouter"`、`defaultModelId="glm-5.3-flash"`、`spaceCwd`）、`defaultModel()`、`ROOT` |
| `src/models.mjs` | `createTarsModels()`、`tokenRouterProvider()`（OpenAI 兼容，`TOKEN_ROUTER_BASE_URL`/`TOKEN_ROUTER_API_KEY`） |
| `src/harness.mjs` | `ctx`（BACKGROUND_CONTEXT）、`openHarness({storage?, models?, extensions?, env?, settings?, resume?})` → `{harness, registry, models}` |
| `src/bots.mjs` | `class BotRegistry(harness, {path?})`：`list()`、`get(idOrName)`、`conversation(idOrName)`、`createBot({name, model?, instructions?, thinkingLevel?, cwd?, extensions?, tools?})`、`register(bot)` |
| `src/runtime.mjs` | `bootstrap(overrides)`、`productionExtensions()`、`productionEnv()` —— **唯一集成点** |
| `src/space.mjs` | `getSpace()`、`resetSpace()`、`withSpace(fn)`、`callDriver(tool, args, {space?, timeoutMs?})` → `{isError, text, content, structured}`、`spaceBash(cmd, {timeoutMs?})` → `{stdout, stderr, exitCode, timedOut}`、`SPACE_HOME="/home/cua"`、`getSpaceInfo()` |
| `src/ext/preamble.mjs` | `Preamble` 扩展 |

Bot 记录（bots.json）：`{ id, name, conversationId, model:{provider,modelId}, instructions, createdAt }`。

离线测试模板见 `test/harness.test.mjs`（`fauxProvider` + `MemoryStorage`）。

## 2. Space 实测事实（Task 2 探针，2026-10-06）

- 容器：`ghcr.io/trycua/linux:24.04`（arm64，Ubuntu 24.04，XFCE + Xvfb 1280x800），名 `tarsbot-probe`，`docker ps` 可见；spacesd 端口映射 `127.0.0.1:<随机>->3211`（`docker port tarsbot-probe 3211/tcp`）；`/viewer/` 返回 200。
- **用户是 `cua`，HOME=`/home/cua`**（设计文档写的 `/home/user` 作废）。默认工作目录 `config.spaceCwd`（应为 `/home/cua/work`）。
- `space.bash(cmd: string, timeoutMs?: bigint)` → `{stdout, stderr, exitCode?, signal?, timedOut, error?, rendered}`，非流式，`/bin/sh -c`。
- `space.write(path, ArrayBuffer)`、`space.upload/download` 存在（签名见 `node_modules/@trycua/cua/dist/native/cua_sdk.d.ts`）。
- `space.callTool(tool, argsJsonString, "driver", timeoutMs?)` → `{contentJson, structuredJson, isError, text}`（JSON 字符串）。用 `callDriver()` 已解析好。
- 工具清单：`docs/driver-tools.txt`（60 个）。关键：
  - `get_desktop_state {max_image_dimension?}` → image/png（base64）+ text（可见窗口 pid/window_id 列表）+ structured `{capture_id, screen_width, screenshot_width, frame_scale, windows[]}`
  - `get_window_state {pid, window_id, ...}` → AT-SPI 元素（`element_index`/`element_token`）+ 截图（首选定位方式）
  - `list_windows {on_screen_only?}`、`list_apps`、`launch_app {name|launch_path|urls}`（Chromium: `/usr/bin/chromium`，Firefox: `firefox`）
  - `click {pid, element_token}` 或 `{window_id, x, y}`（窗口坐标）或 `scope:"desktop"` + x/y（桌面截图坐标）
  - `type_text`、`press_key`、`hotkey {keys:[...]}`、`scroll`
  - `get_browser_state` / `browser_navigate` / `browser_click` / `browser_type`（CDP 级浏览器控制）
  - 参数细节务必以 `docs/driver-tools.txt` 中的 `inputSchema` 为准。

## 3. pi-durable 关键契约（1.0.4）

- `ExecutionEnv = FileSystem & Shell`，见 `node_modules/@earendil-works/pi-durable/dist/env/index.d.ts`。所有方法返回 `Result`（`ok()`/`err()`，失败用 `FileError(code, msg, path)` / `ExecutionError(code, msg)`），不抛异常。
- CodingTools 实际用到：`exec`、`absolutePath`、`joinPath`、`exists`、`canonicalPath`、`fileInfo`、`readTextFile`、`writeFile`、`openBinaryReader`（`info`/`read`/`scanLines`/`close`；可用 `LineScanner` 在内存中计算）。
- 工具：`defineTool({name, description, parameters: Type.Object(...), replay?: "safe", execute: async (args, api, context) => ({content:[{type:"text",text}|{type:"image",data,mimeType}], details?})})`；`Type` 从 `@earendil-works/pi-ai` 导入。
- 扩展：`defineExtension({name, tools?, sections?, hooks?, tasks?})`。
- 事件流：`watchEvents(harness, conversationId, ctx)` → `{snapshot, start(listener(events)), stop()}`；事件类型见 `dist/harness/events.d.ts`（`snapshot`、`run_start/end`、`message_start/update/end`、`tool_execution_start/update/end`、`inbox_update`、`usage_changed`、`task_failed`、`compaction_start/end`、`entry_appended`、`agent_changed`、`submission`…）。
- 提交：`conv.submit({type:"input", content, whenBusy?:"steer"|"followUp"|"reject", requestId?}, ctx)`；`conv.abort(ctx,{background?})`、`conv.compact(instr, ctx)`、`conv.reset(note, ctx)`、`conv.fork(entryId, {ownership:{kind:"ownerless"}, agent?}, ctx)`、`harness.usage(ctx)`、`conv.viewState(ctx)`（`docs["pi.usage"]`、`docs["pi.live"]`、`docs["pi.inbox"]`）。

## 4. 扩展注册约定

每个扩展文件导出一个具名扩展常量，编排者在 `src/runtime.mjs` 的 `productionExtensions()` 里按序安装：

| 文件 | 导出 | 扩展 name |
|---|---|---|
| `src/ext/preamble.mjs` | `Preamble` | `tarsbot.preamble` |
| `src/env.mjs` | `spaceEnv()`（返回 `({cwd, conversationId}) => ExecutionEnv`）、`CuaEnv`、`shellQuote(argv)` | — |
| `src/ext/desktop.mjs` | `Desktop` | `tarsbot.desktop` |
| `src/ext/search.mjs` | `Search` | `tarsbot.search` |
| `src/ext/approval.mjs` | `Approval`、`approvals`（待审批队列） | `tarsbot.approval` |
| `src/ext/routines.mjs` | `Routines` | `tarsbot.routines` |

## 5. API 约定（Task 8 起）

- `src/api.mjs` 导出 `createApi({harness, bots, routes?: Array<(app) => void>})` → `{ server, listen(port, host), close() }`。
- 路由插件：后续任务以 `src/routes/<name>.mjs` 导出 `register(app)` 形式添加路由，**不改 api.mjs 本体**；`app` 提供 `app.get/post(path, handler)`（`:id` 路径参数）、`app.ws(path, handler)`、`app.ctx = {harness, bots}`。
- 所有响应 JSON；错误 `{error: string}` + 合适状态码；绑定 `127.0.0.1`。
