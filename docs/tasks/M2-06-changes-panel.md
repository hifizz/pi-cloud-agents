# M2-06：Git 改动面板（前端）

依赖：M2-05 的接口约定（可并行：先用假数据按约定实现，联调在 M2-11）。

先读：`docs/M2-PLAN.md` §3.2；`docs/tasks/M2-05-changes-backend.md`（接口形状：`GET /api/workspaces/:id/changes`、`.../changes/patch?path=`）；`web/src/panels/diff/source.ts`（`DiffSource` 接口、现有 `conversationSource`）、`DiffPanel.tsx`、`DiffFileCard.tsx`（`ChangedFile {path, add, del, lines}`）、`DiffToolbar.tsx`；`web/src/lib/diff.ts`（`DiffLine`、`parsePiDiff`）、`web/src/lib/turns.ts`（`TurnChange`）；`web/src/panels/types.ts`（`PanelContext` 没有 workspaceId）；`web/src/lib/workspaces.ts`（`mapBotsToWorkspaces`、`workspacesApi`、`WorkspaceContext`）；`web/src/components/EnvironmentPane.tsx`（如何拿到当前工作区）。

## 你只能创建/修改
- `web/src/panels/diff/` 下的文件（含新增 `gitSource.ts`）
- `web/src/lib/diff.ts`、`web/src/lib/turns.ts`、`web/src/lib/workspaces.ts`（仅新增 `changes` 相关 API 与类型）、`web/src/types.ts`
- `web/src/panels/types.ts`（仅在需要把工作区 id 传给面板时）
- `web/test/diff-panel.test.tsx` 与新增的 `web/test/git-changes.test.tsx`

**共享文件**：`web/src/lib/api.ts`、`web/src/types.ts`、`web/src/lib/workspaces.ts`（以及 M2-09 的 `src/control/store.mjs`）会被其他任务同时修改——只追加、用精确小编辑、不整文件重写，规则见 `docs/M2-PLAN.md` §8.1。

## 要求
1. **数据源切换**：面板在"会话改动"与"工作区 Git 改动"之间切换（默认 Git 改动，工作区未就绪或接口 409 时退回会话改动并说明原因）。`gitSource` 实现现有 `DiffSource` 接口，不要重写面板。
2. **适配器**：把 unified diff 解析成 `DiffLine[]`（`@@ -a,b +c,d @@` → `gap` 行；新增/删除/上下文行的行号规则与现有渲染一致：新增与上下文用新文件行号，删除用旧文件行号）。二进制文件显示"二进制文件已更改"而不是内容；重命名显示 `旧 → 新`；`ChangedFile` 增加可选的 `status`（`M/A/D/R`）、`binary`、`oldPath`，在文件头显示徽标。
3. **按需取补丁**：先取 `changes` 列表（文件名与行数），某个文件展开时才请求它的 `patch`，同一文件同一次刷新内只请求一次；`truncated` 时显示"补丁过长，已截断"。
4. **刷新时机**（不要轮询）：打开面板或切到该标签；`bash`/`edit`/`write` 工具部分变为 `done`（防抖约 1.5 秒）；会话由忙变闲；手动"刷新"按钮。刷新进行中不重复发起；请求失败显示错误和重试，**保留上一次成功的内容**。
5. 总计行：`N 个文件 +add −del`；超过 200 个文件时显示"仅显示前 200 个"。
6. 不泄漏：界面与日志不显示服务器路径之外的东西，不显示令牌；路径显示为仓库内相对路径。
7. 无障碍：切换用 `role="tablist"`/`tab`，加载中用 `aria-busy`，错误用 `role="alert"`。

## 验收
- `cd web && npm test && npm run typecheck && npm run build` 通过；`TARSBOT_NO_DOTENV=1 npm test` 不受影响（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。
- 必测（假 fetch）：适配器对"新增文件/删除文件/多处修改/无换行结尾/二进制/重命名/空 diff"的输出；展开才取补丁、重复展开不重复请求；刷新的各触发点与防抖、进行中不重入；失败保留旧内容；409 退回会话改动；超过 200 个文件的提示；切换数据源不丢展开状态以外的东西。
- 不起服务、不占 8090/5183、不用浏览器（编排者统一验收）。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项。
