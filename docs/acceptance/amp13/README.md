# Issue13 本地功能验收

## 状态

正常路径已逐项在本地真实Sprite与EGO操作，证据见下。当前为Draft交付，不宣称所有边界/组合验收结束。

最终本轮自动化：后端462项（461 pass、1既有skip）；前端214 pass；typecheck/build与git diff --check通过。日志 `/tmp/amp13-closeout-{backend,web,build}.log`。

## 现场通过的路径

| 功能 | 实际观察 | 截图 |
|---|---|---|
| Files | 真实Session目录，读取已有演示文件，上传新带空格文件名并回读 | 01 |
| Console | 正确cwd、真实输出、exit3；运行中取消exit143，之后新命令exit0 | 02、11 |
| Git | bash/上传产生的untracked变更、真实diff、commit diff、main比较 | 03、04 |
| Preview | Files上传HTML/CSS/JS，控制台启动8765服务，iframe内导航、资源与点击计数 | 08、17 |
| Search | 搜索另一Session、预览entry241、显式引用到当前Session | 05 |
| Delegation | 独立child执行与显式结果回传；新child Files/Git/PTY目录一致 | 06、07、16 |
| GitHub Events | 新真实评论进入feed并只投递1次；后台60s轮询无需手动同步 | 09、18 |
| Skill | UI安装，Pi实际load_skill；停用拒绝、卸载；文件安装、新Session继承、重启保留 | 14、21、22、23 |
| MCP | UI安装本地真实MCP；审批前远端toolCalls=0、批准后1，sum42；停用拒绝；重启后sum5 | 19、20、21 |
| PTY | 用户确认后真实shell，pwd/branch和read stdin正确，Kill关闭 | 15 |
| 分享/窄屏 | 另一页面深链接、刷新与返回；390px消息发送，无横向溢出 | 10 |
| Review/结果 | 同SHA复用bot9f13b125（前后bot数12），人工状态/结果仍显示 | 12、13 |

截图文件名为本目录编号PNG。通知权限由用户批准后实测permission=granted，不是后台push。

## 安全验证

- 新HTTP/WS匿名实际401，记录auth-checks.json。
- Preview有效限定cap可无cookie读资源；无凭据/错误cap401；响应sandbox CSP、nosniff；cap没有记录进证据，见preview-auth.json。
- 敏感路径、跨空间、readOnly、MCP namespace冲突、HTTP凭据拒绝由离线测试验证。
- 独立审查 `/tmp/pca-amp13-review.md`，接受的namespace/凭据问题已修；父级另修Git退出码/空格路径。

## 环境

本地127.0.0.1:8090，白名单登录保持。唯一现有workspace ws_e168e5f97244a35b / Sprite pca-eae56f671c / repo hifizz/tars-sandbox-playground。
本地MCP：`node scripts/acceptance-mcp.mjs`，仅127.0.0.1:8791，只有加法工具、无文件/shell/network权限。应用启动显式配置 `TARSBOT_MCP_LOCAL_ENDPOINTS=http://127.0.0.1:8791/mcp`；精确URL匹配，其他loopback/私网仍拒绝，非全局关闭SSRF。

## 限制与待验

- 后台轮询重启恢复、订阅PR checks真实状态变化仍待最终现场复验。
- 部分旧功能负例仅离线验证，最终组合版本需统一复跑。
- MCP只验证当前HTTP协议工具子集及本地服务，不承诺OAuth/stdio/SSE长流或任意厂商。Skill快照安装支持粘贴和工作区文件，不执行安装脚本。
- PTY有限ANSI显示，不承诺vim/CJK完整终端兼容；人工shell完全访问该Sprite，无逐命令审批，Agent工具审批不变。
- Preview支持测试过的静态HTML/CSS/JS；任意SPA绝对fetch/HMR/WebSocket未验证。能力URL15分钟有效，应用同信任工作区。
- 单workspace共享Sprite不是安全隔离。
- 当前工作与Loops独立分支，合并后仍需完整组合验收。Phase3后续Issue22，不在本轮。

无用户已有文件删除/覆盖，无新Sprite。仅在测试Session新增验收文件和worktree。没有部署或合并。
