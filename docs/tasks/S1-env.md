# Sprites / S1-env：执行环境开关（L0）

依赖：S1-bash 的接口（见 `docs/tasks/S1-bash.md`）。可与 S1-bash 并行开发，先用接口桩；联调必须在 S1-bash 完成后。

先读：`docs/SPRITES-PLAN.md` §2、§3、§6 L0；`src/config.mjs`；`src/env.mjs`（`DEFAULT_HOME`、`defaultBash`、`CuaEnv.id`、`spaceEnv`）；`test/env.test.mjs`；`test/vitest/env-conformance.test.mjs`。

## 你只能创建/修改
- `src/config.mjs`、`src/env.mjs`
- `test/env.test.mjs`、`test/vitest/env-conformance.test.mjs`
- 失败时 `docs/fail-S1-env.md`

## 要求
1. `config.mjs` 新增：
   - `sandbox`：`process.env.TARSBOT_SANDBOX ?? "cua"`，只接受 `cua` / `sprites`，其他值启动时报错。
   - `spriteName`：`process.env.TARSBOT_SPRITE_NAME`。
   - `home`：cua 为 `/home/cua`，sprites 为 `/home/sprite`。
   - `spaceCwd`：cua 为 `/home/cua/work`（不变），sprites 为 `/home/sprite/workspace`。
2. `env.mjs`：
   - `DEFAULT_HOME` 改为读取 `config.home`；`resolvePath` 默认参数随之变化。
   - `defaultBash` 按 `config.sandbox` 动态 import `./space.mjs` 或 `./sandbox/sprites.mjs`。sprites 模式下**不得 import** `space.mjs` / `@trycua/cua`。
   - `CuaEnv` 的 `id`：sprites 模式为 `sprites:<spriteName>`，cua 模式保持 `cua:main`。建议通过构造参数 `id` 传入，`spaceEnv()` 负责填写。
   - 不改类名 `CuaEnv`（避免牵连其他文件），在注释中说明它也用于 Sprites。
3. `env-conformance.test.mjs`：`TARSBOT_SANDBOX=sprites` 时用 `spritesBash` 与 `/home/sprite` 跑同一套 conformance；默认仍跑 Cua。注意该文件设置了 `TARSBOT_NO_DOTENV`，运行方式需在文件头注释写清（如 `set -a; . ./.env; set +a; TARSBOT_SANDBOX=sprites npm run test:env`）。
4. `test/env.test.mjs` 补充离线用例：sprites 模式下 `~` 解析到 `/home/sprite`；`id` 正确。

## 验收（L0）
- `npm test`（离线）全绿，默认 cua 模式行为不变。
- `TARSBOT_SANDBOX=sprites npm run test:env` 对真实 Sprite 全绿。若个别 conformance 用例因平台差异失败，写清用例名、原因和建议，不要跳过。

最后输出：改动文件、两种模式的测试结果、未验证项。
