# Cloud / C3-web：前端去桌面 + 登录页

依赖：契约 `docs/CLOUD-PLAN.md` §4.3、§4.5（后端由 C2 并行实现，按契约开发，测试用 mock）。

先读：`docs/CLOUD-PLAN.md` §4、§7；`web/src/App.tsx`、`web/src/main.tsx`、`web/src/lib/api.ts`、`web/src/lib/stream.ts`、`web/src/lib/approvals.ts`、`web/src/types.ts`、`web/src/components/DesktopPane.tsx`、`web/src/components/Chat/tools/registry.ts`、`web/src/components/Chat/tools/builtin/desktop.tsx`、`web/src/gallery/main.tsx`、`web/test/*`、`web/package.json`、`web/vite.config.ts`。

## 你只能创建/修改/删除

- `web/` 下的任何文件（不得新增 npm 依赖；不得改 `web/package.json` 的依赖版本）
- 失败时 `docs/fail-C3-web.md`

**不要碰** `web/` 以外的任何文件。

## 要求

1. 去桌面：
   - 删除 `components/DesktopPane.tsx`、`components/Chat/tools/builtin/desktop.tsx`，`registry.ts` 移除 `desktopTools`。
   - 右栏换成一个精简的 `EnvironmentPane.tsx`：调用 `api.space()`，显示 "执行环境：Sprite `<name>`" 与工作目录 `/home/sprite/workspace`；不渲染 iframe。`SpaceInfo` 类型收窄为 `{ sandbox: "sprites"; name: string | null }`。
   - `gallery/main.tsx` 中 `desktop_*` 示例与 `/home/cua` 路径改为 sprites 场景（如 `bash`、`/home/sprite/workspace/...`）。
   - 修复受影响的测试：`chat-library.test.tsx`（`desktop_click` 标题断言换成其他内置工具）、`components.test.tsx`（`desktop_screenshot` 图片用例换成其他工具名或删除图片部分）、`features.test.tsx`（approval 数据里的工具名换成 `bash`）；fixtures 中若有 desktop 工具可保留（只是数据），但测试不能依赖已删除的渲染器。
2. 登录（契约 §4.5）：
   - `lib/api.ts`：新增 `auth.me()`、`auth.login(email, password)`、`auth.logout()`、`googleLoginUrl = "/api/auth/google"`；`request()` 收到 401 时调用一个可订阅的 `onUnauthorized` 回调（或派发事件），并照常抛 `ApiError`。
   - 新增 `components/LoginPage.tsx`：标题 "pi-cloud-agents"；"使用 Google 登录"按钮（`<a href>` 跳转）；邮箱 + 密码表单（`type="email"` / `type="password"`，`autocomplete` 属性正确，有 `<label>`，回车提交，提交中禁用按钮）；错误提示用 `role="alert"`；处理 `?auth_error=denied|state|exchange` 并 `history.replaceState` 清参数。无注册入口。
   - `main.tsx` 或新建 `AuthGate.tsx`：启动时 `auth.me()`；加载中显示简洁占位；401 → `LoginPage`；成功 → `App`，传入 `email`。收到 `onUnauthorized` → 回到登录页。`useBotStream` / `useApprovals` 只在已登录时挂载（App 卸载即停止 WS 重连）。
   - `App.tsx` 顶栏右侧显示当前 email 与 "退出" 按钮（调用 `auth.logout()` 后回登录页）。
   - 页面 `<title>` 改为 `pi-cloud-agents`；不要修改代码里其他 "TARSBot" 字样（D5）。
3. `vite.config.ts` 的 `/api` 代理（含 ws）保持指向 `127.0.0.1:8090`；Vite dev 下 cookie 同源可用。
4. 可访问性：表单控件有关联 label，按钮可键盘操作，焦点可见，错误信息可被读屏读到。

## 验收

- `cd web && npm test && npm run typecheck && npm run build` 全部通过。
- 新增测试至少覆盖：`me()` 401 → 渲染登录页；登录成功 → 渲染主界面；`auth_error=denied` 文案；任一请求 401 → 回到登录页；退出按钮调用 logout。
- `grep -rn -i "desktop\|cua\|viewerUrl" web/src` 无结果（CSS 中与桌面无关的词除外，汇报中说明）。
- 不运行 dev server、不做浏览器验收（C7 统一做）。

最后输出：改动/删除文件、测试与构建结果、与契约的任何偏差、未验证项。
