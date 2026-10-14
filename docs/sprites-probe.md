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

## 第二批：耗时项（2026-10-14 实测，日志 `logs/probe-slow.log`）

| 项 | 结果 |
|---|---|
| P5 `sleep 90; echo done` | ✅ 正常返回 `done`，总耗时 90.7 s；VM 内的 uptime 与本地时钟同步增长（+91.7 s），没有被冻结 |
| P6 单条 exec 5 分钟 | ✅ `sleep 300; echo done` 完整返回，301 s，退出码 0。期间 `GET` 状态在 `cold` / `running` 之间来回变化，exec 不受影响，**不能用状态字段判断命令是否还在跑**。15 / 30 分钟未测，当前只能确认上限 ≥ 5 分钟 |
| P7 空闲 60 s 后再 exec | ✅ 旧的 control-mode 连接 272 ms 返回；全新 WebSocket 673 ms 返回，**不需要重试**。VM 内 uptime 连续，没有观察到暂停 |
| P8 Tasks API 保活 | ✅ API 可用（经 exec 访问 Sprite 内的 `/.sprite/api.sock`）：创建 `POST /v1/tasks`、列出 `GET`、续期（同名 PUT 覆盖，`expires_at` 刷新）、释放 `DELETE`（对不存在的任务返回 22 / not found） |
| P9 network policy | ✅ 见下节 |
| P10 checkpoint | ✅ 见下节 |

**局限：** P5 / P7 / P8 都用 VM 内 uptime 与本地时钟对比来检测暂停。结果是**所有场景（含没有任何保活的对照组，空闲 50–135 s）都没有检测到暂停**，所以 P8 无法证明"保活确实阻止了暂停"，只能证明保活 API 本身可用。方案里写的"空闲约 30 s 暂停"在这几次测试里没有复现。真正暂停后 TCP 连接的表现（P7 的核心问题）也就没有机会观察到。

**对实现的结论：**
1. **默认 exec 超时**：10 分钟可以保留（已确认 ≥ 5 分钟的命令能跑完）；更长的命令未测。
2. **唤醒重试**：S1-bash 现有策略足够（只在连接建立前失败时重试一次）；实测里没有触发过。
3. **保活（S4-keepalive）**：Tasks API 可用，但暂停行为在本次测试条件下未复现，因此保活的实际收益无法验证。建议实现为"活动租约"，注册失败只记日志、不影响 exec；是否值得保留，等 L3 的"Sprite 暂停后唤醒"场景再用真实暂停验证。
4. 状态字段（`cold` / `warm` / `running`）不可靠，代码里不要依赖它。

## P9 network policy ✅（2026-10-14，`node scratch/sprite-probe.mjs p9`，测完已恢复）

- API：`sprite.getNetworkPolicy()` / `sprite.updateNetworkPolicy({ rules })`（REST：`GET|POST /v1/sprites/{name}/policy/network`，更新返回 204）。默认 `{"rules":[]}` = 不受限。
- 规则形如 `{action:"allow"|"deny", domain:"github.com"}`，**支持按域名放行**；末尾加 `{action:"deny", domain:"*"}` 即白名单模式。更新整体替换，GET 原样返回写入的规则。
- 生效很快：更新后约 0.8 s `example.com` 即不可达（`curl` 返回 `000`，`getent hosts` 退出码 2 → **DNS 层拦截**，非白名单域名解析不出来）；白名单域名正常解析。
- 白名单 = github.com、api.github.com、codeload.github.com、objects.githubusercontent.com、registry.npmjs.org、pypi.org、files.pythonhosted.org 时，实测：
  - 可达：以上全部（`github.com` 200、`codeload` 301、`registry.npmjs.org` 200、`pypi.org` 200…）；`git ls-remote`（带 `GH_TOKEN`）、`pip download`、`npm view` 均成功。
  - 不可达：`example.com`、`www.google.com`、`1.1.1.1`（IP 直连也被拒）、`archive.ubuntu.com`（apt 不可用）、`cli.github.com`（gh 的 apt 源不可用，所以 `gh` 缺失时只能从 github.com release 下载）。
- 不影响 exec 通道（连入方向）：策略生效期间 exec 照常工作（保活 Tasks API 未在策略下单独测试）。
- 恢复：`POST {rules:[]}` → 204，约 1 s 内恢复访问；脚本 `p9restore` 可单独恢复。
- 本任务（`scripts/sprite-setup.sh`）最终策略：上述 7 个 + `raw.githubusercontent.com` + `release-assets.githubusercontent.com`（GitHub release 下载重定向目标），其余拒绝。

## P10 checkpoint ✅（2026-10-14，`node scratch/sprite-probe.mjs p10`）

- API：`sprite.createCheckpoint(comment)`（流式，`processAll` 到 `complete`）、`sprite.listCheckpoints()`、`sprite.restoreCheckpoint(id)`；删除没有 SDK 方法，用 REST `DELETE /v1/sprites/{name}/checkpoints/{id}`（204）。
- **checkpoint 的 id 由平台分配（`v1`、`v7`…），不能自定义**；"名称"只能放在 `comment`。因此 `v-setup` 实现为 `comment="v-setup"` 的 checkpoint，脚本按 comment 查找。另有伪条目 `Current`。
- 创建约 1.5 s（流里含 `Path: checkpoints/vN`）。
- 恢复：流结束约 4 s，之后首次 exec 约 5 s 内成功（本次第 1 次尝试即成功）；恢复后文件系统回到 checkpoint 时刻（探针写入的文件消失）。
- ⚠️ **恢复会自动再创建一个 `pre-restore <时间>` checkpoint**（本次 `v8`），需要手动清理。
- 删除约 10 s 返回 204。恢复后删除被还原的那个 checkpoint 成功。
- 本任务中 `v1`（initial checkpoint）保持不动；`v-setup` 的替换流程为"先建新的再删旧的"。
