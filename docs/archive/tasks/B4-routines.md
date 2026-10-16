# Batch 4 / Task 13（WP7）：定时例程（仅后端）

先读：`docs/CONTRACTS.md`、`docs/PLAN.md` Task 13、规范 §4.6 F06、`vendor-ref/durable-examples/12-tasks.ts`、`13-recovery.ts`、`23-subagent-background.ts`（background 任务、requestId 防重）、`24-child-tasks.ts`、`node_modules/@earendil-works/pi-durable/dist/**/task*.d.ts`（`defineTask`、`waiting`、定时/sleep 能力——务必查清 durable 任务如何"等到某个时刻"并跨重启存活）。

## 你只能创建/修改
- `src/ext/routines.mjs`、`src/routes/routines.mjs`
- `test/routines.test.mjs`、`scripts/routine-test.sh`
- 失败时 `docs/fail-WP7.md`

## 要求
1. 例程 = 一个 durable 后台任务（`background: true`，ownership 为目标 conversation），定义 `{id, botConversationId, prompt, everyMs | atTimes(可选 HH:MM 列表, 本地时区), enabled}`，checkpoint 保存 `nextAt`。
2. 到点：向目标 conversation `submit({type:"input", content: prompt, requestId: \`routine:${id}:${nextAt}\`})`（防重复，REQ-F06-2），然后计算下一个 `nextAt`，再次等待。错过的时刻（进程停机期间）只补发最近一次，不连发。
3. 若 pi-durable 没有原生定时等待：用任务 phase + 进程内 `setTimeout` 调度 + checkpoint 的 `nextAt` 实现（重启后 resume 时依据 `nextAt` 重新挂定时器），并把这一点写进文件头注释。时钟可注入（`createRoutines({ now, setTimer })`）以便假时钟测试。
4. 导出：`Routines`（扩展，name `tarsbot.routines`，含 tasks）、`createRoutine(harness, {botConversationId, prompt, everyMs})`、`listRoutines(harness)`、`cancelRoutine(harness, id)`；例程列表可用 `defineDoc`（scope session 或 conversation，自选并说明）持久化。
5. `src/routes/routines.mjs`：`GET /api/routines`、`POST /api/routines {bot, prompt, everyMs}`（bot 为 id 或 name，经 `app.ctx.bots.get`）、`DELETE` 不支持就用 `POST /api/routines/:id/cancel`。
6. REQ-F06-3：`conv.abort(ctx)`（不带 background）不得中止例程；`abort(ctx,{background:true})` 可以。

## 验收
- `npm test` 全绿：假时钟触发；**TEST-F06-1**：SQLite 存储，建例程（everyMs 很小）→ 关闭 harness → 重开 → 例程仍触发（目标 conversation 出现新 user 输入，requestId 不重复）；**TEST-F06-2**：触发间隙调用 `conv.abort(ctx)` 后例程继续触发。
- `scripts/routine-test.sh`：针对真实 server 的 1 分钟间隔演示步骤（集成后由编排者运行）。

最后输出：改动文件、测试结果、durable 定时机制的结论、需要编排者的集成改动、未验证项。
