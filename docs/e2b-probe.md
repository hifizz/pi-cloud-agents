# E2B 实测记录（E1-probe）

脚本：`scratch/e2b-probe.mjs`，只操作临时沙箱 `probe-1792125182737`，结束时 kill 并核对无残留。SDK `e2b@2.56.0`，Node v24.21.0，日期 2026-10-16。


## 结论摘要（2026-10-16）

| 项 | 结论 |
|---|---|
| 用户 / HOME | `user`（uid 1000）/ `/home/user`，**与 E-D5 一致**；`/home/user/workspace` 不存在，需 setup 脚本创建；sudo 免密 |
| 系统 | Debian 12，2 vCPU / 473 MB 内存（base 模板默认），磁盘 22 GB；`/bin/sh` 是 dash |
| 工具 | 有：git 2.39、gh 2.23（偏旧）、node 20.9、npm 10.1、python3 3.11、pip3、curl、jq 1.6、wget、tar、make、gcc、unzip、ssh。**缺：`rg`（ripgrep）、`sqlite3` CLI** |
| GNU 行为 | `stat --printf`、`stat -c '%F|%s|%.3Y'`、`base64 -w0`、`find -printf`、`realpath -e`、`mv -T`、`truncate -c`、`mktemp --suffix` 全部可用（GNU coreutils 9.1 / sed 4.9） |
| SDK 执行方式 | `commands.run` 实际执行 `/bin/bash -l -c <cmd>`（登录 bash）。我们传 `exec /bin/sh -c '<单引号包裹的命令>'`，得到 dash 语义：`[[` 报错、`$0=/bin/sh`、未闭合引号 exit 2、heredoc/多行/`#` 注释/UTF-8 均正确 |
| 暂停 / 恢复 | **透明**。显式 `Sandbox.pause` 0.5–1.2 s；随后经 `createE2bBash` 调用自动恢复，总耗时 1.6–3.1 s，文件与后台进程都在（内存快照）。`timeoutMs` 到期的**自动暂停**路径也验证了（`setTimeout(20s)` → 约 23 s 后 list 显示 `paused`；全新实例首次调用 list→connect→run 共 1.6 s，文件仍在）。缓存窗口内被外部暂停时，直接调用也能成功（约 2.6 s，SDK/代理自行恢复） |
| 暂停保留期 | 官方文档（https://e2b.dev/docs/sandbox/persistence，2026-10-16 查阅）："A paused sandbox is kept **indefinitely**… no time-to-live and no automatic deletion"。 |
| 账户限制 | `setTimeout` 对 1 h / 24 h / 25 h 都被**接受但封顶为 60 分钟**（endAt = now+60 min）→ 符合 Hobby（SDK 注释：Hobby 1 h，Pro 24 h）。代码把请求的沙箱超时限制在 `maxTimeoutMs`（默认 1 h）；命令超时 ≥ 59 min 时无法保证期间不被暂停 |
| 大输出 | **完整可靠**：1 MB（2.6–4 s）、10 MB（23–34 s）、5 MB 确定性文本 sha256 与远端一致、2 MB stdout + 2 MB stderr 并发完整。吞吐约 0.3–0.4 MB/s，10 MB 偏慢但不丢数据 |
| 大命令 | **argv 单元素上限约 128 KB**：200 KB 脚本直接 `fork/exec /bin/sh: argument list too long`（SDK 错误文本还会回显整条命令）。≤100 KB 内联正常（100 KB 单行实测 OK）。因此 >100 KB 的脚本改为 `files.write` 到 `/tmp/.pca-*.sh` 执行后删除：200 KB 0.97 s、1 MB 0.85 s 均成功 |
| 超时 kill | 有效。`timeoutMs=4000` → 约 4.5 s 返回 `timedOut:true`，保留已产生的 stdout，1.5 s 后远端进程已不存在。**后台子进程**（`(sleep 300 &)`）不会被带走（与 Sprites 一致）。SDK 的前台命令超时本身也会终止进程，但默认只有 60 s，我们始终显式传 timeoutMs 并自己计时 kill |
| 默认 60 s | 不会落到 SDK 默认值：`sleep 70`（timeoutMs=100000）正常完成 |
| 退出码 | 非零退出码是结果（`exit 7`→7，`exit 300`→44）。被信号杀死时 SDK 给 `exitCode=-1`、`error="signal: killed"`，我们映射为 137（SIGTERM→143） |
| stdin | 无输入时 `cat` 立即 EOF，不会挂起 |
| envs | 只对单条命令生效：带 env 的实例命令内可见 `GH_TOKEN`；另一个不带 env 的调用不可见；全盘搜索（/home /etc /tmp）找不到 token 值，不落盘 |
| 耗时 | 冷启动 create 0.75–0.92 s；`list` ≈ 0.23–0.35 s；`connect`（已运行）≈ 0.23–0.25 s（偶发 0.6–1.3 s）；SDK 直接 `commands.run("true")` ≈ 0.24 s；经 `createE2bBash`（后台模式 + wait，窗口内跳过 connect）≈ 0.4–0.7 s |
| 默认模板信息 | `getInfo`: templateId `rki5dems9wqfm4r03t7g`（name `base`），envd 0.10.0；创建时 `lifecycle={onTimeout:"pause"}` 返回 `autoResume:false` |
| 清理 | 探测沙箱 kill 后，`Sandbox.list({metadata:{app:"pi-cloud-agents"}})` 中 `name=probe-*` 为 0 个 |

