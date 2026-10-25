# M2-11：集成（编排者执行，不派给并行 worker）

依赖：M2-01 ~ M2-10 合入。

## 只有编排者能改
`src/runtime.mjs`、`src/server.mjs`、`src/config.mjs`、`src/ext/preamble.mjs`、`src/api.mjs`（除 M2-09 已改的 `input` 路由）、`docs/CONTRACTS.md`、`README.md` / `README.zh-CN.md`、`AGENTS.md`、`test/integration-startup.test.mjs`。

## 要做的事
0. **开工前**：`npm ci`，`npm ls @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord` 必须都是 1.4.0；`git status` 干净；M1（PR #4）已合入 `main` 并在其上建分支。
1. **装配**（`src/runtime.mjs`、`src/server.mjs`）：
   - 扩展顺序：`Preamble, CodingTools, Exec, Planmode, Search, History, Routines, Approval, [Stopnote,] Timing`。**Approval 仍在 Timing 之前、其余写工具扩展之后**；`Planmode` 在 `Approval` 之前，这样被计划模式拦下的写工具不会进入审批。
   - `setApprovalResolver`、`setPlanResolver`、`setExecResolver` 在**同一处**装配（会话 → 工作区 → 当前绑定/模式），且仍然在 `harness.resume()` 之前。
   - 重建完成后：调用 `voidApprovalsForWorkspace(workspaceId)`；对新建的 Sprite 在使用前调用 M2-01 的 `provider.waitReady`。
   - 启动时对 `requests.prune({ olderThanMs: 7 天 })` 调用一次。
   - 路由：`src/routes/changes.mjs`、`locks.mjs`、`executions.mjs` 由 `loadRoutes()` 自动加载（它们都在 `src/routes/` 下）；确认缺少依赖时不注册而不是报错。**M1 的教训：写在 `src/routes/` 之外的路由不会被加载**——新增的路由全部放在 `src/routes/`，并在接线测试里逐条断言已注册。
2. **M2-01 对 runner / Exec 的建议改动**：读 M2-01 的汇报，把"检查 `start` 的返回值"和"把连接建立前失败当确定性失败"落到 `src/runner/client.mjs` 与 `src/ext/exec.mjs`，加测试。
3. **旧共享 Sprite 的脚本**：`scripts/sprite-setup.sh`、`scratch/sprite-setup.mjs`、`scratch/sprite-probe.mjs` 退役（`git rm`），或改为只服务 `pca-*`；引用它们的现行文档同步修改（不动 `docs/archive`、历史计划）。`AGENTS.md` 红线里"旧共享 Sprite 可操作"的允许项删除，保留"永远不得删除 `pi-cloud-agents`"。
4. **文档**：`docs/CONTRACTS.md` 新增 §8「写锁、接管、围栏」「Git 改动接口」「审批绑定」「先出方案」「执行状态接口」，写最终接口；`AGENTS.md` 目录表补 `src/routes/{changes,locks,executions}.mjs`、`src/ext/planmode.mjs`；`README.md` / `README.zh-CN.md` 如有现行说明同步。
5. **接线测试**（扩展 `test/integration-startup.test.mjs`，仍是编排者唯一允许新建/改的测试文件）：
   - 所有 M2 路由都已注册（沿用 M1 的 `loadRoutes` 逐条断言写法）；
   - 启动顺序：三个解析器都在 `harness.resume()` 之前就绪；
   - 一个被打断的 `bash`（在持有锁时）重启后重入，能解析到工作区、锁与绑定；
   - 重建后：待审批项被作废、旧绑定的 Exec 重放得到「结果待确认」。
6. **合入后跑**：`TARSBOT_NO_DOTENV=1 npm test`、`cd web && npm test && npm run typecheck && npm run build`，修掉集成问题。
7. 并行 worker 汇报里"对 PLAN 契约的偏离"逐条处理：要么改代码，要么更新 `docs/M2-PLAN.md` / `CONTRACTS.md`，不留不一致。同时核对 M2-02 与 M2-09 对 `store.mjs` 的改动没有互相覆盖。
8. **代码审查**：集成完成后对整个 M2 diff 做一次 `/code-review xhigh`，修完再进验收（M1 的审查发现了 12 条，其中 10 条需要修）。

## 验收
全部自动化通过（含接线测试）；服务在空 `TARSBOT_DATA_DIR` 下正常启动；缺少 `SPRITES_TOKEN` 时启动即报明确错误；`/api/workspaces`、`/api/workspaces/:id/lock`、`.../changes`、`/api/executions` 在真实启动的服务上都能访问（不是只在测试里）。
