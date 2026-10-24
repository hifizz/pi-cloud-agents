# M1-04：runner（运行端脚本 + 客户端）

依赖：M1-00 已完成（`docs/m1-probe.md`）。这是 M1 的关键部件：「关网页 / 重启服务不重复执行」靠它。

先读：`docs/M1-PLAN.md` §3.3、§4.4（**已按探针结论修订，以修订后的为准**）；`docs/m1-probe.md`（A2、B2、B3、B4）；`src/sandbox/sprites.mjs` 头部注释（exec 的限制：URL 约 64 KB、输出大于 64 KB 可能丢、退出状态 -1 表示结果不明）；`src/env.mjs` 的 `shellQuote`、`WRITE_CHUNK_BYTES`。

## 你只能创建/修改
- `src/runner/runner.sh`、`src/runner/client.mjs`
- `test/runner.test.mjs`

## 已由探针确定的事实（不要再怀疑，也不要放宽）
- Sprite 有 `setsid`、`flock`、`/proc`、`base64`、`sha256sum`、`dash`（B2）。
- `setsid` 后台进程在 exec 断开后继续运行；`/proc/<pid>/stat` 起始时间加 `boot_id` 稳定；`kill -TERM -<pgid>` 能杀掉整个进程组（B3）。
- **exec 的 argv 在 WebSocket URL 里**。全 `0xff` 的最坏数据：12 KiB 原始数据可过，20 KiB 编码后 82,099 字符 > 64,000（B4 补充）。所以**命令正文、环境变量不得放进 argv**，必须分块写文件（见下）。
- 单块 12 KiB 原始数据往返 5/5 一致；回读 200 KiB 本轮完整，但历史上有大输出丢失记录，所以 `wait` 单次返回的数据仍要设上限。

## 要求
1. `runner.sh` 是 POSIX sh（`dash` 下可运行），目录 `~/.pca/runs/<id>/`（`PCA_HOME` 可改根目录，测试用）。子命令按 `docs/M1-PLAN.md` §4.4：`prepare`、`start`、`wait`、`status`、`kill`、`version`。
2. **`prepare`**：`mkdir` 原子占位。目录已存在 → **不覆盖、不改动**，输出当前状态。成功占位后从 `~/.pca/stage/<id>/` 读入命令与环境文件，核对 sha256，写入 `cmd`、`meta`，状态 `claimed`。**环境变量值不得写入 `cmd`、`meta` 或任何持久文件**：密钥环境由供应商 exec 的环境提供，包装进程继承它。
3. **`start`**：仅当状态为 `claimed` 且还没有 `ident` 文件时才启动；用 `setsid` 启动包装进程，包装进程写 `ident`（boot_id + 起始时间）、执行 `sh -c "$(cat cmd)"`、输出重定向到 `out.log`，结束后先写 `exit.tmp` 再 `mv` 成 `exit`（原子）。已启动过则**什么都不做**，只返回当前状态。
4. 状态判定：有 `exit` → `exited`；无 `exit` 且 `ident` 对应进程在 → `running`；有 `ident` 但进程不在 → `lost`；目录存在但没有 `ident` → `claimed`；目录不存在 → `missing`。**`claimed`、`lost`、`missing` 都不得由 runner 自动重新启动。**
5. `wait --from N --max S`：每 0.5 秒检查一次，`out.log` 大于 N、已结束、或到 S 秒就返回；先输出 `key=value` 头（`state`、`exit`、`offset`），再输出 `--data--` 与从 N 开始的原始日志字节；单次数据上限 32 KiB（超过只返回上限，`offset` 指向下一个字节，调用方再来）。
6. `kill --grace S`：先比对 `ident`，**身份对不上就不动手**并返回 `killed=not-found`；对得上则 `kill -TERM -<pgid>`，等 S 秒，仍在则 `-KILL`；确认进程消失才返回 `killed=confirmed`，否则 `unconfirmed`。绝不使用 `pkill` 或按名字杀。
7. `client.mjs`：
   - `createRunnerClient({ bash, runnerPath })`。`install()`：比对 `version`，不一致才写入脚本（按 12 KiB 分块 base64、最后 `chmod +x` 并校验 sha256），幂等。
   - `prepare({id, cwd, command, env?})`：把命令与环境按 12 KiB 原始数据分块 base64 写入 `stage/<id>/`，校验 sha256 后调用 `runner.sh prepare`。**`env` 中的值只允许通过 `bash` 原语的 `env` 选项传递**，若原语不支持就拒绝带 `env` 的调用并报错（不要降级成写文件）。
   - `start(id)` / `wait` / `status` / `kill`：构造命令、解析 `key=value` 与 `--data--` 之后的字节。日志按字节偏移续读，多字节字符在块边界被切开时用 `StreamDecoder`（`@earendil-works/pi-durable/env` 导出）保持完整。
   - `runIdFor({namespace, generation, taskId})`：`sha256(`${namespace}:${generation}:${taskId}`)` 前 24 位十六进制，纯函数。`commandHash(command, cwd)`：`sha256`。
   - `bash` 抛「连接中断、命令可能已执行」类错误时，`prepare` / `start` **不重试**，原样抛出（由上层按「结果待确认」处理）；`wait` / `status` 是只读的，可以有限重试。
8. 已知偏差写在文件头注释：stdout / stderr 合并；`lost` / `claimed` 状态；不处理命令自己 `setsid` 逃出进程组的情况；只支持 Linux。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先确认 `npm ls @earendil-works/pi-durable` 是 1.4.0）。**runner 测试在本机直接跑 `runner.sh`**（`PCA_HOME` 指向临时目录）。本机是 macOS 没有 `/proc` 时，测试通过 `PCA_PROC_ROOT` 之类的注入点提供一个假 `/proc` 目录结构，或在没有 `/proc` 时跳过需要真实进程身份的用例并**在汇报里写明跳过了哪些**；生产代码不为 macOS 加另一套进程身份实现。必测：
  - `prepare` 两次同 id，命令只会被占位一次，第二次不改动目录；`start` 两次，命令只执行一次（计数文件只有 1 行）；
  - **`prepare` 之后、`start` 之前**停下（只调用 prepare）：状态为 `claimed`，客户端 `status` 返回 `claimed`，**没有任何进程**，也不会被 `start` 之外的路径启动；
  - 命令运行中，客户端「断开」（丢弃 `wait` 调用）再用新的客户端 `wait` 同 id，能接上并拿到后续日志与退出码；
  - `wait` 按偏移续读，拼起来等于完整日志，含多字节字符与大于单块上限的输出；
  - 非零退出码、命令不存在、被信号杀死；
  - `kill` 杀整个进程组（命令里有子进程）；伪造 `ident` 不一致时不杀；
  - 删掉 `exit` 且进程已不在 → `lost`；不存在的 id → `missing`；
  - 命令 > 20 KiB、含 `\0` 以外的任意字节也能原样执行；**`meta`、`cmd`、`stage/` 里搜不到注入的假环境变量值**（断言）；
  - 脚本在 `sh` 与 `dash`（若有）下都能运行。
- 真实 Sprite 的测试：写成可选测试，用环境变量 `TARSBOT_LIVE_SPRITE` 开启（默认跳过），只对 `pca-` 前缀的测试 Sprite 运行，同时存在不超过 3 个，结束删除。没有条件运行就在汇报里写明「未验证」。

最后输出：改动文件、测试结果、对 `docs/M1-PLAN.md` §4.4 的偏离、未验证项。