对 E3/编排者的含义：setup 脚本需创建 `~/workspace`、按需 `apt-get install ripgrep sqlite3`（sudo 免密）、可能升级 gh/node；沙箱 timeout 上限 1 h，空闲暂停靠 `TARSBOT_E2B_IDLE_MS`（默认 10 min）。

---

以下为原始测量输出（`scratch/e2b-probe.mjs` 生成）。

## 1. 创建 / 冷启动

- Sandbox.create("base", {lifecycle:{onTimeout:"pause"}}) 冷启动：**750 ms**
- getInfo：state=running cpu=2 memoryMB=512 templateId=rki5dems9wqfm4r03t7g name=base envdVersion=0.10.0
- lifecycle={"onTimeout":"pause","autoResume":false}；startedAt→endAt = 300 s

## 2. 环境

```
user=user uid=1000 home=/home/user pwd=/home/user shell=/bin/bash
--- os
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
Linux 6.1.158+ x86_64
--- nproc
2
--- free -m
               total        used        free      shared  buff/cache   available
Mem:             473          58         331           1          96         414
Swap:              0           0           0
--- df -h ~
Filesystem      Size  Used Avail Use% Mounted on
/dev/root        22G  1.3G   21G   6% /
--- sudo
sudo: passwordless
--- tools
git: git version 2.39.5
gh: gh version 2.23.0 (2023-02-27 Debian 2.23.0+dfsg1-1)
node: v20.9.0
npm: 10.1.0
python3: Python 3.11.6
pip3: pip 23.2.1 from /usr/local/lib/python3.11/site-packages/pip (python 3.11)
curl: curl 7.88.1 (x86_64-pc-linux-gnu) libcurl/7.88.1 OpenSSL/3.0.22 zlib/1.2.13 brotli/1.0.9 zstd/1.5.4 libidn2/2.3.3 libpsl/0.21.2 (+libidn2/2.3.3) libssh2/1.10.0 nghttp2/1.52.0 librtmp/2.3 OpenLDAP/2.5.13
jq: jq-1.6
wget: GNU Wget 1.21.3 built on linux-gnu.
unzip: caution:  both -n and -o specified; ignoring -o
tar: tar (GNU tar) 1.34
make: GNU Make 4.3
gcc: gcc (Debian 12.2.0-14) 12.2.0
rg: MISSING
sqlite3: MISSING
ssh: unknown option -- -
--- PATH
/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games
--- /sh
lrwxrwxrwx 1 root root 4 Jan  5  2023 /bin/sh -> dash
--- workspace
ls: cannot access '/home/user/workspace': No such file or directory
no ~/workspace
```

## 3. env.mjs 依赖的 GNU 行为

```
stat --printf                rc=0  regular file|5
stat -c '%F|%s|%.3Y'         rc=0  regular file|5|1792125191.765
base64 -w0                   rc=0  aGVsbG8=
find -printf                 rc=0  sub|d|60 f|f|5 link|l|1
realpath -e                  rc=0  /tmp/tmp.DV1Kk1AOHH/f
realpath -e (missing)        rc=1  realpath: nope: No such file or directory
mv -T                        rc=0  b f link sub
truncate -c                  rc=0  
truncate -c (missing)        rc=0  
mktemp --suffix              rc=0  /tmp/tmp.OInkugHfZT.txt
sed --version                rc=0  sed (GNU sed) 4.9
coreutils                    rc=0  ls (GNU coreutils) 9.1
```

## 4. 耗时

- 经 createE2bBash 的单条命令（`true`）往返：首次（含 list+connect）927 ms；之后（窗口内跳过 connect）676, 712, 509, 722, 365 ms
- `Sandbox.connect(id, {timeoutMs})`（已运行）往返：1291, 254, 235, 233 ms
- `Sandbox.list(metadata)` 往返：233, 350, 244 ms
- SDK 直接 `commands.run("true")`（不经我们的封装）：238, 235, 343, 257 ms

## 5. 命令语义（引号 / 多行 / 退出码 / stdin）

