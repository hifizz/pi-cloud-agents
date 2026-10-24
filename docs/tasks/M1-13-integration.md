# M1-13：集成（编排者执行，不派给并行 worker）

依赖：M1-01 ~ M1-12 合入。

## 只有编排者能改
`src/runtime.mjs`、`src/server.mjs`、`src/config.mjs`、`src/ext/preamble.mjs`、`docs/CONTRACTS.md`、`README.md`（及 `README.zh-CN.md`）。

## 要做的事
0. **开工前**：`npm ci`，`npm ls @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord` 必须都是 1.4.0（本机曾是 1.0.4，见 `docs/m1-probe.md` §1）。之后的所有测试结论才有效。
1. `src/config.mjs`：新增 `controlDbPath`（`<dataDir>/control.sqlite`）、`checkpointDir`（`<dataDir>/checkpoints`）。**没有 `workspacesEnabled` 开关**：项目是全新开始，不需要保护旧部署；缺少 `SPRITES_TOKEN` 时启动即报明确错误。
2. `src/server.mjs` **启动顺序（PLAN §3.6，顺序错了会出现“工具在解析器就绪前被重放”）**：
   1. 打开控制库；`meta.ensure("namespace")`、`meta.ensure("generation")`；
   2. 创建 `github`、`providers.sprites`、检查点服务、重建函数；
   3. `bootstrap({ resume: false })` 打开 Harness（**不调度**）；
   4. `setExecResolver(...)`（会话 → 工作区 → 当前绑定 → runner）；创建工作区服务；
   5. `await workspaces.resumePending()`；
   6. **最后** `harness.resume()`；
   7. `createApi` 的 `ctx` 注入：`workspaces`、`github`、`control`、`checkpoints`、`rebuild`、`runtimeBash(workspaceId)`；
   8. 关闭时先关 API、再关 Harness、最后关控制库。
   不再保留“今天的启动流程”：删除 `server.mjs` 里“没有 Bot 就创建 `tars`”的逻辑（没有工作区的 Bot 在新设计下不可用）。`src/repl.mjs` 同理，**待用户确认**：删除，还是改成接收工作区 id。确认前不要自行决定。
3. `src/runtime.mjs`：`productionEnv()` 改为 `createWorkspaceEnv({ store, providers })`（不再有 `spaceEnv()` 回退）；`productionExtensions()` 里在 `CodingTools` 之后装 `Exec`（同名覆盖内置 `bash`，所有 Bot 共用），保持 **Approval 最后**。`bootstrap` 增加 `resume` 透传（默认 true，server 传 false）。删除不再使用的全局沙箱配置与路由：`src/routes/space.mjs`（`/api/space`）、`config.sandbox` / `spaceCwd` 相关、`src/sandbox/index.mjs` 的 `loadSandbox` 与 E2B 选择，**除非它们仍被别的代码引用——删除前先 `rg` 确认引用，有引用的先回报**。`src/sandbox/sprites.mjs` 的 `createSpritesBash` / `redactMessage` 仍被供应商使用，保留。
4. `src/ext/preamble.mjs`：保留通用 preamble；确认 `workspaceInstructions` 追加到 instructions 后，与 preamble 的 clone / 建分支步骤不冲突（必要时在 preamble 中加一句「如果后面的工作区说明给出了仓库和分支，以它为准」）。
5. `docs/CONTRACTS.md`：新增 §7「工作区、控制库、供应商、runner」，把 `docs/M1-PLAN.md` §4 的最终签名收进来；§2 说明沙箱原语仍在，新增供应商接口；`AGENTS.md` 的「目录结构」表补新目录（`src/control/`、`src/providers/`、`src/runner/`）。
6. 合入后跑：`TARSBOT_NO_DOTENV=1 npm test`、`cd web && npm test && npm run typecheck && npm run build`，修掉集成问题。
7. 并行 worker 回报里「对 PLAN 契约的偏离」逐条处理：要么改代码，要么更新 PLAN / CONTRACTS，不留不一致。
8. **接线测试**（新增 `test/integration-startup.test.mjs`，这是编排者唯一允许新建的测试文件）：用临时数据目录、假 provider、`fauxProvider`：在 `bootstrap({resume:false})` 之后、`resume()` 之前断言解析器已就绪；模拟“有一个被打断的工具调用”，重启后断言它重入时能解析到工作区，而不是报“解析不到”。

## 验收
全部自动化通过（含上面的接线测试）；服务在没有任何旧数据的空 `TARSBOT_DATA_DIR` 下正常启动，缺少 `SPRITES_TOKEN` 时启动即报明确错误。
