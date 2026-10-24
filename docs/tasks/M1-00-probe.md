# M1-00：探针（pi-durable 行为 + Sprites 行为）

依赖：无。结论决定 M1-04、M1-05、M1-06 的做法，**请最先完成，并在汇报里单独列出每项结论**。

先读：`docs/M1-PLAN.md` §3、§8；`docs/sprites-probe.md`；`scratch/sprite-probe.mjs`；`node_modules/@earendil-works/pi-durable/dist/harness/{tool,types}.d.ts`、`dist/tools/index.d.ts`；`test/harness.test.mjs`（离线模板）。

## 你只能创建/修改
- `scratch/m1-probe-a.mjs`、`scratch/m1-probe-b.mjs`（可再加 `scratch/m1-probe-*.mjs`）
- `docs/m1-probe.md`
- 失败时 `docs/fail-M1-00.md`

## 要求

### A 部分：离线（不需要 Sprite，用 `fauxProvider` + 临时 sqlite 文件；要杀进程的用子进程 `kill -9`）

- A1：在 `CodingTools` 之后安装的扩展里注册同名 `bash` 工具（`defineTool`，`replay: "safe"`），模型看到的是哪一个？若不能覆盖，给出不改 pi-durable 的可行做法（例如 agent 的 `tools` 过滤，或用 `createReadTool` / `createWriteTool` / `createEditTool` 自行组合并只装自己的 bash）。
- A2：`replay: "safe"` 的工具执行到一半时 `kill -9`，重启 harness 后 `execute` 是否再次被调用？`api.callId`、`api.taskId` 重启前后是否相同？`api.output()` 在重放后如何表现？对照 `replay: "unsafe"`（默认）的结果。
- A3：`conv.submit({type:"input", content, requestId})` 用同一 `requestId` 提交两次（含「中间重启一次」），是否只产生一条用户消息、一次 run？
- A4：env 工厂分别「直接抛错」与「返回一个 `exec` 始终报错的 env」时，harness 与内置工具各是什么表现？推荐哪一种。
- A5：`node:sqlite` 是否提供 `backup()`；当另一个 `DatabaseSync` 正在写同一个库（WAL）时，备份能否得到一致副本。
- A6：`createBot({cwd})` 指向一个 env 里不存在的目录时，`EnvTarget.cwd` 是什么，工具报什么错。

### B 部分：Sprites（读 `.env` 里的 `SPRITES_TOKEN`；**只创建和删除名为 `pca-probe-<时间戳>`、标签含 `app:pi-cloud-agents` 的 Sprite，同时存在不超过 3 个，结束必须全部删除**；绝不碰其他 Sprite）

- B1：`createSprite` 耗时、`waitForCapacity` 行为；`labels` 能否在 `getSprite` / `listSprites({prefix})` 读回；对同名再 `createSprite` 的错误形态（`status` / `code` / 消息）；`getSprite` 不存在的错误形态；`deleteSprite` 对不存在的 Sprite 是否幂等。
- B2：新 Sprite 里有无 `setsid`、`flock`、`/proc/<pid>/stat`、`git`、`gh`、`node`、`base64`、`sha256sum`、`tar`、`perl`；`id`、`$HOME`。
- B3：`setsid sh -c 'sleep 60; echo done >f' &` 之后 exec 连接关闭，进程是否仍存活；用 `/proc/<pid>/stat` 起始时间 + `/proc/sys/kernel/random/boot_id` 做身份是否稳定；`kill -TERM -<pgid>` 能否杀掉整个进程组。
- B4：单次 exec 传 20 KB、40 KB base64 参数各自的结果（`MAX_EXEC_QUERY_CHARS` 边界）；stdout 回读 48 KB 与 200 KB 是否完整（给出可靠的分块大小）。
- B5：连续创建 3 个后行为是否异常（不要超过 3 个）。
- B6：新 Sprite 默认能否访问 `github.com`；`scratch/sprite-setup.mjs` 里网络策略相关调用对新 Sprite 是否同样有效。

## 验收
- A1~A6、B1~B6 每项都有结论：观察到的事实（命令与输出摘要，**不含任何 token**）、对 M1 哪个任务有什么影响。
- 没法验证的项写明原因，不要猜。
- 结束时用 `listSprites({prefix: "pca-probe-"})` 确认无残留，并把结果写进报告。

最后输出：`docs/m1-probe.md` 路径、每项一句话结论、会改变 `docs/M1-PLAN.md` 的地方（逐条列出，不要自行改 PLAN）。
