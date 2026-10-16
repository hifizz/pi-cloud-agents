# Sprite `pi-cloud-agents` 初始化记录

验证日期：2026-10-16。脚本：`scripts/sprite-setup.sh`（→ `scratch/sprite-setup.mjs`），幂等，可重跑。

## 基本信息

| 项 | 值 |
|---|---|
| Sprite 名 | `pi-cloud-agents`（`.env` 的 `TARSBOT_SPRITE_NAME`；Fly secrets / `[env]` 同名） |
| Region | 未指定。SDK（`@fly/sprites`）与已用 API 没有 region 列表接口，`getSprite` 也未返回 `primaryRegion`；脚本仅在设置 `TARSBOT_SPRITE_REGION` 时才传 `region` |
| 请求规格 | `cpus: 4`、`ramMB: 4096`（可用 `TARSBOT_SPRITE_CPUS` / `TARSBOT_SPRITE_RAM_MB` 覆盖，仅创建时生效） |
| 实际规格 | **请求被服务端忽略**：`nproc`=8，`free -m` total=8192 MB，`df -h /home/sprite` 根 overlay 99 GB；`getSprite().config` 为空。与 `SPRITES-PLAN.md` §11 的记录一致（计费按实际用量），未重建 |
| Sprite 版本 | `0.0.2-beta.6` |

## 初始化步骤结果

最终一次运行 `scripts/sprite-setup.sh`：退出码 0，10 OK / 5 SKIP / 0 FAIL。

| 步骤 | 结果 |
|---|---|
| 1 创建 Sprite | OK（首次运行创建） |
| 2 gh | 预装 `gh 2.79.0`，SKIP |
| 3 git credential helper + 身份 | OK（`user.name=TARSBot`，`user.email` 取自 `TARSBOT_GIT_EMAIL`；token 只经 exec 的 `GH_TOKEN` 环境变量注入） |
| 4 `~/workspace` | OK（`/home/sprite/workspace`） |
| 5 network policy | OK |
| 6.1–6.2 `git ls-remote` / `gh repo view` | OK（`hifizz/tars-sandbox-playground`，PRIVATE，默认分支 main） |
| 6.3–6.7 clone / node / npm install / npm test | OK（node v24.18.0；测试 110 pass / 0 fail；临时目录已清理） |
| 6.8 policy 生效 | OK（`example.com` 被拦；白名单域名均可达） |
| 6.9 Sprite 磁盘与 git config 无 token | OK |
| 7 checkpoint | OK，注释 `v-setup`，服务端 id `v2` |

脚本改动：创建时传 `SpriteConfig`；`sprite-setup.sh` 在 `.env` 不存在时直接用环境变量运行；6.9 的 `ghp_`/`github_pat_` 模式扫描排除 Sprite 预装的 `~/.grok`（其文档含占位符 `ghp_xxx`，第一次运行因此误报，精确值扫描始终无命中）。

## Network policy

放行（allow）：`github.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`、`raw.githubusercontent.com`、`release-assets.githubusercontent.com`、`registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`；其余 `*` 全部 deny。

## 冒烟

`echo ok && ls /home/sprite/workspace && gh --version && git config --global user.email`：输出 `ok`、`gh version 2.79.0`、配置的 git 邮箱（workspace 为空）。注入 `GH_TOKEN` 后 `git ls-remote https://github.com/hifizz/tars-sandbox-playground.git HEAD` 成功（返回 HEAD 前 12 位 `3157db095cb9`）。

## 其他 Sprite

`tarsbot-dev` 只读 `getSprite` 前后对比：status `cold`、`updatedAt` `2026-10-13T09:58:06.876Z`、version `0.0.2-beta.5`，均未变化。

## 密钥

本文不含任何 token。涉及的键名：`SPRITES_TOKEN`、`GITHUB_TOKEN`（注入为 `GH_TOKEN`）、`TARSBOT_GIT_EMAIL`、`TARSBOT_SPRITE_NAME`。
