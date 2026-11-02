# Devin Prompt Composer 集成验收

任务：用 `../playground.zilin.im` 的 Devin Prompt Composer 组件族替换聊天 Composer，权限 / 所在目录 / 云沙箱状态 / steer / follow-up 全部接入真实数据；配套新增按会话的审批策略后端。

环境：8092 后端（新代码，含 approval-policy 路由）+ Vite dev 5183（临时配置 `web/vite.8092.config.ts`，本地不入库），账号 `demo@localhost`。

## 实现

- **前端**：`web/src/components/composer/`（frame/root/input/toolbar/context-strip/primitives/action-button/status-indicator/send-button/permission-select + `ui/popover-menu.tsx`），暗色 token + hugeicons 适配；未 vendor 的槽位（Attach/Mic/AgentSelect/DiffSummary/InfoBar/model-catalog）无真实功能支撑，明确不用。
- **后端**：bot 记录新增 `approvalPolicy`（`ask` 默认 / `auto`）；`createApproval` 闸口经 `setApprovalPolicyLookup` 晚绑定查询策略，auto 直接 memo 放行不停车；`PATCH /api/bots/:id/approval-policy`（`src/routes/bots-policy.mjs`，鉴权守卫内）。查询失败/缺字段一律回落 ask。
- **语义**：auto 写入与人审相同的持久 memo，崩溃恢复不重问；既有人工拒绝 memo 优先于后切的 auto；切回 ask 后已 memo true 的不重问（与人审一致）。

## 接线

| Devin 槽位 | 真实数据 |
|---|---|
| PermissionSelect | ask「询问 · 危险操作需审批」/ auto「自动批准 · 危险操作不再停车」→ PATCH → 合并回 bots 列表 |
| ContextStrip | 会话 cwd（Folder 图标 + title 全路径）、云沙箱（`Sprite 就绪 · <runtimeId>` / 状态异常时显示状态）、分支（有则显示） |
| 模型 | 静态 SelectPill（两字母徽章 + title 完整 id）；无切换 API，有意不做 |
| StatusIndicator | busy 时旋转环 |
| SendButton | idle=Send（Enter 发送）；busy=Steer + Abort + Queue follow-up + `N queued` |

DOM 契约全部保留：`#composer-input`、两个 placeholder、Send/Steer/Abort/Queue 可访问名、Enter 提示、IME 守卫、200px 自动增高。

## 验证

- 后端 `TARSBOT_NO_DOTENV=1 npm test`：**594 pass / 1 skip**（新增 8 例 auto/memo/持久化/路由/守卫）。
- 前端：vitest **235/235**、tsc 0 错、build 成功。
- EGO 全流程（截图 01–04）：
  - `01-composer-idle.png` idle 态：询问 pill、sw 徽章、Enter 提示、cwd + Sprite 就绪上下文条、Idle 状态行。
  - `02-permission-menu.png` 权限菜单展开：两模式 + 描述 + 当前项勾选。
  - `03-permission-auto.png` 切到自动批准后 pill 更新；**刷新后仍为自动批准（持久化）**；再切回询问。
  - `04-composer-busy.png` 真实发送一条消息进入 busy：placeholder 变 steer 提示、Steer/Abort/Queue 出现、运行指示器旋转；随后 abort 恢复 idle。

结论：**PASS**。

## 追加：全局排版打磨（05/06）

面板 tab 条改 `no-scrollbar` 横滚（Environment 不再截断、无可见滚动条，11 个 tab 全显）；composer 上下文条与输入卡对齐（图标统一 3.5 号盒、cwd title 全路径）；首页三个 section 节奏统一（space-y-2）；PR 卡第二行右对齐 Review 按钮；侧栏行 12px + title 提示；Dialog 表单 Label 统一 `mb-1.5 block`；七个面板空态统一到 Empty/EmptyDescription 基准。验证：235/235、tsc 0、build ok；EGO 复验见 05-panel-tabs-polish.png、06-overview-polish.png。

## 追加：Composer token 用量统计（07-usage-pill.png）

工具条右侧新增 `ComposerUsagePill`（`usage?: Usage` prop，App 传 `vm.usage` 流式数据）：等宽字体 pill 显示本会话累计 `N tok · $cost`，悬停 title 与 aria-label 给出输入/输出/缓存读/缓存写/费用明细。实测：回合前 `0 tok · $0`，真实发送一条最短消息并完成后实时跳到 `4.0k tok · $0`（输入 3.9k · 输出 68）。235/235、tsc 0、build ok。
