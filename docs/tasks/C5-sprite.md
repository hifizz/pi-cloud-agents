# Cloud / C5-sprite：新建并初始化 Sprite `pi-cloud-agents`

依赖：无（与 C1–C4、C6 并行）。

先读：`docs/CLOUD-PLAN.md` §2（D7）、§7；`scripts/sprite-setup.sh`、`scratch/sprite-setup.mjs`（全文）、`src/sandbox/sprites.mjs`、`docs/sprites-probe.md`、`docs/SPRITES-PLAN.md` §4.3、§11；`node_modules/@fly/sprites/dist/client.d.ts`、`types.d.ts`（`SpriteConfig`：`ramMB`、`cpus`、`region`、`storageGB`）。

## 你只能创建/修改

- `scratch/sprite-setup.mjs`、`scripts/sprite-setup.sh`
- `.env` 中**仅** `TARSBOT_SPRITE_NAME` 这一行（用不打印内容的方式修改，例如 node 脚本读文件替换该行后写回，保持文件权限 600；若该行不存在则追加）。不得读出或打印 `.env` 其他内容。
- 新建 `docs/sprite-cloud.md`（结果记录）
- 失败时 `docs/fail-C5-sprite.md`

**不要碰**：`src/`、`web/`、`test/`、其他 scripts、README / AGENTS。远端只操作名为 `pi-cloud-agents` 的 Sprite；**不得修改、删除、重启 org 下任何其他 Sprite（包括 `tarsbot-dev`）**。

## 要求

1. `scratch/sprite-setup.mjs`：创建 Sprite 时传 `SpriteConfig`：`cpus: 4`、`ramMB: 4096`，`region` 选离 Fly `sin` 最近的可用区域（先查 SDK / API 是否有 region 列表；查不到就不传 region 并记录）。这些值可由环境变量 `TARSBOT_SPRITE_CPUS` / `TARSBOT_SPRITE_RAM_MB` / `TARSBOT_SPRITE_REGION` 覆盖。其余步骤（gh 安装、git 身份与 credential helper、workspace、network policy、verify、checkpoint `v-setup`）保持不变。
2. `scripts/sprite-setup.sh`：`.env` 不存在时不要直接退出，改为只要求所需变量已在环境中（便于将来在 Fly 机器上执行）；`.env` 存在时仍用 `--env-file=.env`。
3. 把 `.env` 的 `TARSBOT_SPRITE_NAME` 改为 `pi-cloud-agents`，运行 `scripts/sprite-setup.sh` 完成初始化。
4. 创建后查询实际规格（SDK `getSprite` 返回的字段，或在 Sprite 内 `nproc`、`free -m`、`df -h /home/sprite`），记录"请求 4c/4GB → 实际 X"。旧记录显示服务端可能忽略 cpus/ramMB（`docs/SPRITES-PLAN.md` §11）；若被忽略，如实记录，不要反复重建。
5. 冒烟：用 `node scratch/sprite-exec.mjs`（或等价 SDK 调用）在新 Sprite 执行 `echo ok && ls /home/sprite/workspace && gh --version && git config --global user.email`；验证 `GH_TOKEN` 注入后 `git ls-remote https://github.com/hifizz/tars-sandbox-playground.git` 成功。
6. `docs/sprite-cloud.md`：Sprite 名、region、请求与实际规格、初始化步骤结果、network policy 放行列表、checkpoint 名、验证日期（2026-10-16），只写键名，不写任何 token。

## 验收

- `scripts/sprite-setup.sh` 退出码 0（verify 步骤全部通过）。
- 冒烟输出（去掉任何敏感信息）贴在汇报里。
- 确认 `tarsbot-dev` 未被改动（只读 `getSprite` 状态对比即可）。

最后输出：改动文件、创建的远端资源、实际规格、命令与结果摘要、未验证项。
