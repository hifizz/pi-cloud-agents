# M1 验收报告

- 日期：2026-10-25（本机 macOS，真实 Fly Sprites，真实 GitHub 测试仓库）
- 版本：分支 `feat/m1-workspaces`（提交 94fd950 之后含本次验收中发现并修复的三处改动，见「发现的问题」）
- 环境：Node 24、`@earendil-works/pi-durable` 1.4.0；服务用**全新临时 `TARSBOT_DATA_DIR`**（空目录）、`TARSBOT_AUTH_DISABLED=1`、仅监听 127.0.0.1；真实 `data/` 未使用、未修改
- 模型：全部场景用 **SWE-2**（`swe-2`）。未使用其他模型。
- 仓库：只用 `hifizz/tars-sandbox-playground`
- Sprite：只创建 `pca-*` 且带标签 `app:pi-cloud-agents`；同时存在最多 3 台；结束时逐个核对名字、前缀与标签后经 `provider.release` 释放，`pi-cloud-agents` 与 org 内其他 Sprite 未动
- 自动化：后端 `TARSBOT_NO_DOTENV=1 npm test`、前端 `npm test`、`typecheck`、`build` 全部通过（数字见文末）
- 浏览器：EGO 浏览器，截图在 `docs/acceptance/M1/*.png`；脚本输出在 `docs/acceptance/M1/logs/`
- 取证脚本：`scratch/m1-accept*.mjs`（只在本机跑，不含任何密钥值）

## 结果总览

| # | 场景 | 结果 |
|---|---|---|
| 1 | 新建工作区 | PASS |
| 2 | 重复提交 | PASS |
| 3 | 并行隔离 | PASS |
| 4 | 初始化中重启 | PASS |
| 5 | 长命令 + kill -9（3 次） | PASS（3/3）；「命令跑完后再杀」这一变体**未单独跑**，见下 |
| 5b | callId 重复 | PASS |
| 5c | prepare 与 start 之间 | PASS（真实 Sprite 上直接构造） |
| 6 | 取消 | PASS，带一处偏差（取消结果的文字） |
| 7 | PR | PASS |
| 8 | 检查点与重建（含 8b） | PASS |
| 9 | 全新启动 | PASS |
| 10 | 密钥泄漏检查 | PASS |

## 各场景

**1 新建工作区。** 操作：`POST /api/workspaces`（选测试仓库、`main`、需求）。观察：步骤 `runtime → init → code → deps → agent` 依次走完，状态 `ready`；Sprite `pca-61c97ff5c0`，标签 `app:pi-cloud-agents`、`ws:<工作区 id>`；Bot 在 `/home/sprite/workspace/tars-sandbox-playground`，分支 `tarsbot/in-the-repo-create-a-file-hello-61c97f`，创建了 `hello.txt` 并报告 `git status`。截图：`01-workbench-overview.png`、`02-environment-panel.png`、`04-new-workspace-dialog.png`、`05-dialog-filled.png`、`07-new-workspace-ready.png`。

**2 重复提交。** 两个并发请求用同一个 `requestId` 创建：只有 1 个工作区、1 台 Sprite（`listSprites` 只有 1 台）。浏览器对话框里再提交一次（`06-after-submit-preparing.png`）：同样只多出 1 个工作区、1 台 Sprite。注：对话框第一次点击就会关闭，所以「连点两次」在界面上只能点到一次；同编号并发由 API 层验证。

**3 并行隔离。** 工作区 B 同样要求写 `hello.txt`：A 的内容是 `hello from workspace A`，B 的是 `hello from workspace B`，分支各自不同，互不影响。

**4 初始化中重启。** 工作区 C 的 `code` 步骤运行中 `kill -9` 服务并重启：步骤接续并走完，Sprite 上 `~/workspace/` 下只有 1 个仓库目录，意图日志里 `workspace.code` 只有一条 `confirmed`；没有重复 clone，也没有新建第二台 Sprite。

