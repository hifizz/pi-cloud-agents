# Issue13 + Loops Phase1/2 组合验收

## 交付范围

Issue13正常路径与Loops Phase1/2组合Demo。Phase3延期Issue22。本地组合分支 `integration/amp13-loops-demo`，合并65c5292（PR23）与3267eb7（PR24，依赖PR21）。不合main、不部署。

## 父级实际验证

- Loop深链接打开真实run，Git显示独立loops分支、提交84c0513；Files读取本次验收文件，Environment显示PR15和测试“未记录”。截图01/02/03。
- 受限read Loop文件上传403、委派409；console/PTY后端拒绝且UI给出说明。正常Session的PTY/MCP/Skill路径此前已验收，无权限扩张。
- UI订阅真实PR15，Checks API读到head84c0513 success；重启后pollCount1、订阅与状态保持、无错误。截图04和events-restart.json。
- 真实Issue13评论6545637922先经本地签名Webhook触发run_2dc96e24866dd377，再经两次审批推送并开Draft PR16。仅新增LOOPS-ISSUE-ACCEPTANCE.txt，未改已有文件。pr16.json。
- Issue总览正确显示该Loop运行的PR16和“测试记录未记录”，没有假人工PASS。截图05。
- 之后轮询补读同一事件，仍仅1run，队列清空。webhook-first-dedup.json。Webhook是本地签名重放真实GitHub载荷，不是公网GitHub App部署。
- 从总览打开PR16 Review，detached目录正确；重复点击前后15个Bot不增加，复用同Session。截图06。
- 所有验收Loop与Issue13后台同步已停用，避免留无人值守任务。

## 自动化

父级最后完整测试：后端552项，551 pass / 1既有skip / 0fail；前端224 pass；typecheck/build通过；git diff检查通过。日志 `/tmp/combined-final-{backend,web,build}.log`。

事件矩阵、label/assigned负转正、PR checks/reviews、跨repo、审批拒绝零副作用、敏感路径与跨Session草稿等使用确定性离线测试。未对每种事件执行远端修改，不宣称每项都现场重演。

## 本次组合修复

- 同时装配Loops、MCP/Skills、PTY、GitHub订阅服务。
- 各面板优先loopRun真实目录；受限Loop和只读fork不能借手动console/PTY/上传/委派扩大权限。
- Loop不自动获得工作区MCP工具（Phase3细粒度授权未实施）。普通Session可用已安装MCP与Skill。
- PR订阅此前只有API无UI按钮，新增“订阅后续事件”入口。
- 普通Session跳转时清理旧loopRun参数，避免两种deep link相互冲突。

## 本地运行

服务绑定127.0.0.1:8090，保留白名单登录。组合验收使用独立 `/tmp/pca-loops-acceptance`，原repo `data/`未迁移、删除或覆盖。已有Sprite仍是pca-eae56f671c。
本地MCP `node scripts/acceptance-mcp.mjs`，端点127.0.0.1:8791/mcp，仅加法工具。应用设置精确 `TARSBOT_MCP_LOCAL_ENDPOINTS=http://127.0.0.1:8791/mcp`。

## 已知边界

- 单Sprite同一信任域，不是恶意进程强隔离；受控push清洁git上下文不能解决同用户进程窥探。
- PTY有限ANSI渲染；Preview已测HTML/CSS/JS，不承诺任意SPA/HMR/WebSocket。
- MCP已测HTTP子集，无OAuth/stdio；Skill支持快照粘贴/工作区文件安装。
- GitHub轮询受API历史窗口限制；公网hook部署不属于本轮本地验收。
- Phase3（逐工具自动批准、模板、限额等）未开发，见Issue22。
- 不删除用户文件、无force push、无PR merge、无部署。测试仓库PR15/16保留Draft供审阅。
