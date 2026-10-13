# Sprites / S0-probe：实测 Sprites SDK 与平台行为

依赖：S0-node24。需要 `.env` 中的 `SPRITES_TOKEN`、`TARSBOT_SPRITE_NAME`。**会在 Fly.io 创建或唤醒 Sprite，按秒计费；结束后让 Sprite 回到空闲状态。**

先读：`docs/SPRITES-PLAN.md` §2、§4.3、§8；`node_modules/@fly/sprites/README.md` 及其类型定义（`*.d.ts`）；`src/space.mjs`（对照 `spaceBash` 的返回结构）。

## 你只能创建/修改
- `scratch/sprite-probe.mjs`（新增）
- `docs/sprites-probe.md`（新增，实测结论）
- 失败时 `docs/fail-S0-probe.md`

## 要求
`scratch/sprite-probe.mjs` 用 SDK 的 WebSocket exec（不用 `execFileHTTP`），逐项实测并打印结果。任何 token 都不得打印。

| # | 实测项 | 方法 |
|---|---|---|
| P1 | SDK API 形态 | 记录：创建/获取 Sprite、exec 的签名；如何传 argv、env、cwd；如何拿到 stdout/stderr（是否分开）和退出码；如何主动终止一条 exec |
| P2 | 基本正确性 | `["/bin/sh","-c","echo out; echo err >&2; exit 3"]` → stdout、stderr、退出码 3 |
| P3 | env 注入 | 通过 SDK 的 env 参数传 `PROBE_SECRET=xyz`，执行 `test "$PROBE_SECRET" = xyz`；确认命令文本里不含该值 |
| P4 | 大输出 | `head -c 5000000 /dev/urandom \| base64 -w0`，比较本地收到的长度与 sha256 是否一致 |
| P5 | 长命令与暂停 | `sleep 90; echo done`：命令期间 Sprite 是否被暂停、连接是否断开、能否拿到 `done` |
| P6 | 单条 exec 时长上限 | 依次尝试 5 / 15 / 30 分钟（`sleep`），记录被平台中断的时间点；超过 30 分钟不再测 |
| P7 | 暂停后唤醒 | 空闲 60 秒后再 exec，记录唤醒耗时，以及旧连接是否报错、报什么错 |
| P8 | 保活 | 查清 Tasks API（或等价机制）的用法，实测注册后空闲 2 分钟不暂停、释放后会暂停 |
| P9 | network policy | 查清 API；实测能否只放行 `github.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`、`registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`。**测完恢复为不限制** |
| P10 | checkpoint | 创建 checkpoint `probe-cp` → 写一个文件 → 恢复 → 文件消失；记录耗时；测完删除 `probe-cp` |
| P11 | 环境 | `uname -a`、`id`、`echo $HOME`、`which git gh node python3 base64 stat find realpath truncate mktemp`、`stat --version`（确认 GNU coreutils，`CuaEnv` 依赖 `stat --printf`、`find -printf`、`base64 -w0`） |

## 验收
- `docs/sprites-probe.md` 每一项都有结论：实测数据，或写明"未能验证"及原因。
- P1 写成一段可直接照抄的调用示例，S1-bash 以它为准实现。
- 文档末尾给出建议：`spritesBash` 的默认超时、重试策略、保活方式、network policy 是否可行。

最后输出：P1–P11 结论摘要、与 `SPRITES-PLAN.md` 假设不一致的地方、Sprite 当前状态（确认已空闲）。
