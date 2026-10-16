# Cloud / C1-backend：删除 Cua 后端，Sprites 成为唯一沙箱

依赖：无（与 C2–C6 并行）。

先读：`docs/CLOUD-PLAN.md`（全文，尤其 §3、§7）；`src/config.mjs`、`src/env.mjs`（`defaultBash`、`defaultEnvId`、`CuaEnv`、`spaceEnv`）、`src/runtime.mjs`、`src/server.mjs`、`src/routes/space.mjs`、`src/ext/preamble.mjs`、`src/bots.mjs`、`src/sandbox/sprites.mjs`。
先执行 `grep -rn -i "cua\|space\.mjs\|viewer-proxy\|desktop" src test scripts scratch package.json` 列出全部入口。

## 你只能创建/修改/删除

- 删除：`src/space.mjs`、`src/viewer-proxy.mjs`、`src/ext/desktop.mjs`、`src/routes/bench.mjs`、`test/space.test.mjs`、`test/desktop.test.mjs`、`test/recovery.test.mjs`、`test/bench.test.mjs`、`scripts/space-up.sh`、`scripts/space-down.sh`、`scripts/space-theme.sh`、`scripts/space-desktop-state.sh`、`scripts/kill-test.sh`、`scripts/gui-bench.mjs`、整个 `bench/` 目录；`scratch/` 下 Cua 文件：`desktop-demo.mjs`、`space-call.mjs`、`space-probe.mjs`、`get_desktop_state.json`、`get_window_state.json`、`list_apps.json`、`list_windows.json`、`launch_app.json`；`scratch/env-demo.mjs` 读后若是 Cua 专用也删。
- 修改：`src/config.mjs`、`src/env.mjs`、`src/runtime.mjs`、`src/server.mjs`、`src/routes/space.mjs`、`src/ext/preamble.mjs`、`src/ext/approval.mjs`（仅注释）、`src/bots.mjs`、`src/sandbox/sprites.mjs`（仅当需要加 `info` 别名）、`scripts/approval-test.sh`（仅注释）、`scripts/sprites-kill-test.sh`（去掉 `TARSBOT_SANDBOX=sprites` 若已无意义）
- 测试：`test/env.test.mjs`、`test/api.test.mjs`、`test/fork.test.mjs`、`test/preamble.test.mjs`、`test/approval.test.mjs`、`test/sprites.test.mjs`、`test/vitest/env-conformance.test.mjs`
- `package.json`、`package-lock.json`（移除 `@trycua/cua`，更新 `description`；用 `npm uninstall @trycua/cua` 生成 lock，其余依赖版本不变）
- 失败时 `docs/fail-C1-backend.md`

**不要碰**：`src/api.mjs`、`src/routes/auth.mjs`、`src/auth.mjs`（C2）；`web/`（C3）；Dockerfile / fly.toml（C4）；`scratch/sprite-*.mjs`、`scripts/sprite-setup.sh`（C5）；README / AGENTS / docs（C6）。

## 要求

1. `config.mjs`：删除 `SANDBOXES` 与 cua 分支。保留字段名 `sandbox`（固定 `"sprites"`）、`spriteName`（`TARSBOT_SPRITE_NAME`）、`home`（`/home/sprite`）、`spaceCwd`（`/home/sprite/workspace`）。`sandboxSettings` 可删除或简化为不再读 `TARSBOT_SANDBOX`（设置了也忽略）。`host` 改为 `process.env.TARSBOT_HOST ?? "127.0.0.1"`。其余字段不变。
2. `env.mjs`：`CuaEnv` 改名 `SandboxEnv`（可保留 `export { SandboxEnv as CuaEnv }` 兼容别名，但测试改用新名）。`defaultBash` 直接调用 `sandbox/sprites.mjs` 的 `spritesBash`（保持懒加载 `@fly/sprites` 的行为即可）；`defaultEnvId` 返回 `sprites:<spriteName>`；`spaceEnv()` 无条件要求 `TARSBOT_SPRITE_NAME`。删除所有 "Cua Space" 措辞，"Space command timed out" 改为 "Sandbox command timed out"（同步测试）。
3. `runtime.mjs`：`productionExtensions()` 固定为 `[Preamble, CodingTools, Search, History, Routines, Approval, Timing]`（Approval 在 Timing 前、其他工具之后的顺序不变；保持 async 签名以兼容调用方）。
4. `routes/space.mjs`：只保留 `GET /api/space` → `getSpriteInfo()`（`{sandbox:"sprites", name}`），删除 viewer proxy、docker、`@trycua/cua` 相关代码与 `TARSBOT_VIEWER_PORT`。
5. `preamble.mjs`：删除 `PREAMBLE_CUA` / `preambleFor`，sprites 文本作为唯一 `PREAMBLE`；`createPreamble` 去掉 sandbox 参数（保留可注入文本的测试钩子即可）。
6. `bots.mjs`：`READ_ONLY_TOOLS` 去掉 `desktop_*`。
7. `server.mjs`：删除 "WARNING: API has no authentication; bound to 127.0.0.1 only" 这行（鉴权由 C2 的路由插件提供）；监听日志打印 `config.host:port`。不要改 `loadRoutes`。
8. 测试全部改为 sprites 语义（`/home/sprite/workspace`、`sprites:<name>`），删除 cua 模式用例；`fork.test.mjs` 用 CodingTools 的工具（如 `write` / `read`）替代 `desktop_*` 断言。注意 `test/api.test.mjs` 约 316–329 行用 `loadRoutes()` 加载全部插件并传入假 `app`：C2 会新增 `src/routes/auth.mjs`，它在 `register` 时调用 `app.guard(...)` 并读取 auth 环境变量，所以该假 `app` 必须带 `guard() {}`，且测试进程设置临时 `TARSBOT_DATA_DIR`（或直接删掉该用例）。
9. 完成后 `grep -rn -i "trycua\|cua\b\|CuaEnv\|space\.mjs\|viewer-proxy\|desktop_" src test scripts scratch package.json` 只允许出现兼容别名一处（若保留）。

## 验收

- `TARSBOT_NO_DOTENV=1 npm test` 全绿（`test/auth.test.mjs` 若由 C2 同时在写而失败，注明后忽略）。
- `node -e "import('./src/runtime.mjs').then(async m => console.log((await m.productionExtensions()).map(e => e.name)))"` 输出不含 desktop。
- `TARSBOT_SPRITE_NAME=x node -e "import('./src/env.mjs')"` 不加载 `@trycua/cua`（包已卸载，能 import 即证明）。
- 不运行 `npm start`、不做浏览器验收（C7 统一做）。

最后输出：改动/删除文件列表、测试命令与结果、grep 结果、未验证项、需要编排者集成的改动。
