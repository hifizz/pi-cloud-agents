# Sprites / S3-approval：只拦截破坏已有 PR / 代码的 Git 操作

无依赖，可随时开始。

先读：`docs/SPRITES-PLAN.md` §4.4；`src/ext/approval.mjs`（`DEFAULT_BASH_RULES`，现有 `git push` 规则）；`test/approval.test.mjs`；`scripts/approval-test.sh`（是否用 `git push` 做演示）。

## 你只能创建/修改
- `src/ext/approval.mjs`（只改 `DEFAULT_BASH_RULES`）
- `test/approval.test.mjs`
- `scripts/approval-test.sh`（仅当它依赖"普通 git push 需审批"时，改用 `git push --force` 演示）
- 失败时 `docs/fail-S3-approval.md`

## 要求
策略：可以直接 push 自己的分支、直接开 PR；凡是会破坏已有 PR 或代码的操作需要审批。规则对 cua 模式同样生效，不按模式区分。

1. **删除**现有的"任意 `git push`"规则，替换为下列 `git push` 规则（每条单独 `reason`）：
   - 改写历史：`--force`、`-f`（包括 `-uf` 这类组合短参）、`--force-with-lease`、`--force-if-includes`、refspec 以 `+` 开头。
   - 删除远端引用：`--delete`、`-d`（包括组合短参）、`:<ref>` 形式的 refspec、`--mirror`、`--prune`。
   - 推送到基线分支：refspec 的目标是 `main`、`master` 或 `dev`（如 `git push origin main`、`git push origin HEAD:dev`、`git push origin tarsbot/x:main`）。
   - 规则需兼容 `git -C <dir> push`、`git -c k=v push` 这类前置参数（参考现有正则的写法）。
2. 新增 `gh` 规则：`gh pr merge`、`gh pr close`、`gh repo delete`、`gh repo edit`、`gh release delete`；`gh api` 写操作：`-X`/`--method` 为 POST/PUT/PATCH/DELETE，或带 `-f`/`-F`/`--field`/`--raw-field`/`--input`（`gh api` 带字段时默认发 POST）。
3. `gh pr create`、`gh pr edit`、`gh pr comment` **不需要**审批。
4. 已知局限写进 `approval.mjs` 注释：不带参数的 `git push` 无法判断上游分支；测试仓库未开启分支保护，这类推送没有服务端兜底，依赖 preamble 约束。

## 验收
- 需要命中（危险）：`git push --force origin b`、`git push -f`、`git push -uf origin b`、`git push --force-with-lease`、`git push origin +b`、`git push origin --delete b`、`git push -d origin b`、`git push origin :b`、`git push --mirror`、`git push origin main`、`git push origin HEAD:dev`、`git -C repo push origin tarsbot/x:master`、`gh pr merge 3 --squash`、`gh pr close 3`、`gh repo delete o/r --yes`、`gh api repos/o/r/pulls -f title=x`、`gh api -X DELETE repos/o/r`。
- 不得命中（安全）：`git push`、`git push -u origin tarsbot/fix-x`、`git -C repo push -u origin tarsbot/fix-x`、`git push origin HEAD`、`git push origin tarsbot/dev-docs`（分支名里包含 `dev` 但不是 `dev`）、`gh pr create --fill`、`gh pr create -t x -b y`、`gh pr view 3`、`gh pr list --head b`、`gh pr diff 3`、`gh api repos/o/r/pulls`、`git status`。
- 原有测试中断言"普通 `git push` 需要审批"的用例改为新语义，并在汇报中列出改动了哪些用例。
- `npm test` 全绿。

最后输出：改动文件、新规则列表、改动的旧用例、测试结果。
