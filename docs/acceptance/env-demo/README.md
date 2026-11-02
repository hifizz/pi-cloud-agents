# ENV-DEMO 浏览器验收记录

## 当前状态

最终实现的正常路径已由父级在 EGO 和真实测试 Sprite 跑通，浏览器验收 PASS。父级已复核修复及全量自动化；最终独立针对性复核确认 9 项已知问题均可关闭，无剩余明确代码阻塞。未部署、未合并。

## 环境

- 代码基线 `integration/amp13-loops-demo @ 0d4bb10`，实现位于独立 worktree。
- 本次服务 `http://127.0.0.1:8091`，独立数据 `/tmp/pca-env-demo-20261101`，原 `8090` 服务及 `/tmp/pca-loops-acceptance` 数据不修改。
- 保留登录鉴权，使用独立验收账号。临时主密钥仅在验收 supervisor 内存中生成并传给应用进程，没有复制 `.env` 或把主密钥保存到证据文件。
- 复用已有测试 Sprite `pca-eae56f671c` 和测试仓库 `hifizz/tars-sandbox-playground`，没有创建或释放 Sprite。仅执行环境检查命令，无文件修改、Git 提交、push、PR 创建。
- 验收变量全部为虚构值；命令只输出检查标记，不枚举其他环境变量。截图中的命令比较字面量为虚构验收数据，不是真实凭据。

## 父级已观察的正常路径

| 操作 | 实际观察 | 证据 |
|---|---|---|
| 登录后在 Environment 添加工作区 `DEMO_DATABASE`，Session A 覆盖 | 值输入为密码框，保存后只显示变量名和来源 | `01-config.png` |
| Session A 命令控制台执行比较 | `CONSOLE_ENV_PASS`，exit 0 | `02-console.png` |
| SWE-2 真实 Agent 调用 bash 执行比较 | 实际 Shell 工具调用完成，Agent 返回 PASS | `03-agent-pty.png` |
| 用户确认后打开 PTY，执行比较 | `PTY_ENV_PASS`，没有变量 payload 回显；验收后 Kill | `03-agent-pty.png` |
| Session A 禁用已有工作区变量，用 `${DEMO_DATABASE+x}` 检查不存在 | `DISABLED_UNSET_PASS`，exit 0 | `04-disabled.png` |
| 恢复继承后启动新命令 | `RESTORE_INHERIT_PASS`，exit 0 | EGO 运行记录 |
| 切到 Session B | 显示继承工作区默认，不复制 A 的覆盖 | `05-restart-session-b.png` |
| 重启应用子进程，保留 supervisor 内存主密钥 | 重新打开页面后配置仍在，B 新命令 `RESTART_SESSION_B_PASS`，exit 0 | `05-restart-session-b.png`、EGO 运行记录 |
| 保存空字符串，再检查变量存在且长度为零 | `EMPTY_IS_SET_PASS`，exit 0 | EGO 运行记录 |
| 尝试设置保留名 PATH | 明确显示保留名错误，不保存 | `06-reserved-name.png` |

重启时浏览器曾早于服务监听而出现一次 `ERR_CONNECTION_REFUSED`，确认服务已重新监听后重新导航成功；不是变量恢复失败。

## 自动化复跑

父级在最终实现上复跑：后端 587 项，586 pass、1 skip、0 fail；前端 232 pass；typecheck/build 通过。日志 `/tmp/env-demo-parent-final-backend.log` 和 `/tmp/env-demo-parent-final-web.log`。构建保留既有 bundle-size warning。

最终测试补有 `test/env-pty-real.test.mjs` 和 Python stdlib PTY fixture，实际验证长值/引号/分片、终端关闭回显失败、decode/export失败和超时。`test/exec.test.mjs` 验证旧 runner 自动升级及真实 ambient unset；`test/integration-startup.test.mjs` 验证生产装配恢复运行时不解析新密钥，且新任务缺密钥拒绝。故障注入属于本机确定性测试，不冒充每项都在远端复现。

## 最终版针对性重验

- 重启 8091 子进程加载最终源码，重建前端后刷新页面。
- UI 设置 Session A 覆盖，真实 PTY 输出 `FINAL_PTY_PASS`。启动无 READY/APPLIED 握手标记、无 payload 回显；截图 `07-final-pty.png`。
- 同时运行真实 Agent bash 与控制台，两者分别输出 `FINAL_AGENT_PASS`、`FINAL_CONSOLE_PASS`；Agent 工具卡展开显示真实结果，控制台 exit 0。截图 `08-final-agent-console.png`。
- UI 添加仅属于 Session 的变量，随后禁用，控制台以 `${DEMO_SESSION_ONLY+x}` 验证不存在，输出 `SESSION_ONLY_DISABLED_PASS`、exit 0。截图 `09-final-session-only-unset.png`。父环境同名值的故障场景由真实本地进程回归覆盖。
- 未登录请求环境变量 API 实测 HTTP 401。
- 最终截图已查看，无真实 token；图片中的 `session-demo` 为虚构比较值。

## 审查与保留边界

前两轮审查指出的问题已在最终源码中修复，并补真实回归。包括每调用重试配置隔离、三路 stdin 传输、PTY READY/APPLIED 握手与失败关闭、真正 unset、旧 runner SHA 校验升级、恢复跟踪不依赖当前密钥，以及 UI 错误处理。`RUNNER_VERSION` 仍为 2，升级使用 version 与 SHA 双检查，已有运行不重新安装/启动。

共享 Sprite 非强隔离仍为用户接受的 Demo 限制。没有真实数据库连接测试，不承诺用户程序主动输出变量时的保密性；没有远端 Loop/MCP 权限组合现场重演，受限路径由离线测试验证。
