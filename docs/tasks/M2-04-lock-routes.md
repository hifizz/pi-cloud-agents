# M2-04：锁路由、人工接管、fork 放开与多会话

依赖：M2-02（`store.locks`）、M2-03（围栏与自动取锁）、M2-08（共改 `src/workspaces.mjs`、`src/routes/workspaces.mjs`、`WorkspaceStatus.tsx`，本任务在其后）。

先读：`docs/M2-PLAN.md` §3.1；`src/control/store.mjs` 的 `locks`（M2-02 产出）；`src/ext/exec.mjs` 与 `src/workspace-env.mjs`（M2-03 产出的围栏规则：无锁时允许写、被别人持有或 `epoch` 变化时拒绝）；`src/routes/fork.mjs`（M1 对非只读 fork 返回 409，并让只读 fork 继承父会话的工作区关联）；`src/routes/workspaces.mjs`（`view()` 只取 `links[0]` 作为 `botId`）；`src/workspaces.mjs` 的 `dispatchTask`（总是用 `conversationsOf(ws.id)[0]`）；`src/ext/routines.mjs`（`Tick` 以 `followUp` 重新提交）；`src/api.mjs` 的 `input`/`abort` 路由；`web/src/components/BotList.tsx`、`web/src/lib/workspaces.ts` 的 `mapBotsToWorkspaces`、`web/src/components/WorkspaceStatus.tsx`。

## 你只能创建/修改
- `src/routes/locks.mjs`、`test/locks.test.mjs`
- `src/routes/fork.mjs`、`test/fork.test.mjs`
- `src/ext/routines.mjs`（**仅例程门控**）、`test/routines.test.mjs`
- `src/workspaces.mjs`（**仅** `dispatchTask` 与"多个会话"相关处；M2-08 同时改同文件的 `normalize` / `workspaceInstructions`，两处不重叠）、`test/workspaces.test.mjs`
- `src/routes/workspaces.mjs`（**仅** `view()` 里的 `botId`/会话列表）、`test/routes-workspaces.test.mjs`
- `web/src/components/BotList.tsx`、`web/src/components/WorkspaceStatus.tsx`（M2-08 已先改，在其基础上追加）、`web/src/lib/workspaces.ts`、`web/src/lib/api.ts`、`web/src/types.ts`（均**只追加**，见 `docs/M2-PLAN.md` §8.1）、新增的 `web/src/components/LockBar.tsx` 与对应测试（`web/test/locks.test.tsx`）；`web/src/App.tsx` 仅在需要给锁组件传参时追加

**不要改** `src/api.mjs`（取锁在 M2-03 的围栏里完成）。

## 要求
### 路由（依赖 `app.ctx.control`、`app.ctx.workspaces`，缺少则不注册）
1. `GET /api/workspaces/:id/lock` → `{ holder: {kind, id, botId?} | null, epoch, sessions: [{botId, conversationId, isHolder}] }`。
2. `POST /api/workspaces/:id/lock/takeover` body `{ requestId }`：以 `user` 身份 `takeover`；对原持有的会话调用 `conv.abort`（用户中止语义，以便杀掉进行中的命令）；暂停该工作区的例程（见 5）。响应 `{ epoch, previous }`。同一 `requestId` 重复调用返回同一结果、不再递增 `epoch`（用 `store.requests`）。
3. `POST /api/workspaces/:id/lock/release` body `{ requestId }`：只有当前持有者（此路由里即 `user`）能释放，否则 409。释放后例程恢复。
4. **谁先写谁拿锁**：由 M2-03 在 Exec 与 env 的首次写入处自动取得，**本任务不再实现取锁，也不改 `src/api.mjs`**。本任务只负责：当锁已被别人持有时，界面和 `lock` 接口如实显示，并在第二个会话的写入被围栏拒绝后，让 409/错误文案指向"可接管"。
### fork 放开
5. `src/routes/fork.mjs`：放开对非只读 fork 的 409。写入型 fork 与父会话同属一个工作区、**不自动取得锁**；返回的 Bot 记录带 `workspaceId`。只读 fork 行为不变。
### 例程
6. 例程的 `Tick` 提交前检查所属工作区：`holder.kind==='user'` 时**跳过**本次提交（不排队、不报错），在例程状态里记录"因接管而跳过"；释放后下次 `Tick` 正常。
### 首条任务与多会话
7. `dispatchTask` 继续提交给主会话（`links[0]`）；`view()` 返回 `botId`（主会话）与 `sessions`（全部会话）；`mapBotsToWorkspaces` 用 `workspace.sessions` 而不是只靠 `parent` 链分组，同一工作区的所有会话在列表里归到一起。
### 界面
8. 工作区里显示当前持有者与"接管 / 交还"按钮；接管有确认（说明会中止对方正在进行的命令）；被接管的会话输入框旁提示"工作区正由你接管"；多个会话在左侧同属一个工作区；"从这里 fork"提供"可写"选项。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿，`cd web && npm test && npm run typecheck` 通过（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。
- 必测：接管/释放的状态码与幂等；`epoch` 严格递增；接管时对原持有会话调用了 abort（假会话断言）；释放权限；写入型 fork 成功且关联到同一工作区、不抢锁；只读 fork 行为不变；第二个会话写入得到 409 而第一个不受影响；接管期间例程被跳过、释放后恢复；`view()` 带 `sessions`；前端分组与按钮状态；响应里没有令牌与服务器路径。
- **FT-M2-1 的时序在 M2-03 里已覆盖**；本任务补一个端到端用例：真实 harness + 假 runner，A 在长命令中，用户接管 → A 的命令被 kill、A 随后的 `write` 被拒、用户（`user` 身份）提交的工作可以写。
- 不连网、不用真实 Sprite、不调用真实模型。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项。
