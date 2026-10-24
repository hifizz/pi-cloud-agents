# M1-09：检查点（保存和恢复未提交代码）

依赖：M1-01（`store.checkpoints`）。只需要一个 `bash` 原语，**本机临时 git 仓库就能测**，所以不必等 Sprite 相关任务。M1-00 B4 已完成：**单次 exec 的 argv 在 URL 里，12 KiB 原始数据是已验证的安全分块；20 KiB 起最坏数据编码后超过 64,000 的上限**（见 `docs/m1-probe.md` B4）。回读 200 KiB 本轮完整，但历史上有大输出丢失记录，所以回读也分块、逐块校验长度。

先读：`docs/M1-PLAN.md` §3.5、§4.7；`src/env.mjs`（`WRITE_CHUNK_BYTES`、`shellQuote`、base64 传输写法）；`src/sandbox/sprites.mjs` 头部（exec 的 URL 与输出限制）；`docs/m1-probe.md`（B4）。

## 你只能创建/修改
- `src/checkpoint.mjs`
- `src/routes/checkpoints.mjs`
- `test/checkpoint.test.mjs`

## 要求
1. `createCheckpointService({ store, dir, now })`；`dir` 是检查点根目录（线上在 Fly 卷下），由调用方传入，本任务不读环境变量、不改 `config.mjs`。
2. `save({ workspace, bash })`（`bash` 在工作区目录里执行）：
   1. 用临时索引取得整个工作区的树：`GIT_INDEX_FILE=<tmp> git add -A`（尊重 `.gitignore`，不碰真实索引与工作区）→ `git write-tree` → `git commit-tree <tree> -p HEAD`，把提交写到 `refs/pca/ckpt/<id>`。工作区 HEAD 上有尚未推送的提交时它们也在链里。
   2. `git bundle create <file> refs/pca/ckpt/<id> ^origin/<baseBranch>`（前置为基准分支；若 `origin/<baseBranch>` 不存在，退回用 `baseCommit`）。
   3. 把 bundle 经分块 base64 取回服务端（单次回读不超过 B4 的上限；每块校验长度），写入 `<dir>/<workspaceId>/<ts>-<tree前8位>.bundle` 和同名 `.json` manifest，计算 sha256 与大小，`store.checkpoints.add`。manifest 记录：`baseCommit`、`headCommit`、`treeHash`、`branch`、`createdAt`、`bindingVersion`、文件数、未纳入范围的说明（被 `.gitignore` 忽略的文件不保存）。
   4. 清理远端的临时文件；**保存失败时不更新「最近检查点」**，抛带原因的错误，不留下半个 bundle。
   5. 大小上限默认 20 MiB，超过则失败并说明原因；同一 `treeHash` 与上一个检查点相同时复用（不新建，返回 `unchanged: true`）。
   6. 每个工作区默认保留最近 5 个，pinned 的不删；写入新检查点后再清理旧的（先建后删）。
3. `apply({ checkpoint, bash, cwd })`：目标目录已是 clone 好并停在基准提交的仓库。校验 sha256 → 分块写入目标机 → `git fetch <bundle> refs/pca/ckpt/<id>` → 让 HEAD 回到检查点记录的 `headCommit`（它在 bundle 链里）→ 工作区与索引还原为检查点的树（含删除、新增文本和二进制、可执行位）。**目标目录有未提交内容时拒绝执行**，不覆盖。已知：暂存区与工作区的划分不保留，统一还原成未暂存；写进文件头注释。
4. `list(workspaceId)`、`verify(checkpoint)`（重新算本地 bundle 的 sha256）。
5. 路由（`register(app)`，依赖 `app.ctx.checkpoints`、`app.ctx.control`，没有注入则不注册）：`POST /api/workspaces/:id/checkpoint`（工作区 `ready` 且有 active 绑定；经 `app.ctx.runtimeBash(workspaceId)` 取 `bash`——这个函数由 M1-13 注入）、`GET /api/workspaces/:id/checkpoints`。返回 manifest，不含 bundle 内容与服务器绝对路径。
6. 检查点里不含密钥：不会读取 `.env` 之类（被忽略即不保存）；另外在保存前对树里的文件名做一次提示性扫描，命中 `.env*`、`*.pem`、`id_rsa*` 等且**未被忽略**时，在 manifest 里加 `warnings`（不阻止保存）。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿。测试用本机临时 git 仓库 + 一个把命令交给本机 `sh` 的 `bash` 原语：
  - 修改已跟踪文件、新增未跟踪文本、新增二进制（含 `\0` 字节）、删除文件、改可执行位、仓库里有一个未推送的本地提交 → `save` → 在另一个全新 clone 上 `apply` → 目录树校验值（逐文件 sha256 与可执行位）与原目录一致；
  - 同一状态再次 `save` 返回 `unchanged`；
  - 超大文件触发上限且不留下残片；
  - 目标目录有未提交内容时 `apply` 拒绝；
  - bundle 被篡改 `verify` 失败、`apply` 拒绝；
  - 保留策略：第 6 个保存后只剩 5 个，pinned 保留；
  - `.gitignore` 的文件不在检查点里；
  - 响应与 manifest 中不含服务器绝对路径。
- 真实 Sprite 上的存档与重建在 M1-10、M1-14 验。

最后输出：改动文件、测试结果、与 M1-00 B4 的对应、未验证项。
