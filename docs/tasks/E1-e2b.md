# E2B / E1-e2b：E2B 沙箱原语 `src/sandbox/e2b.mjs`

依赖：无（与 E2 并行）。

先读：`docs/E2B-PLAN.md`（全文，契约 §3.1）、`docs/CONTRACTS.md` §2、`src/sandbox/sprites.mjs` 与 `test/sprites.test.mjs`（同形实现与测试风格）、`src/env.mjs`（调用方：它会传入什么样的脚本、依赖哪些 GNU 工具）、`scratch/sprite-exec.mjs`、`scratch/sprite-probe.mjs`、`docs/sprites-probe.md`（探测记录的写法）。
E2B API 以 `node_modules/e2b/dist/index.d.ts` 为准（`Sandbox.create/connect/list/kill/pause/getInfo`、`SandboxOpts.lifecycle`、`SandboxListOpts.query.metadata`、`commands.run`、`CommandStartOpts`（注意默认 `timeoutMs` 只有 60 秒）、`CommandHandle`、`CommandExitError`、`TimeoutError`、`NotFoundError`）。必要时查 https://e2b.dev/docs。

## 你只能创建/修改

- `src/sandbox/e2b.mjs`（新建）
- `test/e2b.test.mjs`（新建，离线）
- `scratch/e2b-exec.mjs`、`scratch/e2b-probe.mjs`（新建）
- `docs/e2b-probe.md`（新建，探测记录）
- 失败时 `docs/fail-E1-e2b.md`

**不要碰**：`src/config.mjs`、`src/env.mjs`、`src/sandbox/index.mjs`、`src/routes/`、`src/ext/`、`web/`、`package.json`（`e2b@2.56.0` 已装好）、其他测试。e2b.mjs **不得 import `config.mjs`**（与 sprites.mjs 一样直接读 `process.env`，保证离线测试不读 `.env`）。

远端：只能创建 metadata `{ app: "pi-cloud-agents", name: "probe-<时间戳>" }` 的探测沙箱，**结束时（含失败路径）必须 kill**；不得创建、连接、暂停或 kill `name=pi-cloud-agents` 的沙箱（那是 E3 的），账户里其他沙箱一律不动。

## 要求

1. 实现契约 §3.1 的全部导出。
   - `createE2bBash` 注入 `Sandbox` 类（真实 SDK 或测试替身），首次调用时用 `findE2bSandbox` 找到沙箱并缓存实例；并发的首次调用共用同一个 Promise。
   - 每次调用前保证沙箱在运行且剩余存活时间足够：超时时间设为 `max(idleTimeoutMs, 本次命令 timeout + 60s)`。具体用 `Sandbox.connect(id, {timeoutMs})`（会恢复已暂停的沙箱）还是 `setTimeout`，以及能否跳过频繁调用以减少往返，按探测结果决定并在代码注释中写明理由。
   - 必须正确处理：沙箱在两次调用之间已自动暂停 → 下一次调用透明恢复并成功；沙箱已不存在 → 清掉缓存，抛 `E2B_SANDBOX_MISSING`。
   - 命令执行：`/bin/sh -c` 语义（`env.mjs` 生成的是 POSIX sh 脚本）。注意 SDK 的 `commands.run` 自身会用 shell 包一层，确认引号/特殊字符/多行脚本/非零退出码/stdin 无输入时都正确（离线测试 + 探测都要覆盖）。
   - `envs` 只放 `opts.env`（生产为 `{ GH_TOKEN }`，有值时）；工作目录默认 `/home/user`。
   - 超时：返回 `{ stdout, stderr, timedOut: true }`，并 kill 远端进程（探测验证进程确实没了）。不传 `timeoutMs` 时用 `defaultTimeoutMs`（默认 10 分钟）——绝不能落到 SDK 的 60 秒默认值。
   - 错误：带 `code`（见契约），消息经 `redactMessage` 式脱敏（API key、env 值、`secrets`）。可从 `sprites.mjs` 复用 `redactMessage`（import 它即可，不要改 sprites.mjs）。只在命令确定没开始（连接/恢复阶段失败）时重试一次。
   - `log` 只记录 `{commandLength, ms, exitCode, retries, outcome, resumed}`，不记录命令和输出；生产实例在 `TARSBOT_E2B_LOG` 非空时打到 stderr。
   - 生产实例读 `E2B_API_KEY`、`TARSBOT_E2B_NAME`（默认 `pi-cloud-agents`）、`TARSBOT_E2B_IDLE_MS`、`GITHUB_TOKEN`；缺 key 抛 `E2B_CONFIG`。
