# 工作区 URL 与选中态验收

## 行为

点击左侧工作区进入 `/?workspace=<workspaceId>` 总览。直接访问和刷新时，URL 优先于本地记忆，左侧回显该工作区选中态。会话仍使用 `?bot=<botId>`；两种导航相互清除对方参数。无效工作区显示错误、保留 URL，不静默选择其他工作区。登录鉴权不变。

## 自动化：PASS

- `TARSBOT_NO_DOTENV=1 npm test`：587 项，586 通过、1 跳过、0 失败。
- `cd web && npm test`：235 项通过。
- `cd web && npm run typecheck && npm run build`：通过；既有 bundle-size warning 保留。
- `git diff --check`：通过。
- 新增测试位于 `web/test/collaboration.test.tsx`：URL 优先于 localStorage、重新挂载恢复总览、两工作区点击/前进/后退、无效 ID 及点击恢复。既有 Session 链接测试通过。

## EGO 浏览器：PASS

使用当前源码 Vite `http://127.0.0.1:5183`，代理已有带鉴权 Demo 后端 `8091`。未修改 8090 服务配置、未新建资源、未运行 Agent 或终端命令。

1. 点击 Environment demo，URL 为 `?workspace=ws_35106a21bcaf916f`。
2. 点击 pi-cloud-agents 工作区，URL 为 `?workspace=ws_f162a8f972142c5a`，左侧对应项高亮。
3. 浏览器后退和前进，检查 URL 与 `aria-current=true` 对应工作区一致，仍显示总览。
4. 刷新第二个链接，仍显示第二个工作区总览并保持高亮。
5. 直接访问 `?workspace=does-not-exist`，显示“链接中的工作区不存在”，URL 保留，选中项数量为 0。
6. 直接打开第一个工作区 URL，正确回显 Environment demo。

截图：[01-selected.png](01-selected.png)。截图展示工作区总览与选中态；地址栏值通过浏览器读取验证，页面截图不含浏览器地址栏。

未部署；8091 自身仍托管此前构建。当前改动可通过 5183 预览。
