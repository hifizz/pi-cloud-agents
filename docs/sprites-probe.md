# Sprites 实测记录（S0-probe）

脚本：`scratch/sprite-probe.mjs <probe>`，只操作 `tarsbot-dev`，输出经脱敏。SDK `@fly/sprites@0.2.3`，Node v24.21.0，2026-10-13。

## 第一批：快速项（已完成）

### P1 SDK 用法（S1-bash 以此为准）

```js
import { SpritesClient } from "@fly/sprites";
const sprite = new SpritesClient(process.env.SPRITES_TOKEN).sprite("tarsbot-dev"); // 不发请求
const cmd = sprite.spawn("/bin/sh", ["-c", command], { env: { GH_TOKEN }, cwd: "/home/sprite" });
cmd.stdin.end();                                  // 必须关闭 stdin，否则读 stdin 的命令会挂起
cmd.stdout.on("data", (b) => ...); cmd.stderr.on("data", (b) => ...);
cmd.on("exit", (code) => ...);                    // 退出码；连接异常结束时为 -1
cmd.on("error", (e) => ...);                      // e.message 含完整 exec URL（带 env 与 argv）→ 必须脱敏
cmd.kill("SIGKILL");                              // 终止远端进程
```

- `sprite.execFile()` 在退出码非 0 时 reject，且不关闭 stdin（`cat` 会挂到超时）→ **不用**，用 `spawn`。
- `sprite.exec(str)` 按空格切分，不是 shell → **不用**。
- 终止：`kill("SIGTERM")` → 143，`kill("SIGKILL")` → 137，远端进程 1.5 s 内消失。**只关闭 WebSocket 不 kill，远端进程还会存活约 10 s**，超时处理必须先 kill。

### P2 基本正确性 ✅
- `echo out; echo err >&2; exit 3` → stdout `out\n`、stderr `err\n` 分开返回，退出码 3。
- 被信号杀死：137 / 143；`exit 300` → 44（mod 256）。
- 热态单次 exec 约 0.7–0.9 s（含建连）。
- 默认 `HOME=/home/sprite`，用户 `sprite`（uid 1001）。

### P3 env 注入 ✅
- env 参数传入的值在远端可用，下一次不带 env 的 exec 看不到；不落盘。
- argv 里不含 env 值。
- ⚠️ **SDK 的错误信息含完整 exec URL，URL query 中带 env 值和 argv**。`spritesBash` 必须对所有 SDK 错误做脱敏（去掉 `?` 之后的部分）再抛出或记日志，否则 `GH_TOKEN` 会进入对话记录和日志。

### P4 大输出 ⚠️ 发现平台 bug
- 现象：命令**一启动就立刻**输出超过约 64 KB 时，约一半概率收不到任何数据，约 11 s 后连接以 1000 关闭，退出码 -1。64 KB 及以下从不出错。
- 与总大小无关：0.5 MB 也会失败，30 MB 慢速流式输出成功；2 MB stdout + 2 MB stderr 并发成功。
- 命令开头加一点延迟即可规避：

  | 启动前延迟 | 1 MB 输出成功率 |
  |---|---|
  | 0 | 3/6 |
  | 0.05 s | 6/6 |
  | 0.1 s | 6/6 |
  | 0.2 s | 6/6 |

- 推测：远端进程输出填满 64 KB 管道缓冲时，服务端还未开始转发，导致卡死。
- **S1-bash 的处理**：命令前固定加 `sleep 0.1;`（每次约 +0.1 s）。退出码 -1 且无输出时，命令可能已执行，**不能自动重试**，按错误返回。
- 影响：`CuaEnv` 读文件用 `base64 -w0`，任何 >48 KB 的文件都会触发；不加规避的话 Bot 读大文件会随机失败。

### P11 环境 ✅（有一处与假设不同）
- Ubuntu **26.04.1 LTS**（方案写的是 25.10），x86_64，内核 6.12。
- 已预装：`git`、`gh`（`/.sprite/bin/gh`）、`node`、`npm`、`python3`、`pip`、`curl`、`jq`、`tmux`。缺 `rg`。
- ⚠️ `stat`、`base64` 等是 **uutils coreutils 0.8.0（Rust 版）**，不是 GNU；`find` 是 GNU findutils 4.10。`CuaEnv` 依赖 `stat --printf '%F|%s|%.3Y'`、`base64 -w0`、`truncate -c`、`mv -T`，需在 S1-env 的 conformance 测试中确认，不兼容时改写对应命令。
- 预置 git 配置 `user.name=Sprite`、`user.email=noreply@sprites.dev`，S3-setup 需覆盖。
- `gh` 已存在 → S3-setup 第 2 步可跳过。

## 第二批：耗时项（待测）

| 项 | 内容 | 预计耗时 | 命令 |
|---|---|---|---|
| P5 | `sleep 90` 期间是否暂停、能否拿到输出 | ~2 min | `node scratch/sprite-probe.mjs p5` |
| P6 | 单条 exec 时长上限（5 / 15 / 30 min） | 5–50 min | `node scratch/sprite-probe.mjs p6 5` |
| P7 | 空闲暂停后唤醒耗时、旧连接报错 | ~2 min | `node scratch/sprite-probe.mjs p7 60` |
| P8 | 保活机制（Tasks API）注册/释放 | ~5 min | `node scratch/sprite-probe.mjs p8` |
| P9 | network policy 按域名放行（测完恢复） | ~2 min | `node scratch/sprite-probe.mjs p9` |
| P10 | checkpoint 创建/恢复（测完删除） | ~3 min | `node scratch/sprite-probe.mjs p10` |

观察到的状态：一次 exec 后 Sprite 从 `cold` → `running` → 约 2–3 分钟后 `warm`。

在第二批测完之前，S1-bash 采用保守默认：超时由调用方决定（fs 操作 120 s）；仅在建连失败（未收到任何输出、命令确定未启动）时重试一次。