2. `test/e2b.test.mjs`（离线，用 fake `Sandbox` 类）至少覆盖：正常输出、非零退出码转结果、超时 + kill、找不到沙箱、已暂停后恢复、连接失败重试一次后成功/仍失败、并发首次调用只查找一次、错误信息不含密钥、`timeoutMs` 透传（不出现 60 秒默认）。
3. `scratch/e2b-exec.mjs`：`node --env-file=.env scratch/e2b-exec.mjs exec [--timeout-ms N] <command>` / `status`，经生产原语执行，输出脱敏；拒绝在 `TARSBOT_E2B_NAME` 不是 `pi-cloud-agents` 时运行（与 `sprite-exec.mjs` 同理，供 E3/编排者用）。本任务内不要用它连正式沙箱。
4. `scratch/e2b-probe.mjs`（`node --env-file=.env scratch/e2b-probe.mjs`）在临时探测沙箱上测量并写入 `docs/e2b-probe.md`：
   - 默认用户、HOME、OS 版本、`nproc`、`free -m`、`df -h ~`；sudo 是否免密；已装/缺失的 git、gh、node、npm、python3、curl、jq 及版本。
   - `env.mjs` 依赖的命令是否可用且是 GNU 行为：`stat --printf`、`stat -c '%F|%s|%.3Y'`、`base64 -w0`、`find -printf`、`realpath -e`、`mv -T`、`truncate -c`、`mktemp --suffix`。
   - 冷启动（create）、单条命令往返、`connect` 往返耗时（各取几次）。
   - 大输出（1 MB、10 MB stdout）是否完整；大命令（200 KB 脚本）是否可用。
   - 超时 kill 是否生效；非零退出码；`envs` 是否只对单条命令生效（不落盘）。
   - 暂停/恢复：写入文件 → `Sandbox.pause(id)`（或等待一个短的 `timeoutMs` 让它自动暂停，如 30–60 秒）→ 经 `createE2bBash` 再次调用：是否透明恢复、文件是否还在、耗时多少、`Sandbox.list` 中状态如何变化。若条件允许，测一次"自动暂停"路径（create 时 `timeoutMs` 设短值 + `lifecycle.onTimeout = "pause"`）。
   - 账户限制：能否得知 Hobby/Pro、最大 `timeoutMs`（尝试 >1h 是否被拒）；暂停沙箱的保留期（查文档，标明来源）。
   - 结束时 kill 探测沙箱，并用 `Sandbox.list` 确认 metadata `app=pi-cloud-agents, name=probe-*` 已无残留。
5. `docs/e2b-probe.md`：每项写结论与数据，标注日期 2026-10-16，只写键名不写任何密钥或沙箱访问 token。

## 验收

- `TARSBOT_NO_DOTENV=1 node --test test/e2b.test.mjs` 全绿；`TARSBOT_NO_DOTENV=1 npm test` 全绿（失败若来自 E2 负责的文件，注明后忽略）。
- 探测跑完，`docs/e2b-probe.md` 写好，无残留探测沙箱。

最后输出：改动文件、测试命令与结果、探测关键结论（尤其是：用户/HOME 是否为 `user` / `/home/user`、暂停恢复是否透明、缺哪些工具、大输出是否可靠）、未验证项、需要编排者/E2/E3 注意的事。
