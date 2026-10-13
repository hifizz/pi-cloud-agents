# Sprites / S3-preamble：sprites 模式的系统提示与 PR 工作流

依赖：S1-env（`config.sandbox`）。

先读：`docs/SPRITES-PLAN.md` §5；`src/ext/preamble.mjs`；`src/runtime.mjs`。

## 你只能创建/修改
- `src/ext/preamble.mjs`
- `test/preamble.test.mjs`（新增）
- 失败时 `docs/fail-S3-preamble.md`

## 要求
1. 现有 `PREAMBLE` 描述的是 XFCE 桌面容器。sprites 模式下改为：你有一台远端 Linux 机器（Sprite），只有 shell 和文件工具，没有桌面；工作目录 `~/workspace`。
2. sprites 模式追加 §5 工作流，并加入下列约束：
   - 开始前先 `git status`、`git log --oneline -5`、`git branch --show-current`，确认仓库当前状态（应对进程恢复后的重入）。
   - 已有同名分支或未推送的提交时，在其基础上继续，不新建重复分支。
   - 执行 `gh pr create` 前先 `gh pr list --head <branch> --state open`；已有 PR 则直接回复其链接。
   - PR 正文末尾加一行 `Opened by TARSBot`。
   - 不要 `echo`、`env`、`printenv` 或以其他方式输出 `GH_TOKEN`。
   - 只推送自己的 `tarsbot/*` 分支，不使用 `--force`，不直接推 `main` / `dev`。
   - 被审批拒绝时停止该操作并报告，不要换写法绕过。
3. 导出方式：保持 `export const Preamble`，内部按 `config.sandbox` 选文本；另导出 `PREAMBLE_CUA`、`PREAMBLE_SPRITES` 便于测试。cua 模式的文本保持不变。

## 验收
- `test/preamble.test.mjs`：两种模式各自返回对应文本；sprites 文本包含 `gh pr list --head`、`Opened by TARSBot`、`~/workspace`。
- `npm test` 全绿。

最后输出：改动文件、sprites 模式的完整 preamble 文本、测试结果。
