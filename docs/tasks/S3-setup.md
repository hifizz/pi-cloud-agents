# Sprites / S3-setup：`scripts/sprite-setup.sh`

依赖：S0-probe（network policy、checkpoint 的实测结论）。**会修改远端 Sprite；network policy 配错会让 Sprite 无法访问 GitHub，脚本必须能重跑修复。**

先读：`docs/SPRITES-PLAN.md` §4.1–§4.3；`docs/sprites-probe.md`（P8–P11）；`scripts/space-up.sh`（参考写法）。

## 你只能创建/修改
- `scripts/sprite-setup.sh`（新增）
- `scratch/sprite-setup.mjs`（新增，仅当 shell 无法直接调用 SDK/CLI 时，作为脚本的辅助）
- `README.md`（新增"Sprite 初始化"一节）
- 失败时 `docs/fail-S3-setup.md`

## 要求
脚本幂等，每步先检查、已完成则跳过，打印每步 `OK` / `SKIP` / `FAIL`。token 只从环境变量读，不打印、不写入 Sprite 磁盘。

1. Sprite `TARSBOT_SPRITE_NAME` 不存在则创建。
2. 安装 `gh`（已安装则跳过）。
3. 写 git credential helper（从 `$GH_TOKEN` 读取，见 §4.2）；设置 `user.name "TARSBot"` 和 `user.email`（GitHub noreply 地址，从 `TARSBOT_GIT_EMAIL` 读取，未设置时报错退出）。
4. `mkdir -p /home/sprite/workspace`。
5. network policy：按 probe 结论设置出站白名单。若 probe 结论是不支持按域名放行，则跳过此步并打印 `SKIP (unsupported)`。`--no-policy` 参数可跳过此步。
6. 自检：带 `GH_TOKEN` 执行 `git ls-remote https://github.com/hifizz/tars-sandbox-playground.git` 和 `gh repo view hifizz/tars-sandbox-playground`，均成功。
7. 创建 checkpoint `v-setup`（已存在时用 `--recheckpoint` 才覆盖）。

## 验收
- 连续运行两次：第二次全部 `SKIP` 或 `OK`，无报错。
- 自检步骤成功。
- `grep -r "ghp_\|github_pat_" ` 在 Sprite 的 `/home/sprite` 下无结果（用 exec 执行）。

最后输出：改动文件、两次运行的输出（不含 token）、network policy 实际效果、未验证项。
