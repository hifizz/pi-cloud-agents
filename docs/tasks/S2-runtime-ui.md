# Sprites / S2-runtime-ui：sprites 模式下去掉桌面（L1）

依赖：S1-env。

先读：`docs/SPRITES-PLAN.md` §2、§6 L1；`src/runtime.mjs`；`src/routes/space.mjs`；`src/server.mjs`；`web/src/App.tsx`、`web/src/components/DesktopPane.tsx`、`web/src/types.ts`、`web/src/lib/api.ts`。
先执行 `grep -rn "space.mjs\|@trycua/cua\|viewer-proxy" src` 列出所有会碰到 Cua 的入口。

## 你只能创建/修改
- `src/runtime.mjs`、`src/routes/space.mjs`
- 上面 grep 出的其他 `src/` 文件中，**仅限**加 sprites 模式分支、避免加载 Cua 的改动（汇报中逐个列出）
- `web/src/App.tsx`、`web/src/components/DesktopPane.tsx`、`web/src/types.ts`
- `test/api.test.mjs`（补 `/api/space` 用例）
- 失败时 `docs/fail-S2-runtime-ui.md`

## 要求
1. `runtime.mjs`：`productionExtensions()` 在 `config.sandbox === "sprites"` 时不包含 `Desktop`；`Desktop` 改为按需动态 import，sprites 模式下不加载 `@trycua/cua`。
2. `routes/space.mjs`：sprites 模式下 `GET /api/space` 返回 `getSpriteInfo()`，即 `{ sandbox: "sprites", name }`，不调用 `getSpace()`、不启动 viewer proxy。cua 模式返回值加上 `sandbox: "cua"`，其余不变。
3. 前端：`sandbox === "sprites"` 时右栏显示一个简单信息卡（"执行环境：Sprite `<name>`"），不渲染 iframe。cua 模式不变。
4. sprites 模式下 `npm start` 不需要 docker / OrbStack 也能启动。

## 验收（L1）
- `npm test` 全绿，含新增 `/api/space` 两种模式的用例。
- `cd web && npm run build` 成功。
- 手工：`TARSBOT_SANDBOX=sprites npm start` → UI 中新建 Bot，让它创建 `~/workspace/hello.txt`，内容任意 → 用 SDK 或 `sprite` CLI 执行 `cat /home/sprite/workspace/hello.txt` 能看到内容。把命令和输出贴到汇报里。

最后输出：改动文件、测试结果、L1 手工验证记录、未验证项。
