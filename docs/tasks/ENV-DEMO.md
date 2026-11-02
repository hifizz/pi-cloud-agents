# ENV-DEMO：工作区默认环境变量与 Session 覆盖

## 用户目标与授权
用户希望先跑通 Demo，接受同工作区多个 Session 共享 Sprite、环境变量不是强安全隔离。实现后开 Draft PR，PR 本身必须讲清来龙去脉、配置操作、继承和生效规则、限制、验证与后续 Phase 3 关系。不合并、不部署。

## 基线
仓库 /Users/zilin/side/pi-cloud-agents，基线 integration/amp13-loops-demo @ 0d4bb10。包含 PR12/21/23/24/25，不包含 main 上的 Codemode PR10。新 PR base 为 integration/amp13-loops-demo，不能以 main 为 base 混入整套集成内容。

## 必须实现的最小闭环
- 在现有 Environment UI 中提供工作区默认变量和当前 Session 配置入口。无需建立通用配置平台。
- 工作区持久化默认变量。普通 Session 动态继承默认值，可覆盖、恢复继承、显式禁用。禁用是 unset，不是空字符串；空字符串为有效值。
- 配置保存后仅新命令/新 PTY 生效，已运行服务或终端需重启。不要修改服务器 process.env 或 Sprite 全局 shell 配置。
- Agent runner bash、命令控制台、交互 PTY 采用一致的 Session 有效配置。预览里的应用继承其启动进程环境，不另设预览配置层。
- 配置不能影响服务器控制命令、GitHub受控操作或安装集成的宿主进程。注意 PATH/HOME/SHELL/BASH_ENV/ENV/LD_*/DYLD_*/NODE_OPTIONS/PCA_*/GH_TOKEN/GITHUB_TOKEN/TARSBOT_* 等控制环境或凭据变量必须保留/限制，给清楚错误。
- Loop run、只读 fork 不自动获得新增环境配置，也不允许通过面板/手动执行入口扩权。委派子 Session 不复制父 Session overrides，可按其独立普通 Session 身份继承工作区默认值；必须显式文档说明。其他 Session 类型也要给出明确继承表。
- 同 Sprite 不是强隔离，是用户明确接受的 Demo 边界，不必造新 Sprite 或容器。

## 密钥与传输
- 不读取/回显 .env，不使用真实密钥做测试；不得把用户值写进命令文本、会话历史、普通元数据、日志、截图、Git 或 Sprite 持久文件。用户自己的程序主动输出值不可能完全阻止，文档不能承诺绝对保密。
- 控制服务端加密保存用户变量。主密钥只从 env/Fly secret 获取，缺失时清楚禁用功能或报配置错误，不生成隐式明文后备。用 node:crypto，不新增重依赖。配置值 API 只接受写入、返回名字/来源/遮罩状态，不返回明文；改名/覆盖/删除原子性注意。
- 现有 AGENTS.md 的所有密钥来自 env/secrets 约定需明确添加用户应用变量例外，不削弱系统密钥限制；docs/CONTRACTS.md 与部署文档同步记录新主密钥需求和备份/丢失影响。
- src/providers/sprites.mjs 的 PTY 有显示变量白名单，原因是 Sprite SDK env 在 exec URL query 中。不能简单放开白名单给密码；检查 SDK 源码，采用不会把变量值放到 URL/argv/回显的安全启动传输，例如 stdin bootstrap，保留现有确认 UI 和鉴权。若无法安全完成，停下报告具体阻塞，不悄悄宣称 PTY 支持。
- runner 已有 prepare/start env，prepare 只落变量名。不要把原始值放到 durable memo。检查恢复与新配置生效边界，旧进程重连不能重启或换配置重放；必要时记录配置版本而不是秘密。

## 已知接线点
- src/runner/client.mjs prepare/start env 和 supportsEnv。
- src/ext/exec.mjs resolver 返回 execEnv。生产 bash 替换了 SandboxEnv 的 bash 工具，只改 workspace-env 不够。
- src/server.mjs exec resolver、runtimeBash(workspaceId)、ptySession(workspaceId)。生产装配逻辑集中服务模块，server只做必要装配。
- src/terminal-env.mjs console/PTY 两套入口。
- src/providers/sprites.mjs bash overlay、pty白名单；src/sandbox/sprites.mjs per-call env、错误脱敏。
- web/src/components/EnvironmentPane.tsx，web/src/panels/environment/。
- src/routes/* 必须已有 auth 守卫，不改 api.mjs 本体。

## Worker 修改边界
你只能创建/修改以下路径内为本功能必要的文件：src/ 下的 .mjs（不得修改 src/api.mjs）；web/src/；test/；docs/CONTRACTS.md；docs/DEPLOY.md；docs/tasks/ENV-DEMO.md；docs/acceptance/env-demo/README.md；AGENTS.md。不要改依赖版本，不改其他任务或验收记录。需要其他路径先报告。独立 worktree，一名 writer；不 commit、不 push、不开 PR、不启动 server 或浏览器、不占 8090/5183、不调用远端 Sprite/GitHub 写操作、不派发子 agent。

## 验证
- 离线覆盖工作区继承/Session覆盖/恢复/禁用/空值/多Session不串值/越工作区拒绝/鉴权/保留名/加密保存/不回显/重启读回/缺主密钥。
- 测试 Agent Exec、console、PTY 实际进程收到变量，值不进 URL/argv/runner files；安全敏感部分不能只检查对象 shape。Loop/fork权限回归。
- TARSBOT_NO_DOTENV=1 npm test 全绿；cd web && npm test && npm run typecheck && npm run build；git diff --check。
- test/runner.test.mjs 的子测试依赖首个 install 用例，定向跑 env 测试时必须包含 install，否则是测试筛选错误。
- 父级接收后统一 EGO 验收，使用虚构变量，截图 docs/acceptance/env-demo/，worker不要伪造 PASS。

## 输出
报告 worktree/branch、改动文件、具体行为与接口、测试命令和结果、风险/未完成、父级浏览器验收步骤。docs/acceptance/env-demo/README.md 可先写自动化证据和待父级执行项，明确未做浏览器验收。提交前独立审查与 PR 发布由父级负责。

## PR 必备上下文
解释为何环境变量是独立功能而非 Phase3；关联 #26、#22、base PR25；不包含 Codemode；用户已接受共享 Sprite 限制；如何设置和验证；覆盖/禁用/恢复继承与空字符串区别；新进程生效与服务重启；全部 Session 类型继承规则；保留变量；存储/传输/主密钥和备份；PTY完全访问、应用主动输出泄密边界；Loops/MCP授权不扩展；自动化与真实浏览器证据分开；明确非部署/不合并。