- **exit 7** → exit=7 timedOut=false 224ms stdout="" stderr=""
- **stdout+stderr 分流** → exit=0 timedOut=false 248ms stdout="out\n" stderr="err\n"
- **单引号/双引号/$/反引号** → exit=0 timedOut=false 1434ms stdout="a'b c d $HOME /home/user bt\n" stderr=""
- **多行 + heredoc** → exit=0 timedOut=false 442ms stdout="line1 $X\n  line2\ndone\n" stderr=""
- **未闭合引号（应为 sh 语法错误，退出码 2）** → exit=2 timedOut=false 289ms stdout="" stderr="/bin/sh: 1: Syntax error: Unterminated quoted string\n"
- **结尾 # 注释** → exit=0 timedOut=false 715ms stdout="hi\n" stderr=""
- **sh 语义（非 bash）：`[[` 应报错** → exit=0 timedOut=false 317ms stdout="no\n" stderr="/bin/sh: 1: [[: not found\n"
- **$0 / 解释器** → exit=0 timedOut=false 827ms stdout="/bin/sh\n/usr/bin/dash\n" stderr=""
- **cat 无 stdin 输入（应立即 EOF）** → exit=0 timedOut=false 544ms stdout="after-cat\n" stderr=""
- **UTF-8** → exit=0 timedOut=false 767ms stdout="héllo 世界 🎉\n" stderr=""
- **退出码 mod 256** → exit=44 timedOut=false 232ms stdout="" stderr=""
- **被信号杀死** → exit=137 timedOut=false 260ms stdout="" stderr=""
- **cwd** → exit=0 timedOut=false 254ms stdout="/home/user\n" stderr=""
- **超长单行 100 KB（argv 单元素上限附近）** → exit=0 timedOut=false 1058ms stdout="100001\n" stderr=""

## 6. envs 仅对单条命令生效

- 经 createE2bBash（env 含 GH_TOKEN）：命令内 GH_TOKEN **可见**
- 经另一个不带 env 的实例：GH_TOKEN 不可见（不落盘、不跨命令）
- 全盘（/home /etc /tmp）搜索 token 值："scan-done\n"

## 7. 大输出 / 大命令

- stdout 1 MB（base64 随机文本）：收到 1000001 字符（期望 1000001），exit=0，4026 ms
- stdout 10 MB（base64 随机文本）：收到 10000001 字符（期望 10000001），exit=0，33674 ms
- 5 MB 确定性文本完整性：收到 5000001，本地 sha256 前缀 2c8e26f017b8，远端 2c8e26f017b8，18161 ms
- 2 MB stdout + 2 MB stderr 并发：2000000 / 2000000
- 50 KB 脚本（经 createE2bBash，超 100 KB 自动改为上传文件执行；53777 字节，2561 行）：stdout="script-ok-50" exit=0 260 ms
- 200 KB 脚本（经 createE2bBash，超 100 KB 自动改为上传文件执行；215058 字节，10241 行）：stdout="script-ok-200" exit=0 971 ms
- 1000 KB 脚本（经 createE2bBash，超 100 KB 自动改为上传文件执行；1075219 字节，51201 行）：stdout="script-ok-1000" exit=0 850 ms

## 8. 超时 kill

- timeoutMs=4000：返回耗时 4480 ms，timedOut=true，stdout="started\n"
- 1.5 s 后远端进程："GONE\nno-sleep-procs"
- 带后台子进程的命令超时：timedOut=true，3559 ms
- 之后残留 sleep 进程："1764 sleep 300\n1765 sleep 300"（后台子进程不一定被 SIGKILL 主进程带走）
- 信号终止的原始 SDK 结果：name=CommandExitError exitCode=-1 error="signal: killed"
- 对照：SDK `commands.run("sleep 100",{timeoutMs:3000})` 3005 ms 后抛 `TimeoutError`
  - SDK 超时后远端 sleep：gone（SDK 的前台命令超时会断开连接，envd 随之终止该进程；我们仍显式 kill）
- 不落到 SDK 默认 60 s：`sleep 70`（timeoutMs=100000）→ stdout="finished-after-70s" timedOut=false 70551 ms

## 9. 暂停 / 恢复

- 显式 `Sandbox.pause(id)`：返回 true，耗时 489 ms
- list 中状态：paused
- 暂停后经 createE2bBash 再调用：**透明恢复**，总耗时 2656 ms；文件与后台进程："persisted-1792125372\n1789\n 04:36:18 up 3 min,  0 user,  load average: 0.00, 0.00, 0.00\n"（暂停前 "persisted-1792125372\n1789\n"）
- 恢复后 list 状态：running，endAt=2026-10-16T04:38:17.491Z
- setTimeout(20000) 后 endAt 距现在 21 s
- 等待自动暂停，list 状态轨迹：5s:running  11s:running  17s:running  23s:paused
- 自动暂停后全新 createE2bBash 实例首次调用（list→connect 恢复→run）：总 1640 ms，stdout="auto-1792125379\npersisted-1792125372" exit=0
- 再次显式暂停 1051 ms；用已有实例（缓存 aliveUntil 仍有效）调用：
  - 结果 exit=0 stdout="still-works" 2612 ms（若失败，说明缓存窗口内被外部暂停时需靠一次重试恢复）

## 10. 账户限制

- setTimeout(1 h) → 接受，endAt 距现在 60 分钟
- setTimeout(1 h + 1 s) → 接受，endAt 距现在 60 分钟
- setTimeout(24 h) → 接受，endAt 距现在 60 分钟
- setTimeout(25 h) → 接受，endAt 距现在 60 分钟

## 11. 清理

- kill 后 `Sandbox.list({metadata:{app}})` 中 name=probe-* 的沙箱：0 个（无残留）
