# L0 / L1 验收：S1-bash + S1-env + S2-runtime-ui

日期：2026-10-13。server：`TARSBOT_SANDBOX=sprites node src/server.mjs`（:8090），Sprite `tarsbot-dev`。

自动化：
- `npm test` 147/147；`cd web && npm run build` 成功，web 测试 52/52。
- L0：`TARSBOT_SANDBOX=sprites npm run test:env` 24/24（真实 Sprite，147.7 s）；cua 模式 24/24。
- sprites 模式启动日志无 Space / docker 相关输出；`GET /api/space` → `{"sandbox":"sprites","name":"tarsbot-dev"}`。

EGO 浏览器操作：
1. 打开 `http://127.0.0.1:8090`：右栏标题 Environment，显示 "执行环境 Sprite tarsbot-dev / 工作目录 /home/sprite/workspace"，无桌面 iframe。
2. 新建 Bot `l1-sprite`，指令：在 `~/workspace/hello-browser.txt` 写入 `BROWSER-L1-OK` 并 `cat`、`uname -a`、`pwd`，再用 read 工具读回。
3. bash 卡片 `done`，输出 `BROWSER-L1-OK`、`Linux tarsbot-dev 6.12.105-fly ... x86_64`、`/home/sprite/workspace`；read 卡片 `done`；Bot 最终回复正确（`01-sprite-bot.png`）。
4. 独立核对：本地 `spritesBash("cat /home/sprite/workspace/hello-browser.txt")` → `BROWSER-L1-OK`。
5. 泄漏检查：`data/`、`logs/`、`docs/` 中 grep 4 个密钥原文，无命中。

结论：PASS。

已知遗留：系统提示仍描述 XFCE 桌面（S3-preamble 处理）；P5–P10 耗时探针未测，默认 exec 超时 10 分钟未经实测。
