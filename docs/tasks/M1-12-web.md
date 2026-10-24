# M1-12：Web — 新建工作区、状态与操作入口

依赖：无（按 `docs/M1-PLAN.md` §4.8 的 API 约定用假数据开发，联调在 M1-13 之后）。**不做浏览器验收，不 `npm start`，不占 8090 / 5183 端口**；验收由编排者统一做。

先读：`docs/M1-PLAN.md` §4.8；`docs/UI-PLAN.md`、`docs/ui/`；`web/src/App.tsx`、`web/src/components/BotList.tsx`（现有「新建 Bot」）、`web/src/components/EnvironmentPane.tsx`（现有环境卡，当前只认 `/api/space`）、`web/src/shell/SessionHeader.tsx`、`web/src/lib/api.ts`、`web/src/types.ts`、`web/src/panels/`；现有前端测试的写法（`cd web && npm test`，vitest）。

## 你只能创建/修改
- 新建：`web/src/components/NewWorkspaceDialog.tsx`、`web/src/components/WorkspaceStatus.tsx`、`web/src/lib/workspaces.ts`（API 客户端与类型）
- 修改：`web/src/App.tsx`、`web/src/components/BotList.tsx`、`web/src/components/ForkDialog.tsx`、`web/src/components/EnvironmentPane.tsx`、`web/src/shell/SessionHeader.tsx`、`web/src/types.ts`、`web/src/lib/api.ts`
- 对应的测试文件，放在与现有前端测试相同的目录和命名约定下

## 要求
1. **新建工作区对话框**：仓库（下拉，数据来自 `GET /api/github/repos`，可输入过滤）、起始分支（来自 `GET /api/github/branches?repo=`，默认仓库默认分支）、需求（多行文本）、模型（沿用 `MODEL_OPTIONS`）；「展开设置」里放安装命令。提交时由前端生成 `requestId`（`crypto.randomUUID()`，**在对话框打开时生成一次，重复点击或网络重试都用同一个**），`POST /api/workspaces`。提交按钮在请求中禁用；失败显示服务端 `error`，保留输入，可再次提交（同一个 `requestId`）。
2. **左栏**：以「项目 → 工作区 → 会话」组织（参考 `docs/ui/m1-demo/` 的原型），主入口是「新建工作区」，不再有独立的「新建 Bot」（每个会话都属于一个工作区）。条目上显示仓库名与状态点（准备中 / 就绪 / 失败）。工作区未就绪时，对应 Bot 的输入框禁用并说明原因（准备中：当前步骤；失败：错误与「重试」按钮）。
3. **工作区状态**：`WorkspaceStatus` 展示步骤列表（`runtime / init / code / deps / agent`，每步 pending / running / done / failed / unknown）与错误原因；`unknown` 的文案是「结果待确认」并给「重试」。用 `GET /api/workspaces/:id` 轮询（准备中每 2 秒，就绪后停止；页面隐藏时暂停）。
4. **会话头部与环境面板**：头部显示仓库、分支、环境名（`provider` + `runtimeId` 末 6 位）；环境面板在有工作区时显示工作区信息（仓库、基准分支与提交、工作分支、绑定版本）。不再使用 `/api/space`（没有全局共享沙箱）。
5. **操作入口**（`ready` 的工作区）：「创建 PR」（`POST /api/workspaces/:id/pr`，`requestId` 同样每次点击生成并在失败重试时复用，成功后显示 PR 链接，重复点击显示「已存在」）、「保存检查点」（`POST .../checkpoint`，显示时间与大小）、检查点列表（`GET .../checkpoints`）。重建入口 M1 只做按钮 + 确认对话框，调用 `POST .../rebuild`，写清「会新建一台环境并恢复到该检查点」。
6. 所有错误都有文案，不能只转圈；不显示任何 token，也不在界面输出服务器绝对路径。移动端布局不在本任务范围，但不要写死宽度。

7. **移除「新建 Bot」与写入型 fork 入口**：`App.tsx` 里的 `api.createBot` 与对应表单入口删除（后端不再提供 `POST /api/bots`）；`ForkDialog` 只能创建**只读**会话（去掉可写选项，或固定 `readOnly: true`），文案说明「只读副本，用于查看和讨论，不会修改文件」。`api.ts` 里的 `createBot` 同步删除。

## 验收
- `cd web && npm test` 与 `npm run typecheck` 通过，`npm run build` 成功。
- 必测（用假 `fetch`）：对话框重复提交使用同一个 `requestId`；失败后重试仍是同一个；准备中禁用输入并显示当前步骤；`unknown` 显示「结果待确认」且有重试；创建 PR 成功与「已存在」；没有任何工作区时显示空状态并引导新建；fork 对话框提交的请求里 `readOnly` 恒为 true；界面里找不到「新建 Bot」入口。

最后输出：改动文件、测试结果、未验证项（尤其是没有在浏览器里看过）。
