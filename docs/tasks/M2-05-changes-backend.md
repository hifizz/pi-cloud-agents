# M2-05：Git 改动后端（真实的工作区改动）

依赖：无（只需要一个 `bash` 原语，本机临时 git 仓库就能测）。

先读：`docs/M2-PLAN.md` §3.2；`src/checkpoint.mjs`（临时索引 `GIT_INDEX_FILE` + `write-tree` 的写法、`parseKv`、`CHUNK_BYTES`、命令里的路径引用方式）；`src/routes/checkpoints.mjs`（路由如何取 `app.ctx.runtimeBash`、状态码）；`src/env.mjs`（`shellQuote`）；`src/sandbox/sprites.mjs` 头部（argv 的 URL 上限、大输出在平台上曾丢失，所以输出要小、要分块）。

## 你只能创建/修改
- `src/routes/changes.mjs`
- `test/changes.test.mjs`

## 路由（`register(app)`，依赖 `app.ctx.control`、`app.ctx.runtimeBash`，缺少则不注册并 `console.warn` 一次）
1. `GET /api/workspaces/:id/changes` → `{ baseCommit, head, branch, truncated, totals: { files, add, del }, files: [{ path, oldPath?, status: "M"|"A"|"D"|"R", binary, add, del }] }`。
2. `GET /api/workspaces/:id/changes/patch?path=<相对路径>` → `{ path, patch, truncated, binary }`；`patch` 是该文件相对 `baseCommit` 的 unified diff。
3. 错误：工作区不存在 404；不是 `ready` 或没有 active 绑定或 `runtimeBash` 抛错 409；git 命令超时（30 秒）504；Sprite 连接失败 503；其余 500。消息里**不含服务器绝对路径与令牌**。

## 取改动的方法（在 `runtimeBash(workspaceId)` 返回的原语里执行，cwd 为工作区 `cwd`）
- **复制真实索引**到临时位置（`$GIT/pca-chg-<随机>/index`，用 `git rev-parse --absolute-git-dir`），再 `GIT_INDEX_FILE=<tmp> git add -A`、`git write-tree`，得到包含未跟踪（非忽略）文件的树；不触碰真实索引，用完 `rm -rf` 临时目录（`finally` 里也要删）。
- 统计：`git -c core.quotepath=off diff -M --numstat -z <baseCommit> <tree>`；二进制在 numstat 里是 `-\t-`；重命名在 `-z` 下是 `\0旧\0新\0`，要正确解析。`baseCommit` 与 `cwd` 来自 `control.workspaces.get`，用前校验形状（`/^[0-9a-f]{40}$/`、绝对路径），所有进入命令的值一律 `shellQuote`。
- 补丁：`git diff -M --no-color --no-ext-diff --no-textconv -U3 <baseCommit> <tree> -- <path>`，路径同样 `shellQuote`；输出限制 40 KB（`| head -c 40000`），超出标 `truncated`。`path` 必须是仓库内的相对路径，拒绝 `..`、绝对路径、换行、以 `-` 开头。
- 上限：最多 200 个文件（超出标 `truncated: true` 并只返回前 200 个）；单次 exec 的 argv 不能超过 Sprites 的 URL 限制；stdout 小，超过 12 KiB 的输出分块读取（沿用检查点的做法）。
- 同一工作区的并发请求做 **singleflight**，结果缓存 2~3 秒（每次 exec 约 1 秒且会唤醒休眠的 Sprite）；缓存按工作区隔离，工作区被重建（绑定版本变化）时失效。
- `head`、`branch` 用 `git rev-parse HEAD` 与 `git rev-parse --abbrev-ref HEAD`。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。测试用**本机临时 git 仓库** + 把命令交给本机 `sh` 的 `bash` 原语（参考 `test/checkpoint.test.mjs`）。
- 必测：修改已跟踪文件、新增未跟踪文本、新增二进制（含 `\0`）、删除、重命名（含空格与中文路径）、改可执行位、仓库里有未推送的本地提交（相对 `baseCommit` 仍显示）；`.gitignore` 的文件不出现；**临时目录与临时索引在成功与失败时都被清掉**；真实索引在调用前后字节不变（`git status` 的暂存区状态不变）；超过 200 个文件与超大补丁的截断；`path` 的各种恶意输入（`..`、`;rm -rf`、`$(...)`、换行、`-` 开头）被拒绝且没有命令被执行；缓存命中不再调用 `bash`、绑定版本变化后失效、并发请求只执行一次；响应里搜不到测试用的假令牌与临时目录路径；各错误码。
- 不连网、不用真实 Sprite、不调用模型。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项（尤其：未在真实 Sprite 上跑）。
