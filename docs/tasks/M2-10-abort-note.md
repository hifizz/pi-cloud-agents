# M2-10：中止结果显示「已停止 / 停止待确认」（事后推导）

依赖：无。

先读：`docs/M2-PLAN.md` §3.6；`src/ext/exec.mjs` 的 `handleAbort`（中止时把结果写进控制库的 `executions`：`state` 与 `exit.killed`）；`node_modules/@earendil-works/pi-durable/dist/harness/tool.js` 的 `abort` 与 `fromSlot`（中止结果由已提交的内容生成通用文本 "Tool X was aborted"）；`web/src/lib/reducer.ts`（约第 206 行把 `aborted` 映射成 interrupted）；`web/src/components/Chat/tools/ToolCall.tsx`；`docs/acceptance/M1/README.md` 的场景 6。

## 背景（已经证实，不要再尝试）
工具内部**无法**让被中止的结果带上自定义文字：中止标记先于信号提交，之后来自「运行」模式的提交被拒绝（`has a durable abort mark`），所以中止前的 `api.output`、`api.details`、`api.diagnostic` 都写不进结果。M1 已经试过两种写法，均无效，已回退。**不要再改 `exec.mjs` 去试第三种。**

## 你只能创建/修改
- `src/routes/executions.mjs`、`test/executions.test.mjs`
- `web/src/lib/reducer.ts`、`web/src/components/Chat/tools/` 下与工具状态显示相关的文件；`web/src/types.ts`、`web/src/lib/api.ts`（共享文件，**只追加**）
- `web/test/` 下对应测试
- （第二步，可选）`src/ext/stopnote.mjs` 与 `test/stopnote.test.mjs`

**共享文件**：`web/src/lib/api.ts`、`web/src/types.ts`、`web/src/lib/workspaces.ts`（以及 M2-09 的 `src/control/store.mjs`）会被其他任务同时修改——只追加、用精确小编辑、不整文件重写，规则见 `docs/M2-PLAN.md` §8.1。

## 要求
### 第一步：事后推导（必做）
1. `GET /api/executions?runIds=a,b,c`（依赖 `app.ctx.control`，缺少则不注册）：只读，最多 100 个 `runId`（`/^[A-Za-z0-9_-]{1,64}$/`，不合法的直接忽略），返回 `{ [runId]: { state: "stopped"|"stop_unconfirmed"|"exited"|"running"|"unknown", exit?: number|null } }`。从 `store.executions.get` 推导：`state=exited` 且 `exit.killed` 为 `abort` 或 `timeout` → `stopped`；`state=unknown`（`handleAbort` 在无法确认时写的）→ `stop_unconfirmed`；`state=exited` 带数值退出码 → `exited`；其余 → `running` / `unknown`。查不到的 `runId` 不出现在结果里。
2. 前端：工具部分（`ToolPart`）带 `details.runId` 且该工具的结果被标成 aborted/interrupted 时，批量请求上述接口，显示「已停止」或「停止待确认」（后者用警示色并说明"命令可能仍在运行"）。没有 `runId`（旧记录）就退回现在的通用文案，不报错。请求要合并批量、同一 `runId` 只查一次、失败时静默退回通用文案。
3. 接口响应与前端展示里**不含**命令正文、环境变量和服务器路径（只有状态与退出码）。

### 第二步：给模型的视图（可选，单独测试，做不完就放弃并在汇报里说明）
`GenerationTask` 的 `beforeRequest` 钩子可以改写发给模型的消息（不改记录）。写一个扩展 `Stopnote`：对 aborted 的 `bash` 结果，如果控制库里能查到该 `runId` 的停止状态，把给模型的文字换成「已停止」或「停止待确认：命令可能仍在运行，请先检查」。装配由编排者在 M2-11 做。先读钩子的类型定义（`node_modules/@earendil-works/pi-durable/dist/**/*.d.ts`），**确认钩子的确存在并可改写消息再动手**；如果不存在或不可行，停止第二步并如实汇报。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿，`cd web && npm test && npm run typecheck` 通过（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。
- 必测：各状态的推导（已停止 / 停止待确认 / 正常退出 / 运行中 / 查不到）；非法与过多的 `runIds`；响应中没有命令正文；前端：有 `runId` 时显示对应文案、批量与去重、接口失败退回通用文案、无 `runId` 的旧记录不受影响。
- **用真实的 Exec + 假 runner 跑一次完整链路**（参考 `test/exec.test.mjs` 的 "user abort" 用例）：中止后 `GET /api/executions` 返回 `stopped`；runner 的 `kill` 返回 `unconfirmed` 时返回 `stop_unconfirmed`。
- 不连网、不用真实 Sprite、不调用真实模型。

最后输出：改动文件、测试结果、第二步是否完成及原因、未验证项。
