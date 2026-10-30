# SPIKE-add-session：工作区菜单手动添加 Session

用户在 issue-loop Demo 通过后追加的独立小任务，仍在 `spike/issue-loop`，不提交、不推送、不合并。Fast Demo：只做正常路径，不加异常兜底、重试、补偿或通用框架。

## 交互与行为

- 左侧工作区大条目右边有独立的「⋯」按钮，点开显示「添加 Session」。不要把按钮嵌进按钮。
- 点击「添加 Session」，在页面内看到简单的名称输入框和确认按钮。名称可默认「新 Session」，支持中文。不要用原生 prompt。
- 确认后按钮显示创建中，成功自动选中该工作区和新 Session，左侧立即可见。
- 新建全新空白 conversation：无 issue、无自动用户消息、不继承聊天。创建时不调用模型。
- 复用该空间同一 Sprite，新建唯一 detached worktree，检出仓库默认分支当时的 SHA。真实 cwd 指向独立目录。不新建功能分支，不改变原目录。
- 头部和 Environment 显示该 Session 自己的 detached SHA、目录。旧空间级 PR、checkpoint、rebuild 不可用于该 Session。
- 使用已有聊天发送第一条消息，Agent 能在自己的目录执行 bash。
- 这次只添加 Session，不给手动 Session 加发布入口，不伪造 issue 编号或 fork 关系。保留已有 issue-loop 的发布功能不变。

## 最小实现

先读 AGENTS.md 与现有 issue-loop 代码。可在现有工作区路由新增 `POST /api/workspaces/:id/sessions {name}`，直接复用 GitHub getRepo/getBranch、shellQuote、sh、Preamble remove、SPIKE_RULES、createBot 和 control.links。

手动 Session 只加一份小的可选工作树元数据到现有记录，例如 `worktree: {baseBranch,pinnedSha,dir}`。不要重构已有 issueLoop 元数据或全工作区系统。新目录用随机 id，支持重复添加。名称保留中文，重复名可追加短 id。

本次远端只操作已存在测试空间 `ws_e168e5f97244a35b` / Sprite `pca-eae56f671c` / 仓库 `hifizz/tars-sandbox-playground`。实验路由仍限制测试仓库，不提供其他仓库的假成功入口。不创建或删除 Sprite，不读 .env 或输出密钥，鉴权和审批不改。

## 文件边界

可修改现有：`src/routes/workspaces.mjs`、`src/bots.mjs`、`web/src/App.tsx`、`web/src/components/BotList.tsx`、`web/src/lib/workspaces.ts`、`web/src/types.ts`、`web/src/shell/SessionHeader.tsx`、`web/src/components/EnvironmentPane.tsx`、`test/issue-loop.test.mjs`、`web/test/issue-loop.test.tsx`。可读其他文件。不另拆产品模块。

worker 不启动服务、不做 EGO、不进行远端操作、不提交、不改 SPIKE 和旧验收记录。报告给父级，由父级验收并写 `docs/acceptance/add-session/`。

## 验证与停止

最少一个后端正常路径测试：创建 fresh conversation + 新 cwd + 关联同空间 + 不 submit；菜单正常交互测试。运行后端全量、前端全量、typecheck、build。不要扩展异常用例矩阵。

父级 EGO 操作「⋯ → 添加 Session → 输入名称 → 创建 → 发送 pwd/Git 检查」，核实空白历史、独立目录、同 runtime 和正确 SHA，保存截图。正常路径通过即停，不整理代码。
