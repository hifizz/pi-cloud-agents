# Batch 1 / Task 8（WP6a）：API 层

先读：`docs/CONTRACTS.md`（尤其 §1、§3、§5）、`docs/PLAN.md` Task 8、规范文档 §5.1 I01、`node_modules/@earendil-works/pi-durable/dist/harness/events.d.ts`、`dist/harness/types.d.ts`、`vendor-ref/durable-examples/19-json.ts`、`21-late-join.ts`、`20-inbox.ts`、`test/harness.test.mjs`。

## 你只能创建/修改这些文件
- `src/api.mjs`
- `src/server.mjs`
- `test/api.test.mjs`（离线：MemoryStorage + faux provider）
- `scratch/record-events.mjs`（录制真实事件流 fixture，见下）
- `web/test/fixtures/*.json`（录制产物）
- 失败时：`docs/fail-WP6a.md`

依赖已安装：`ws@8.22.0`。不用 express，使用 Node `http` + 自写极简路由。

## 要求
1. `export function createApi({ harness, bots, routes = [], staticDir? })` → `{ server, app, listen(port=config.port, host="127.0.0.1") => Promise<{port}>, close() }`。
   - `app.get/post(path, handler)`，path 支持 `:id`；handler `(req, res, {params, body, query}) => any`，返回值 JSON 序列化；抛 `HttpError(status, msg)` → `{error}`。
   - `app.ws(path, handler(socket, {params}))`；`app.ctx = {harness, bots}`；`routes` 中每个 `register(app)` 在内置路由后调用（后续任务用 `src/routes/*.mjs` 扩展，**不改 api.mjs**）。导出 `HttpError`。
   - `staticDir`（`web/dist`）存在时托管静态文件，未知非 `/api` 路径回退 `index.html`。
2. 端点（I01）：
   - `GET /api/bots` → `[{...bot, busy: boolean, queued: number}]`（busy 来自 viewState 的 `pi.live`/run；实现方式自定，写清楚）。
   - `POST /api/bots {name, modelId?, instructions?, thinkingLevel?}` → bot（model 默认 `defaultModel()`，modelId 给定时 provider 用 `config.provider`）。
   - `POST /api/bots/:id/input {text, whenBusy?, requestId?}` → `{submissionId}`（不等待完成）。
   - `POST /api/bots/:id/abort {background?}`、`POST /api/bots/:id/compact {instructions?}` → `{taskId}`、`POST /api/bots/:id/reset {note?}`。
   - `GET /api/bots/:id/entries?limit=100` → 活动 transcript（旧→新）。
   - `WS /api/bots/:id/stream`：连接后 `watchEvents`，首帧发送 `{type:"snapshot", ...}`，之后每批事件一条消息 `{type:"events", events:[...]}`；断开时 stop。JSON 序列化需处理 bigint。
   - `GET /api/usage` → `{ total: harness.usage(ctx), bots: [{id, name, usage}] }`（每 Bot 来自其 conversation viewState 的 `docs["pi.usage"]`）。
   - `GET /api/health` → `{ok:true}`。
3. `src/server.mjs`：`bootstrap()`（`src/runtime.mjs`）→ `new BotRegistry(harness)` → 若无 Bot 则创建 `tars` → `createApi({harness, bots, staticDir: ROOT/web/dist, routes: await loadRoutes()})`，`loadRoutes()` 动态 import `src/routes/*.mjs`（目录不存在则空）→ listen → 日志打印 `TARSBot listening on http://127.0.0.1:8080`、`resume done`、以及一行 **"WARNING: API has no authentication; bound to 127.0.0.1 only"**。SIGINT/SIGTERM 优雅关闭 harness。
4. `scratch/record-events.mjs`：用 MemoryStorage + faux provider（含 thinking、文本、一次 bash 工具调用、工具结果、最终回答；再录一份工具被 interrupted / 失败的场景若可构造），把 WS 收到的帧数组写入 `web/test/fixtures/run-basic.json`、`run-tool.json`。另外若 `TOKEN_ROUTER_API_KEY` 存在，用真实 glm-5.3 录一份简单问答 `run-real.json`（不得包含密钥）。

## 验收
- `npm test` 全绿：建 Bot → POST input → WS 先收 snapshot 再收 events 且最终出现 `run_end` → 同 requestId 两次 POST 返回同一 submissionId → `GET /api/usage` 有该 Bot 条目 → 404/400 错误格式。测试监听随机端口（port 0）。
- 真实冒烟：`node src/server.mjs` 启动（后台），`curl -s localhost:8080/api/health`、`curl -X POST .../api/bots/tars/input -d '{"text":"1+1=?"}'`，然后 `GET /api/usage` 返回非零 cost 与 tokens（TEST-F11-1）。之后结束进程。
- fixtures 已生成。

最后输出：改动文件、测试结果、真实冒烟输出摘要（不含密钥）、未验证项。
