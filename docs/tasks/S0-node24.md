# Sprites / S0-node24：切换 Node 24 并安装 `@fly/sprites`

先读：`docs/SPRITES-PLAN.md` §2（依赖）、§8（Node 24 兼容风险）、`package.json`、`README.md`。

## 你只能创建/修改
- `package.json`、`package-lock.json`
- `.nvmrc`（新增）
- `README.md`（只改 Node 版本与安装说明）
- 失败时 `docs/fail-S0-node24.md`

## 要求
1. 本机安装 Node 24（`fnm install 24` 或 `nvm install 24`），**只在本 worktree 使用**，不改全局默认版本。
2. 新增 `.nvmrc`，内容为 `24`。
3. `package.json` 的 `engines.node` 改为 `>=24`。
4. `npm install @fly/sprites@0.2.3 --save-exact`。安装后检查 `package.json` 中版本号没有 `^` 或 `~`。
5. README 写明：本分支需要 Node 24，并给出切换命令。

## 验收
- `node -v` 输出 `v24.x`。
- `npm test`（离线）全绿。若有失败，逐个判断是 Node 24 导致的还是原本就失败（切回 Node 22 跑同一个测试做对比），把结论写进汇报。
- `node -e "import('@fly/sprites').then(m => console.log(Object.keys(m)))"` 能列出导出项。

最后输出：改动文件、Node 版本、`npm test` 结果、`@fly/sprites` 的导出项列表、Node 24 下的兼容问题（如有）。
