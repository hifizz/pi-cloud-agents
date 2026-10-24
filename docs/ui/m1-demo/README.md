# M1 工作区界面原型

组件化的静态原型：零依赖，原生 ES modules + 纯函数组件 + 事件委托。仅用本地演示数据，不调用任何后端、GitHub 或 Sprite。

## 视觉计划

沿用现有主页面：surface `#0a0a0a`、rail `#030303`、raised `#141414`、line `#1f1f1f`、fg `#ededed`、accent `#4b8dff`，系统中文无衬线 + SFMono。三栏：rail 272px | 对话 | 右面板 `clamp(420px,38vw,560px)`（现有产品是 `min(560px,45vw)`，在 1280 宽度下把对话挤到不足 480px，原型下调了比例）。
相对现有页面的调整：rail 以“项目 → 工作区 → 会话”组织；头部区分环境状态（Sprite）与任务状态（会话条）；右面板改为 改动/文件/终端/环境。

## 已在浏览器验证（2026-10-25）

| 项目 | 结果 |
|---|---|
| 1280 / 1440 宽度 | 无横向溢出；输入框工具栏不被截断（对话栏窄于 520px 时隐藏快捷键提示） |
| 390 宽度 | 侧栏、右面板默认收起，为浮层，同一时间只开一个，点遮罩关闭；面板标签页可横向滚动，关闭按钮吸附在右侧 |
| 停止流程 | 先显示“停止待确认”，点“模拟收到停止确认”后才变“已停止” |
| 审批 | 批准 / 拒绝分别更新状态与提示 |
| 待验收 | 追加需求后旧测试变为“需要重新验证”，创建示例 PR 被拦住；无真实 PR 链接 |
| 新建工作区 | 空值与非法分支名被拒绝；提交后在左栏出现，初始化五步可推进，完成前输入框禁用 |
| 键盘 | 用真实按键验证：Enter 打开对话框、焦点进入对话框、Tab 不跳出、Esc 关闭并回到触发按钮 |

截图在 `screens/`（桌面 1440、窄屏面板与侧栏）。

**未验证**：触屏手势、屏幕阅读器朗读效果。`demo.html` 以 `file://` 直接打开已验证可渲染、场景切换可用（与 `index.html` 同一份源码）。

## 组件树与现有产品组件对照

| 原型组件（`components/`） | 现有产品对应 |
|---|---|
| `layout.mjs` Layout | `shell/WorkspaceShell.tsx` |
| `sidebar.mjs` Sidebar | `BotList.tsx` + rail |
| `header.mjs` PrototypeBar / Header | 会话头（`App.tsx`）；PrototypeBar 仅原型 |
| `conversation.mjs` Conversation | `Chat/MessageList.tsx`、`FeedRow` |
| `tool-card.mjs` ToolCard / Approval | `Chat/tools/ToolCall.tsx`、`FilesChanged`、`ApprovalBar.tsx` |
| `composer.mjs` Composer | `Chat/Composer.tsx` |
| `panels.mjs` Panels | `panels/*`（diff、environment） |
| `new-workspace-dialog.mjs` | `ForkDialog.tsx` / New bot（新） |
| `shared.mjs` | `Icon.tsx`、令牌；`tokens.css` ← `index.css @theme` |

## M1 与后续能力

- M1：独立 Sprite 环境、初始化五步、会话改动、环境绑定、手动检查点、PR 创建（原型为模拟）、审批。
- 后续（界面均有标注）：真实 Git 改动（M2）、第二会话与写锁（M2）、终端接管（M2）、预览与交付卡/测试证据（M3，“待验收”场景）。

## 使用

```bash
node build.mjs          # 生成自包含 demo.html（源码唯一：components/ + app.mjs + styles.css）
node dev-server.mjs     # http://127.0.0.1:5197/ （index.html，开发用）
```

`demo.html` 可直接双击打开。`build.mjs` 只剥离 import/export 并按依赖顺序拼接，所有模块共享一个脚本作用域，新增顶层名称需避免重名。
