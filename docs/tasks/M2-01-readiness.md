# M2-01：新 Sprite 的就绪探测与「瞬时结果待确认」的取证

依赖：无。可与波 A 其他任务并行。

先读：`docs/M2-PLAN.md` §3.7；`docs/acceptance/M1/README.md`「未解决 / 留给 M2 的观察」；`src/sandbox/sprites.mjs`（预开重试、`DRAIN_GRACE_MS`、`MAX_EXEC_QUERY_CHARS`）；`src/providers/sprites.mjs`（`ensure` 只保证对象存在，不保证 exec 就绪）、`src/providers/sprites-init.mjs`；`src/runner/client.mjs`（`prepare`/`start` 不重试，`wait`/`status` 重试）；`src/runner/runner.sh`（`wait` 对不存在的 run 目录返回 `missing`）；`src/ext/exec.mjs`（`isDefiniteFailure`、何时返回「结果待确认」）。

## 背景（M1 验收里的现象）
重建出的新 Sprite 上，Bot 的前两次 `bash` 调用先后得到「结果待确认」：一次是 `prepare` 时 `Sprite exec could not connect after 1 retry: WebSocket error`，一次是 `wait` 读到 runner 状态 `missing`。命令没有重复执行（设计正确），但体验很差，**根因没有证据**。

## 你只能创建/修改
- `src/providers/sprites.mjs`、`src/providers/sprites-init.mjs`
- `src/sandbox/sprites.mjs`（**只改预开连接失败的重试次数与退避**，不动其他行为）
- `scratch/m2-readiness-*.mjs`、`docs/m2-readiness.md`
- `test/providers-sprites.test.mjs`、`test/sprites.test.mjs`

**不要改** `src/runner/*`、`src/ext/exec.mjs`（它们的相关改动写进汇报，由 M2-03 / 编排者在 M2-11 合并）。

## 要求
### 第一步：取证（先不改行为，写进 `docs/m2-readiness.md`）
1. 写一个只在本机手动运行的探针 `scratch/m2-readiness-probe.mjs`：用 `createSpritesProvider` 新建 **1 台**临时 `pca-*` Sprite（确定性名字、带标签），`ensure` 返回后立刻循环 `provider.bash(runtimeId)('true')`，间隔 0.5 秒，记录：首次成功的耗时、之前失败的次数与错误类型（连接失败 / 超时 / 其他）。结束后用 `provider.release` 释放，只释放自己创建的。再重复 2 次（**同时存在的 `pca-*` 不超过 3 台**，建议顺序做，每次释放后再建）。
2. 打开 `TARSBOT_SPRITES_LOG`（`createSpritesProvider` 的 `log` 选项）记录 `ms / retries / outcome`，不记录命令与令牌。
3. 在同一台新 Sprite 上，用真实 `createRunnerClient` 执行 `install` → `prepare` → 立刻 `status` → `start`，记录 `prepare` 返回的 `prepared`、`status` 的状态、`start` 返回的 `started` 与 `reason`（`exec.mjs` 目前忽略 `start` 的返回值）。
4. 结论写进 `docs/m2-readiness.md`：数据表、你的判断（连接窗口多长；`missing` 是不是 `prepare` 实际成功但客户端已放弃后的竞态）、以及哪些是**证据**哪些是**猜测**。

### 第二步：加固（依据取证结果，至少做下面三项，数值以实测为准）
1. `provider.ensure` 在**新建**（`created: true`）时返回前，等到 `exec true` 成功（退避，总上限约 30 秒，超时返回带原因的错误，不要无限等）。已存在的 Sprite 不探测（避免每次都 +1 秒）。提供 `provider.waitReady(runtimeId, {timeoutMs})` 供重建流程复用；是否在重建里调用由编排者在 M2-11 接线，你只负责实现和测试。
2. `src/sandbox/sprites.mjs`：预开连接失败的重试从 1 次改为 3 次（退避 1.5 秒起，倍增），**只针对预开失败**（命令确定没有开始），已开始后的错误行为不变。
3. 在汇报里列出对 `src/runner/client.mjs` 与 `src/ext/exec.mjs` 的建议改动（不要自己改）：检查 `start` 的返回值（`started=no reason=missing`）；把「连接建立前失败、命令必然未执行」的错误（`SPRITES_CONNECT_FAILED`）当作确定性失败而不是「结果待确认」。
4. 如果取证显示这些改动**不能**解释现象，如实写进汇报，不要硬凑；把现象和下一步探针写进 `docs/m2-readiness.md`。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。离线测试（假客户端）：`waitReady` 前几次失败后成功、超时返回带原因的错误且不留后台定时器；新建时 `ensure` 会探测、已存在时不探测；预开失败重试 3 次后放弃，已开始的错误不重试；日志与错误里没有令牌。
- 真实 Sprite 取证只在 `scratch/` 里手动跑，**不进 `npm test`**；用完的 Sprite 全部释放，汇报里写出释放核对结果（名字、前缀、标签）。
- 真实调用只用 `provider.bash`，不调用任何模型。

最后输出：改动文件、取证数据摘要、测试结果、对 runner / exec 的建议改动、未验证项。
