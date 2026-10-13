# AGENTS.md

本仓库（分支 `feat/sprites-shell`）的 agent 工作约定。任务说明见 `docs/SPRITES-PLAN.md` 与 `docs/tasks/S*.md`。

## 验收：每个大任务完成后，必须用 EGO 浏览器验收

"大任务"指 `docs/tasks/` 下的一个任务文件（如 `S1-env`），或一个验收级别（L0–L3）。单元测试通过不算验收完成。

步骤：

1. 跑完任务文件中的自动化验收（`npm test` 等），全部通过后再做浏览器验收。
2. 启动 server：`npm start`（`http://127.0.0.1:8090`）；改了前端时用 `cd web && npm run build` 后再启动，或用 Vite dev（`http://127.0.0.1:5183`）。
3. 用 EGO 浏览器（ego-browser skill）打开 UI，按任务内容实际操作一遍，例如：
   - 新建 Bot，发一条与本任务相关的指令（S1/S2：在 Sprite 中建文件；S3：开 PR；S4：重启后对话续上）。
   - 检查右栏、审批条、工具调用卡片、Bot 最终回复是否符合预期。
   - 纯后端任务（如 S0、S1-bash）至少确认：UI 能打开，Bot 能完成一次 `bash` 调用且无报错。
4. 截图保存到 `docs/acceptance/<任务ID>/`（如 `docs/acceptance/S2-runtime-ui/01-sidebar.png`），截图中不得出现任何 token。
5. 在任务汇报中写明：操作步骤、观察到的结果、截图路径、PASS / FAIL。FAIL 时附浏览器控制台错误与 server 日志相关片段。

浏览器验收失败时，任务不算完成，先修复再重新验收。

## 其他约定

- 密钥只放在 `.env`（已在 `.gitignore`）；不得打印、写日志、写入 `data/`、测试快照或截图。
- 只修改任务文件"你只能创建/修改"中列出的文件。
- 远端资源只操作 `TARSBOT_SPRITE_NAME` 指定的 Sprite 和测试仓库 `hifizz/tars-sandbox-playground`；同一 org 下的其他 Sprite 不得改动。