**5 长命令 + 强杀（3 次）。** 每轮让 Bot 执行「每 5 秒写一行日志并向计数文件追加一行，共 18 次（约 90 秒）」，第 4～5 个 tick 时 `kill -9` 服务，3 秒后重启。结果：

| 轮次 | 杀服务时计数 | 结束时计数 | 结果中是否含 `tick-N-1 … tick-N-18` 与 `finished-N` |
|---|---|---|---|
| 1 | 约 5 | 18 | 是 |
| 2 | 4 | 18 | 是 |
| 3 | 5 | 18 | 是 |

计数文件恰好 18 行（命令只执行一次），最终结果包含崩溃前已输出的部分（重放从偏移 0 重新给）。输出：`logs/s5-round2.txt`、`logs/s5-round3.txt`、`logs/s5-round1-transcript-excerpt.txt`。
**未做：**「命令跑完（有 `exit` 文件）后再 `kill -9`，重启后结果被找回、不重跑」这一变体没有在真实 Sprite 上单独跑；`test/exec.test.mjs` 里有对应的自动化用例（重放时 runner 状态为 `exited`），但不是本次实机证据。

**5b callId 重复。** Bot 依次执行两条不同命令：两条各自执行一次，输出分别为 `FIRST-OUT`、`SECOND-OUT`，文件里各一行，没有串日志。说明：本次模型没有真的复用 `callId`，所以实机上只验证了「两条不同命令互不串」；`callId` 复用本身由 `test/exec.test.mjs` 的自动化用例覆盖（两个不同 `runId`，各执行一次）。

**5c prepare 与 start 之间的窗口。** 在真实 Sprite 上用真实 runner 客户端：`prepare` → 不调用 `start` → 用新的客户端实例（模拟重启）查询。结果：`status`/`wait` 都是 `claimed`，同编号再次 `prepare` 返回 `existing`（不是 `new`），命令从未运行（标记文件不存在）。输出：`logs/s5c.txt`。注意这验证的是 runner 的状态与客户端行为，不是「Exec 工具在这个窗口里被打断」的完整路径（后者由自动化用例覆盖：`claimed` → 结果待确认、不启动）。

**6 取消。** 工作区 A 运行 40 次 tick 的命令，约 30 秒后 `POST /api/bots/:id/abort`；同时工作区 B 在另一台 Sprite 上跑 10 次 tick 的命令。结果：A 的计数停在 5 且之后不再增长，进程已不存在；B 正常跑完（计数 10，输出 `B-FINISHED`），不受影响。
**偏差：**取消后工具结果在界面/记录里显示的是 Harness 的通用文字 `Tool bash was aborted`，**没有出现**「已停止」或「停止待确认」。原因：被中止的工具抛出的错误会被 Harness 替换成通用文本，扩展里记录的 `stopped` / `stop_unconfirmed` 诊断没有进入模型可见的结果。我试过两种补法（先 `api.output` 再抛出，以及强制提交 details），都没有改变结果，已回退，没有留下半成品。进程确实被杀死这一点有实机证据，只是用户可见的状态文字没有达到验收标准的字面要求。→ 记入 M2。

**7 PR。** 让 Bot 提交并推送分支 → 点「创建 PR」得到 `hifizz/tars-sandbox-playground#11`（`created: true`）；让 Bot 再提交一次并推送 → 再点「创建 PR」仍是 `#11`（`created: false`）；用旧的 `requestId` 重复调用也是 `#11`；GitHub 上该分支只有 1 个 PR（`#11`，open）。浏览器：`03-pr-created-again-same-number.png`、`09-workspace-A-pr-11.png`。**测试仓库里留下了 PR #11（open）和 3 个 `tarsbot/*` 分支，未清理。**

