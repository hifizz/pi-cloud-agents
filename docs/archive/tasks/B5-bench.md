# Batch 5 / Task 15：GUI 成功率矩阵（TEST-F02-2 / F02-3）

先读：`docs/CONTRACTS.md`、`docs/PLAN.md` Task 15、规范 §4.2 F02、`src/ext/desktop.mjs`、`src/bots.mjs`（`forkBot` 如何按名字收窄工具：从 `conv.agent(ctx).tools` 过滤）、`src/api.mjs`、`scripts/ask.mjs`。

后端 server 已在 `127.0.0.1:8080` 运行（编排者维护，**不要重启或杀掉**；存储单写者，**不要在另一个进程里打开 data/alice.sqlite**）。Space 容器 `tarsbot-space`，`docker exec tarsbot-space ...` 可用于准备测试站点与核查结果。

## 你只能创建/修改
- `src/routes/bench.mjs`（新路由：`POST /api/bench/bots {name, modelId, tools: string[]}` → 创建 Bot，并把 agent tools 收窄为给定名字集合；实现方式：先 `bots.createBot`，再 `conv.agent(ctx)` 取工具对象按名过滤后 `conv.configure({tools})`）。**注意**：server 只在启动时加载 routes，你的路由需要编排者重启 server 才生效——写好后在 `logs/bench-ready.flag` 写入一行，然后**轮询 `GET /api/bench/health`（你的路由里提供）直到可用（最多等 15 分钟）**，期间不要做别的会改数据的事。
- `scripts/gui-bench.mjs`、`bench/**`（测试站点等）
- `docs/gui-success.md`
- 失败时 `docs/fail-WP15.md`

## 设计
- 任务阶梯（在 Space 内用 `python3 -m http.server` 或简单 Python 脚本在 `127.0.0.1:8765` 托管 `bench/site/`，用 `docker exec -d` 启动）：
  - **L1**：打开浏览器访问 `http://127.0.0.1:8765/l1.html`，报告页面上显示的一个随机口令（每次运行由脚本生成写入页面）。判定：回答包含口令。
  - **L2**：表单登录 `l2.html`（用户名/密码给在提示里），登录成功页显示随机口令。判定：回答含口令（服务端校验，登录失败不显示）。
  - **L3**：多步：在 `l3.html` 的列表中搜索指定商品、勾选、点"提交"，结果页显示订单号。判定：服务端记录的提交与期望一致 + 回答含订单号。
  - 每次运行前：关闭浏览器（`pkill -f chromium`），重置站点状态。
- 模式：A=仅截图（tools: `desktop_screenshot, desktop_windows, desktop_launch, desktop_click, desktop_type, desktop_key, desktop_scroll`）；B=截图+无障碍树（再加 `desktop_elements`）。两种模式都不给 `bash`/`read`/`write`/`edit`/`web_search`（避免绕过 GUI）。
- 模型：`glm-5.3`（文本模型，截图对它不可见，A 模式预期很差——这本身是结论）与 `claude-sonnet-5-5`（多模态）。如时间允许加 `gpt-5.6-terra`。
- 次数：每格 3 次（L2 每格 5 次，满足 F02-2），单次超时 6 分钟。总量较大，按 模型→模式→级别 顺序串行跑，进度实时追加写入 `docs/gui-success.md`（中断后可续跑：已有结果跳过）。
- 记录：成功/失败、耗时、工具调用次数、token/cost（从 `/api/usage` 的该 Bot 条目取差值）。

## 验收
- `docs/gui-success.md`：成功率矩阵（级别 × 模型 × 模式）+ 每次运行明细 + 结论（推荐默认模型；L2 成功率是否 ≥ 60%）。
- `npm test` 仍全绿（若加了 bench 路由单测）。

最后输出：改动文件、矩阵摘要、结论、未验证项。
