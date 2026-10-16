# E2B 沙箱 `pi-cloud-agents` 初始化记录

验证日期：2026-10-16。脚本：`scripts/e2b-setup.sh`（→ `scratch/e2b-setup.mjs`），幂等，可重跑；`--no-npm` 跳过 clone/测试，`--recreate` 只 kill 并重建同名沙箱。需要 `E2B_API_KEY`、`GITHUB_TOKEN`、`TARSBOT_GIT_EMAIL`；`TARSBOT_E2B_NAME` 若设置必须等于 `pi-cloud-agents`。

## 基本信息

| 项 | 值 |
|---|---|
| 沙箱名（metadata） | `{ app: "pi-cloud-agents", name: "pi-cloud-agents" }` |
| 沙箱 ID | `i5aamq59qgxgvxovg5ww5` |
| 模板 | `base`（`TARSBOT_E2B_TEMPLATE`） |
| 规格 | 2 vCPU（`nproc`=2）、内存 473 MB（API 报 512 MB）、磁盘 22 GB；Debian 12；用户 `user`，HOME `/home/user` |
| lifecycle | `onTimeout: "pause"`、`autoResume: false`；创建 timeout = `TARSBOT_E2B_IDLE_MS`（默认 600000，10 分钟） |

lifecycle 理由（依据 `docs/e2b-probe.md`）：持久化靠 pause（E-D3），空闲到期自动暂停，文件系统与内存保留；运行时每次命令前由 `Sandbox.connect(id)` 显式恢复并续期，因此不需要 `autoResume`（探测中创建时返回的也是 `false`）。

## 步骤结果

最终两次连续运行 `scripts/e2b-setup.sh`：退出码均为 0；第二次 8 OK / 9 SKIP / 0 FAIL（OK 的是每次都重新执行的 verify）。首次创建那次的结果（含修复过程）：

| 步骤 | 结果 |
|---|---|
| 1 创建 / 查找 | OK（首次创建；之后 SKIP）；多个同名沙箱 → FAIL 并列 ID，不自动删除 |
| 2.0 swap | OK：1 GB `/swapfile`（`sudo` 免密）。**必须**：473 MB 内存无 swap 时 `npm ci` 被 OOM kill（输出 `Killed`） |
| 2.1 apt | OK：补装 `ripgrep`、`sqlite3`（base 模板缺） |
| 2.2 gh | OK：模板自带 2.23 过旧，按 release tarball 装 `gh 2.102.0` 到 `~/.local/bin` |
| 2.2b node | OK：模板自带 node 20.9（`node --test "glob"` 不展开，测试仓库跑不起来），装官方 `v24.22.0`（SHA256 校验）到 `~/.local`，npm 11.19.1 |
| 2.3 PATH | OK：`~/.local/bin` 写入 `~/.profile`（SDK 以 `/bin/bash -l -c` 启动，内层 `sh -c` / `bash -c` 继承 PATH）；经生产原语 `e2bBash` 验证 `which gh` 在 `sh -c` 与 `/bin/bash -c` 下均为 `/home/user/.local/bin/gh` |
| 3 git | OK：credential helper 读 `$GH_TOKEN`、`user.name=TARSBot`、`user.email` 取自 `TARSBOT_GIT_EMAIL` |
| 4 `~/workspace` | OK：`/home/user/workspace` |
| 5.1 版本 | git 2.39.5；gh 2.102.0；node v24.22.0；npm 11.19.1；Python 3.11.6；jq-1.6 |
| 5.2–5.3 | `git ls-remote` HEAD `3157db095cb9…`；`gh repo view` → `hifizz/tars-sandbox-playground PRIVATE default=main` |
| 5.4–5.6 | clone 0.9 s（无 token URL）；`npm ci` ≈ 11–12 s；`npm test` ≈ 8.5 s，**110 pass / 0 fail** |
| 5.7 token | `grep -rIlF "$GH_TOKEN" ~`（排除 `node_modules`）与 `git config -l`：无命中 |
| 5.8 暂停/恢复 | 写 `~/.e2b-setup-marker` → `Sandbox.pause`（0.7–1.9 s）→ list 为 `paused` → 经 `e2bBash` 执行 `cat marker && which gh`：透明恢复，耗时 2.3–3.3 s，时间戳一致，`gh` 路径正确，恢复后状态 `running` |
| 6 结束 | 不 kill；沙箱保持 `running`，剩余 timeout ≈ 600 s，之后按 lifecycle 自动暂停 |

所有验证命令都经 `src/sandbox/e2b.mjs` 的生产原语（`GH_TOKEN` 只在命令 envs 中）。

## 冒烟

`echo ok && ls ~/workspace && gh --version | head -1 && git config --global user.name` 输出：`ok`、`tars-sandbox-playground`、`gh version 2.102.0 (2026-09-30)`、`TARSBot`。

## 已知限制

- 未做网络白名单（E-D7，后续项）；沙箱可访问任意外网。
- 账户 timeout 上限 60 分钟（Hobby）；暂停保留期官方文档称无限期（见 `docs/e2b-probe.md`）。
- 内存只有 473 MB：重型构建需依赖 1 GB swap。swap 在内存快照的暂停/恢复中保留；若沙箱被冷启动（非内存快照）则丢失，重跑 `scripts/e2b-setup.sh` 即可重新启用（`/swapfile` 在磁盘上）。
- `~/.local/bin` 的 gh / node 是一次性安装，不自动升级；`TARSBOT_E2B_TEMPLATE` 换模板后需重建并重跑 setup。
- 账户下另有 4 个无 metadata 的暂停沙箱（`ieb1sz3iek0c887kkt5fd`、`igj51lmghocdokm60w1it`、`ixsf1bdkwxu57wybwtu8q`、`iit14i7z6nbgqjm7bgo8x`），非本任务创建，未触碰。
