# swe2-issue-image 验收

验证 SWE-2（`tokenrouter/swe-2`）能对 issue 正文中的图片链接做真实的像素识别。修复前 `src/models.mjs` 把 swe-2 写成 `input: ["text"]`，pi-ai 的 openai-completions 序列化器会静默丢掉 tool result 里的 `image` 块，模型只能靠文字猜。

## 修复

- `src/models.mjs`：swe-2 `input` 改为 `["text","image"]`（TokenRouter catalog 本就声明 `imageInput: true`）。
- `src/ext/view-image.mjs`：错误分支的 `output` 由裸字符串改为 `[{type:"text",...}]`，符合 `ToolResultMessage["content"]` 契约。
- `test/view-image.test.mjs`：新增一条序列化级回归测试，用 `tokenRouterProvider().getModels()` 的真实 catalog 对象驱动 `convertMessages`，swe-2 回退到 `["text"]` 时该测试必然失败。

## 证据

- **会话**：`vision-url-dl`，bot `8912f72e`，conversation 786，工作区 `ws_e168e5f97244a35b`（hifizz/tars-sandbox-playground）。
- **URL 链路**：issue #17 正文里的 `raw.githubusercontent.com/.../docs-fixture-image.png`（私有仓库，匿名 404）。会话用 `Authorization: Bearer $GH_TOKEN`（变量名引用，未输出值）`curl` 下载到 `/tmp/url-dl-821ce9c0.png`。**HTTP 200，`Content-Type: image/png`，12,120 字节，640×240 RGBA。** 判读只用这个 /tmp 文件，不依赖工作区检出的同名文件。
- **view_image**：工具卡片显示 `view_image /tmp/url-dl-821ce9c0.png`，输出 `image ... (image/png, 11.8KB) attached`，UI 提供 Enlarge image 预览。
- **模型输出**：`CITRUS-4921`（黄色大号）、背景深蓝、`seven oranges on a blue plate`（白色小字）。三项只存在于像素，提示/路径/URL/历史中均无答案。

## 截图

- `01-session-top.png` — 会话页全景：提示词、HTTP 200 结果、`CITRUS-4921` 答案、模型标签 `tokenrouter/swe-2`。
- `02-view-image-enlarged.png` — view_image 附件放大预览：真实图片像素。

## 与第一次验证的差别

第一次验证（`issue-17-discuss`，bot `f67c18e6`）的 fixture 恰好已被 pinned SHA `3b7195c` 检入 worktree，模型用了本地检出文件做 view_image——像素识别成立，但 URL 下载被旁路。本次会话显式要求下载到 /tmp 的唯一路径并用环境凭据取 URL，关闭了那条旁路。

## 远端副作用

- `hifizz/tars-sandbox-playground` main 推入 commit `3b7195c`（新增 `docs-fixture-image.png` fixture）。
- 创建 issue `hifizz/tars-sandbox-playground#17`（fixture 专用，正文仅含 URL，无答案）。

## 未验证点

- 匿名公网 URL 链路未做（仓库私有，GitHub asset 上传需要 web 会话，gh token 不通 `uploads.github.com`）；已用仓库自身鉴权证明"URL→下载→view_image"链路。
- 前端构建产物 `web/dist` 未随本次代码改动重新 build（改动只在后端 `.mjs` 与测试）。
