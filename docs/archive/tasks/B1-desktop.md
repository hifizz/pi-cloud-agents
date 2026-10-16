# Batch 1 / Task 6（WP4）：桌面工具扩展

先读：`docs/CONTRACTS.md`（全部）、`docs/PLAN.md` Task 6、`docs/driver-tools.txt`（真实 driver 工具与 inputSchema）、`src/space.mjs`、`vendor-ref/durable-examples/30-tool-override.ts`、`node_modules/@earendil-works/pi-durable/dist/harness/tool*.d.ts`（defineTool 与返回类型）。
可用 `node scratch/space-call.mjs <tool> '<json>'` 探测 driver 返回（结果写到 `scratch/<tool>.json`）。

## 你只能创建/修改这些文件
- `src/ext/desktop.mjs`
- `test/desktop.test.mjs`（离线，mock `callDriver`）
- `scratch/desktop-demo.mjs`
- 失败时：`docs/fail-WP4.md`

## 要求
导出 `Desktop = defineExtension({ name: "tarsbot.desktop", tools: [...], sections: [...] })`，以及 `createDesktopTools({ callDriver })`（依赖注入，默认用 `src/space.mjs` 的 `callDriver`）。

工具（名字固定，参数用 TypeBox `Type` 定义，描述要让模型会用）：

| 工具 | replay | 映射 |
|---|---|---|
| `desktop_screenshot {max_image_dimension?=1024}` | `safe` | `get_desktop_state`：返回 image content（`{type:"image", data, mimeType:"image/png"}`）+ text（窗口列表、capture_id、坐标说明） |
| `desktop_elements {pid, window_id, query?}` | `safe` | `get_window_state`（`include_accessibility_tree:true`）：返回元素 markdown/列表 text（截断到 ~12k 字符），可选附带截图 image |
| `desktop_windows {}` | `safe` | `list_windows {on_screen_only:true}` |
| `desktop_launch {name?, launch_path?, urls?}` | 不标 | `launch_app`（如打开 Chromium 访问 URL：`{name:"chromium", urls:[url]}`，以实测为准） |
| `desktop_click {pid?, window_id?, element_token?, x?, y?, scope?, button?, double?}` | 不标 | `click` / `double_click`（element_token 优先；x/y + `scope:"desktop"` 表示桌面截图坐标） |
| `desktop_type {pid?, window_id?, element_token?, text}` | 不标 | `type_text` |
| `desktop_key {pid?, window_id?, key?, keys?}` | 不标 | 有 `keys` 数组 → `hotkey`；否则 `press_key` |
| `desktop_scroll {pid?, window_id?, direction, amount?}` | 不标 | `scroll` |

- 参数名以 `docs/driver-tools.txt` 的 inputSchema 为准；写一个 `DRIVER_MAP` 常量集中映射，便于以后改名。
- driver `isError` 或抛错 → 工具抛 Error（模型会收到错误结果），消息包含 driver text。
- section：`section("desktop", () => "...使用说明：先 desktop_screenshot 或 desktop_windows 拿 pid/window_id，再 desktop_elements 取 element_token，优先按 element_token 操作；操作后截图验证。", ...)`（REQ-F02-4）。

## 验收
- `npm test` 全绿（含映射与参数转换单测、replay 标记断言：screenshot/elements/windows 为 safe，其余未标）。
- `node scratch/desktop-demo.mjs`：直接调用你的工具 execute（不经模型）完成：launch Chromium 打开 https://example.com → 等待 → 截图保存 `scratch/demo-example.png` → 通过 `desktop_windows` 打印出含 "Example Domain" 的窗口标题。打印每步耗时。（这是 TEST-F02-1 的机械预检；真实模型验收由编排者做。）
- 不要关闭/删除 Space 容器。

最后输出：改动文件、测试结果、demo 输出摘要、未验证项。