**8 检查点与重建。** 在工作区 B 制造：修改 `README.md`、新增文本 `new-note.txt`、新增二进制 `blob.bin`（4096 随机字节）、新增可执行 `run.sh`（755）、删除 `docs/PLAN.md` → 保存检查点 `cp_1bffad9900e7526d` → 记录每个文件 sha256 与权限 → `provider.release` 释放旧 Sprite → `POST /api/workspaces/:id/rebuild` → 新 Sprite `pca-ef44d3f2b3`，绑定版本 v2。逐文件 sha256 与可执行位完全一致，被删文件仍不存在，HEAD 相同；Bot 在新环境里继续工作并正确读出文件。截图：`10-workspace-B-rebuilt-v3-checkpoint.png`。
**8b 重建后不重放旧命令：**在 v2 上让 Bot 开始一条 30 次 tick 的命令，`kill -9` 服务；用 `scratch/m1-accept-rebuild-before-resume.mjs` 在「工作区服务恢复之后、Harness 恢复之前」重建到 v3（新 Sprite `pca-029b420683`）；重启后该旧调用的结果是「结果待确认：工作区运行环境已变更（命令发出时为绑定 v2，现为 v3）」，**新 Sprite 的 `~/.pca/runs/` 下没有旧命令的目录**（只有 Bot 之后自己发的新命令），Bot 随后自行检查并重新发起了命令。

**9 全新启动。** 空数据目录启动：`/api/workspaces` 与 `/api/bots` 均为 `[]`，自动创建 `control.sqlite`；不再自动创建默认 Bot。缺少 `SPRITES_TOKEN`（`TARSBOT_NO_DOTENV=1`，临时空目录）：启动即报 `SPRITES_TOKEN is not set: workspaces need Sprites …`，不含任何值。多次 `kill -9`/重启之后，工作区、步骤、会话关联、检查点列表都还在。

**10 密钥泄漏检查。** 在验收数据目录（含 sqlite、WAL、检查点目录）、`logs/`、`docs/acceptance/M1/` 共 29 个文件里搜 `GITHUB_TOKEN`、`SPRITES_TOKEN`、`TOKEN_ROUTER_API_KEY` 的值：0 命中；正向对照（植入假密钥）能被找到。另查一台 Sprite 磁盘（`~/.pca`、`~/.gitconfig`、`~/.config`）：没有令牌样式的内容；git 凭据助手只引用 `$GH_TOKEN` 环境变量。

## 发现的问题（均已修复并加了回归测试）

1. **重建路由没有注册。** `POST /api/workspaces/:id/rebuild` 写在 `src/workspace-rebuild.mjs` 里，而 `loadRoutes()` 只扫描 `src/routes/`，所以线上 404；单元测试都通过，只有实机才暴露。修复：`loadRoutes` 注册该路由；新增 `test/integration-startup.test.mjs` 的路由用例。
2. **界面上的 PR 结果串到别的工作区。** 切换工作区后，新工作区显示了上一个工作区的「PR 已存在：#11」。原因：`WorkspaceActions` 的局部状态没有按工作区重置。修复：按 `workspace.id` 加 `key`；新增 `web/test/workspaces.test.tsx` 回归用例（已验证没有修复时该用例失败）。
3. **（顺手修）** `SandboxEnv` 工厂对数字会话 id 调 `String()`，与控制库键一致。

## 未解决 / 留给 M2 的观察

- **取消结果的文字**（场景 6 偏差）。
- **新建 Sprite 后的瞬时「结果待确认」。** 重建出的 `pca-ef44d3f2b3` 上，Bot 的前两次 `bash` 调用先后得到「结果待确认」（一次是 `prepare` 时 WebSocket 连接失败，一次是 `wait` 读到 runner 状态 `missing`）。系统按设计处理：没有重复执行，Bot 自己检查后重新发起，最终完成。**根因没有查清**（疑似新 Sprite 冷启动期间 exec 连接不稳，但没有证据）。
- 「命令跑完后再强杀」的实机变体（见场景 5）。
- 其余已知项目见 `docs/M1-PLAN.md` §8；M2 候选：写锁与人工接管、git 改动面板、审批绑定运行版本、「先出方案」、聊天输入的请求内容冲突检查。

## 自动化结果

- 后端 `TARSBOT_NO_DOTENV=1 npm test`：见提交说明（最后一次：324 项，323 通过，0 失败，1 跳过）
- 前端 `npm test`：9 个文件，128 项通过；`npm run typecheck` 通过；`npm run build` 通过
