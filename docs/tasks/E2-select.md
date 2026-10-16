# E2B / E2-select：按 `TARSBOT_SANDBOX` 选择沙箱

依赖：契约 `docs/E2B-PLAN.md` §3（与 E1 并行；E1 写 `src/sandbox/e2b.mjs`，你按契约面向它的 `bash`/`info` 导出编程，**不要创建或修改 e2b.mjs**）。

先读：`docs/E2B-PLAN.md`（全文）、`docs/CONTRACTS.md` §2、`src/config.mjs`、`src/env.mjs`（`defaultBash`、`defaultEnvId`、`spaceEnv`）、`src/sandbox/sprites.mjs`（只看导出）、`src/routes/space.mjs`、`src/ext/preamble.mjs`、`src/server.mjs`、`src/runtime.mjs`、`test/env.test.mjs`、`test/preamble.test.mjs`、`test/api.test.mjs`（`/api/space` 那段）、`test/vitest/env-conformance.test.mjs`、`web/src/components/EnvironmentPane.tsx`、`web/src/types.ts`。
先执行 `grep -rn "spriteName\|getSpriteInfo\|spritesBash\|/home/sprite\|sandboxSettings" src test web/src scripts scratch` 列出全部引用。

## 你只能创建/修改

- `src/config.mjs`、`src/env.mjs`、`src/sandbox/index.mjs`（新建）、`src/routes/space.mjs`、`src/ext/preamble.mjs`
- `test/env.test.mjs`、`test/preamble.test.mjs`、`test/api.test.mjs`（仅 `/api/space` 相关断言）、`test/sandbox-select.test.mjs`（新建）、`test/vitest/env-conformance.test.mjs`
- `web/src/components/EnvironmentPane.tsx`、`web/src/types.ts`（仅 `SpaceInfo`）

**不要碰**：`src/sandbox/sprites.mjs`、`src/sandbox/e2b.mjs`、`src/runtime.mjs`、`package.json`、`scripts/`、文档。不访问任何远端资源。

## 要求

1. `config.mjs`：按契约 §3.3 改 `sandboxSettings(vars)`。`TARSBOT_SANDBOX` 未设或为空 → `sprites`；`e2b` → E2B；其他值抛错（消息列出可选值）。删除"TARSBOT_SANDBOX is ignored"的注释。`config` 其余字段不变。Sprites 下所有现有值（`home`、`spaceCwd`、`spriteName`、env id `sprites:<name>`）必须与现在完全一致——线上数据依赖它。
2. `src/sandbox/index.mjs`：契约 §3.2。只允许 `SANDBOXES` 中的值（不要用未校验的字符串拼 import 路径）。模块懒加载并缓存。
3. `env.mjs`：`defaultBash` 改为经 `loadSandbox()` 调用当前沙箱的 `bash`；`defaultEnvId()` 返回 `${config.sandbox}:${config.sandboxName ?? "default"}`；`spaceEnv()`：Sprites 下仍要求 `TARSBOT_SPRITE_NAME`（报错文本不变），E2B 下 `sandboxName` 有默认值无需检查。更新文件头注释与 `WRITE_CHUNK_BYTES` 注释措辞（不要改数值）。`SandboxEnv` 行为不变。
4. `routes/space.mjs`：`GET /api/space` → `{ ...info(), cwd: config.spaceCwd }`，`info` 来自 `loadSandbox()`。
5. `preamble.mjs`：导出 `preambleFor(sandbox)`，`PREAMBLE = preambleFor(config.sandbox)`，`Preamble` 用它。
   - `sprites`：与现在的文本**逐字相同**。
   - `e2b`：第一行改为 E2B 沙箱（`an E2B sandbox: Linux, user "user", HOME /home/user`），工作目录 `~/workspace (/home/user/workspace)`；**去掉** uutils 那一行（E2B 是 GNU coreutils，由 E1 探测确认）；其余工作流、恢复检查、安全规则与 Sprites 版相同（抽成共享片段，不要复制粘贴两份）。
   - `createPreamble(text)` 测试钩子保持可用。
6. 前端：`SpaceInfo = { sandbox: "sprites" | "e2b"; name: string | null; cwd?: string }`。`EnvironmentPane` 显示 "Sprite" 或 "E2B" + name；工作目录用 `info.cwd`，缺失时回退 `/home/sprite/workspace`。保留 `data-testid="sprite-card"`（另加 `data-sandbox={info.sandbox}`）。
7. `test/vitest/env-conformance.test.mjs`：改为经 `loadSandbox()` 取 `bash`，套件名带上 `config.sandbox`；更新头注释说明 E2B 用法（`TARSBOT_SANDBOX=e2b`，需要 `E2B_API_KEY`，沙箱由 `scripts/e2b-setup.sh` 创建）。不要运行它（需要真实沙箱，由编排者跑）。
8. 测试：
   - `sandboxSettings`：默认、`sprites`、`e2b`（默认名与自定义 `TARSBOT_E2B_NAME`）、非法值抛错。替换掉现在 "TARSBOT_SANDBOX is ignored" 的测试。
   - `loadSandbox`：非法值拒绝；`sprites` 返回含 `bash`/`info` 的对象（不发网络请求）。
   - env id 与 `~` 解析在 e2b 下为 `e2b:pi-cloud-agents`、`/home/user`（参照 `test/env.test.mjs` 里 "`~` resolves to /home/sprite" 的子进程写法）。
   - `preambleFor("sprites") === 现在的 PREAMBLE 文本`（先把现文本存为期望值再改代码）；`preambleFor("e2b")` 含 `/home/user/workspace`、不含 `uutils`、含与 Sprites 相同的安全规则片段。
   - `/api/space` 在 sprites 下返回 `{ sandbox: "sprites", name, cwd: "/home/sprite/workspace" }`；在 e2b 下（子进程，`TARSBOT_SANDBOX=e2b`，无 `E2B_API_KEY`）返回 `{ sandbox: "e2b", name: "pi-cloud-agents", cwd: "/home/user/workspace" }`——这要求 `info()` 不发网络请求、不要求 key。若 E1 尚未写好 e2b.mjs 导致此测试失败，注明即可。

## 验收

- `TARSBOT_NO_DOTENV=1 npm test` 全绿（失败若来自 E1 的文件，注明后忽略）。
- `cd web && npm test && npm run typecheck && npm run build` 通过。
- `TARSBOT_NO_DOTENV=1 TARSBOT_SANDBOX=bogus node -e 'import("./src/config.mjs")'` 非零退出并给出清楚的错误。

最后输出：改动文件、测试命令与结果、未验证项、需要编排者集成的改动（例如 `scripts/pr-e2e.sh` 对 `sandbox:"sprites"` 的检查、文档更新点）。
