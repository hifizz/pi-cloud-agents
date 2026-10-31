# AMP13-collaboration 跨设备团队协作入口

在既有白名单共享信任模型下实现 Session 深链接 ?bot=<id>，复制链接、刷新和另一已登录页面可继续同一会话；未登录先登录后保留目标；不存在ID明确错误。窄屏（390px）能展开/收起工作区、选Session、发消息、开panel，无横向溢出遮挡关键动作。显式开启浏览器通知（权限拒绝可见，busy->idle只在真实transition通知，不把初次加载已idle当完成），清楚不是后台push。分享仅已白名单认证成员，无公开匿名链接、不做虚构角色ACL。先检查共享数据模型，不新增成员表/OAuth provider；不能声称完成原生客户端或多租户团队权限。
允许：web/src/App.tsx、web/src/shell/WorkspaceShell.tsx、web/src/shell/SessionHeader.tsx、web/src/shell/rail/*、web/test/collaboration.test.tsx。可新增 web/src/hooks/useSessionLink.ts 与 useSessionNotifications.ts。不得修改 PanelHost/index（父级负责）。

## 共同契约
用户要求逐功能一个 SWE-2 high worker，实现能本地操作的真实功能；父级负责集成、真实 EGO 用户验收。你只负责本任务。基线 774f73d。先读 AGENTS.md、docs/tasks/AMP13-PLAN.md、相关源文件和 node_modules 的权威 API 类型，先在报告说明数据结构/调用路径，再做最小实现。
只改下面列出的文件；不要修改 api.mjs、server.mjs、runtime.mjs、panels/index.ts、依赖锁文件，若需要这些接入，在报告给出最小集成片段，由父级负责。你可以新增指定 route/panel/test（不要构建通用框架）。UI panel 使用 PanelContext，自身通过 bot/workspace 查询数据。路由自动加载 register(app)，鉴权走既有 guard，所有输入边界验证、返回错误不带 secrets。
创建的 panel export 命名见各任务。不要通过 postMessage/全局事件引入隐藏耦合。有跳转需求使用 URL ?bot=<id> 链接（由协作任务统一支持），不要修改 App。
当前会话 cwd 必须由服务器根据已存在 bot 的 issueLoop.dir/review.dir/worktree.dir 或 workspace.cwd 决定，不相信客户端路径绑定。先验证 bot 会话确实关联此工作区、ready、active binding，使用 runtimeBash(workspaceId)，无宿主 bash 或默认 Sprite fallback。路径/文件访问留在 env.mjs 或特定允许的 env helper；不读 .env、.git 凭据等，不允许 symlink 越界。
无凭据日志、无真实远端访问、无浏览器、无 npm start、无常驻服务、无端口 8090/5183、无 git commit/push/reset/stash、无 data 删除、无递归子代理。依赖软链接只读不 npm install。单元测试使用临时目录、faux provider；不要改共享 node_modules/web/dist，build 用临时 outDir。不得主动修改外部 GitHub/Sprite。
测试：自己的后端 node --test 和前端 vitest（TARSBOT_NO_DOTENV=1），前端 npm run typecheck；新组件尚未注册由父级接入，并需直接 render 测试。完整套件父级统一跑。完成输出 PASS/ISSUES/BLOCKED、改动文件、命令与真实测试结果、集成片段、UI路径、未验证项。不把纯文本输出叫交互终端，不把 mock 叫真实外部集成。遇到无法安全实现的入口先报告，不降级成静默假成功。
