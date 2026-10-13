# Sprites / S1-bash：`spritesBash` 原语

依赖：S0-probe（以 `docs/sprites-probe.md` 的 P1 调用示例为准）。

先读：`docs/SPRITES-PLAN.md` §2、§4.2；`docs/sprites-probe.md`；`src/space.mjs`（`spaceBash`、`withSpace` 的重连语义）；`src/env.mjs`（`CuaEnv` 如何使用 `bash`）。

## 你只能创建/修改
- `src/sandbox/sprites.mjs`（新增）
- `test/sprites.test.mjs`（新增）
- 失败时 `docs/fail-S1-bash.md`

## 接口（固定，S1-env 依赖它）
```js
// 工厂：便于注入假客户端测试
export function createSpritesBash({ client, name, env = {}, defaultTimeoutMs, log }) 
  // => async (command: string, { timeoutMs? }) => { stdout, stderr, exitCode?, timedOut? }

// 生产实例：从 process.env 读 SPRITES_TOKEN、TARSBOT_SPRITE_NAME、GITHUB_TOKEN
export async function spritesBash(command, { timeoutMs } = {})

// 给 /api/space 用，不含任何 token
export function getSpriteInfo() // => { sandbox: "sprites", name }
```

## 要求
1. 以 argv `["/bin/sh", "-c", command]` 执行，**不**把命令拼进别的字符串。
2. `GITHUB_TOKEN` 存在时，通过 SDK 的 exec env 参数注入为 `GH_TOKEN`。不得出现在命令文本、日志、错误信息里。
3. 超时：本地计时，到点后终止该 exec，返回 `{ timedOut: true, stdout, stderr }`（保留已收到的输出）。`timeoutMs` 未传时用 `defaultTimeoutMs`（按 probe 建议设置）。
4. 被信号终止、拿不到退出码时，`exitCode` 为 `undefined`（`CuaEnv` 会映射为 137）。
5. 连接失败、Sprite 正在唤醒、WebSocket 中途断开：重连后**重试一次**。重试只适用于"命令尚未开始执行"的情况；若命令可能已在远端运行（已收到输出或已确认启动），不重试，直接抛错（避免 `git commit` 等命令执行两次）。
6. 客户端懒加载，进程内复用一个连接/客户端。
7. 缺少 `SPRITES_TOKEN` 或 `TARSBOT_SPRITE_NAME` 时抛出清楚的错误信息（不含 token 值）。
8. `log` 只记录命令长度、耗时、退出码、重试次数，**不记录命令文本和输出**（命令里可能有用户数据）。

## 验收
- `test/sprites.test.mjs`（离线，注入假 client）覆盖：正常返回；stdout/stderr 分开；非零退出码；超时返回 `timedOut` 且保留部分输出；启动前断线 → 重试一次成功；启动后断线 → 不重试并报错；连续两次失败 → 报错；`GH_TOKEN` 只出现在 env 参数中、不出现在 argv 中；缺配置时报错且错误文本不含 token。
- `npm test` 全绿。

最后输出：改动文件、测试结果、与 probe 结论不一致而做的取舍、未验证项。
