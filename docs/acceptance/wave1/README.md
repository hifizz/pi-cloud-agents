# Wave 1 验收：S0-node24 + S3-approval

日期：2026-10-13。执行环境：cua 模式（sandbox 开关尚未实现），Space `tarsbot-probe`，server `node src/server.mjs`（:8090），Node v24.21.0。

自动化：`npm test` 112/112 通过。

EGO 浏览器操作：
1. 打开 `http://127.0.0.1:8090`，新建 Bot `wave1-accept`。
2. 指令：先执行 `echo WAVE1-OK; node -v; uname -s`，再执行 `git push --force origin tarsbot/none`。
3. 第一次 bash 直接执行（`done`），输出 `WAVE1-OK / v24.21.0 / Linux`。
4. 第二次 bash 出现审批条，reason 为 "git push that rewrites remote history ..."（`01-approval-force-push.png`）。
5. 点 Deny：工具结果为 error，Bot 回复 force push 被拒、远端未改变（`02-denied-result.png`）。

附带观察：首次打开页面时右栏显示 "Desktop viewer unavailable"，刷新后 iframe 正常加载 `http://127.0.0.1:3309/viewer/`。原因是 server 刚启动时 Space 连接尚未就绪，属于 cua 模式既有行为，与本波改动无关。

结论：PASS。
