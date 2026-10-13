# Sprites / S4-keepalive：Bot 工作期间保持 Sprite 不暂停

依赖：S1-bash、S0-probe（P5、P7、P8 结论）。若 probe 证明 exec 期间及两次 exec 间隔内都不会暂停，本任务只需写结论并关闭。

先读：`docs/SPRITES-PLAN.md` §7 步骤 5、§8；`docs/sprites-probe.md`；`src/sandbox/sprites.mjs`。

## 你只能创建/修改
- `src/sandbox/sprites.mjs`
- `test/sprites.test.mjs`
- 失败时 `docs/fail-S4-keepalive.md`

## 设计（与 SPRITES-PLAN §7 的差异）
原方案是"`run_start` 注册、`run_end` 释放"，需要接入 harness 事件。这里改为**活动租约**，只改 `sprites.mjs`、不碰 harness：
- 每次 `spritesBash` 调用开始时续租：若没有有效的保活注册，就用 probe 确认的机制（Tasks API 等）注册。
- 最后一次 exec 结束后 `TARSBOT_SPRITE_IDLE_MS`（默认 5 分钟，覆盖模型思考与审批等待的间隔）内无新调用，就释放保活注册。
- 进程退出（`SIGTERM` / `SIGINT`）时尽力释放；`kill -9` 后依赖平台侧注册的过期时间（如有）。
- 若审批等待通常超过租约时间，Sprite 会暂停，下次 exec 走 S1-bash 的唤醒重试路径：这是可接受的。

## 要求
1. 实现上述租约，时间来源可注入（测试中用假时钟）。
2. 保活注册失败不影响 exec，只记一条日志（不含 token）。

## 验收
- 离线测试：连续调用只注册一次；空闲超时后释放；释放后再次调用会重新注册；注册失败时 exec 照常返回。
- 手工：Bot 执行一个包含 `npm install` 的任务，期间 Sprite 不暂停（按 probe 中的观测方法确认）；任务结束 5 分钟后 Sprite 进入暂停。
- `npm test` 全绿。

最后输出：改动文件、测试结果、手工观测记录。
