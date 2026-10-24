# M1-08：工作区与 GitHub 路由（含 PR 创建）

依赖：M1-07（服务）；M1-02（`ensurePull`）。

先读：`docs/M1-PLAN.md` §4.8；`src/api.mjs` 头部注释与 `HttpError`、`compilePath`（路由插件约定：`register(app)`，`app.ctx = {harness, bots}`）；`src/routes/fork.mjs`（路由写法与参数校验）；`src/routes/auth.mjs` 的守卫（新路由默认被守卫覆盖，不要新增绕过入口）；`test/api.test.mjs`、`test/fork.test.mjs`（路由测试写法）。

## 你只能创建/修改
- `src/routes/workspaces.mjs`、`src/routes/github.mjs`
- `test/routes-workspaces.test.mjs`
- **不要改** `src/api.mjs`、`src/server.mjs`

## 要求
1. 路由插件取依赖的方式：`app.ctx.workspaces`（工作区服务）、`app.ctx.github`、`app.ctx.control`（控制库）。这些由 M1-13 在 `createApi` 的 `ctx` 里注入；测试里自己构造 `app` 假对象或带这些字段的 `createApi`。**没有注入时路由不注册**（旧部署行为不变），并 `console.warn` 一次。
2. 实现 `docs/M1-PLAN.md` §4.8 中的：`GET /api/github/repos`、`GET /api/github/branches?repo=`、`POST /api/workspaces`、`GET /api/workspaces`、`GET /api/workspaces/:id`、`POST /api/workspaces/:id/retry`、`POST /api/workspaces/:id/pr`。（检查点与重建路由分别在 M1-09、M1-10。）
3. 校验与状态码：body 必须是 JSON 对象；`requestId`、`repo` 必填；`repo` 格式错误 400；工作区不存在 404；`GithubError` 映射（`not_found` 404、`unauthorized` 502 并附「GitHub 凭据不可用」而非 token 信息、`rate_limited` 429、`conflict` 409）；**同一 `requestId` 但内容不同（服务抛 `code: "conflict"`）返回 409，消息说明“请求编号已被不同内容使用”**。`POST /api/workspaces` 成功返回 202。
4. `GET /api/workspaces[/:id]` 返回的 Workspace 附 `steps`、`botId`（来自 `links.conversationsOf` + `bots`）、当前绑定摘要（`provider`、`runtimeId`、`version`、`owner`）。**不返回** token、完整环境变量或内部路径以外的敏感信息。`steps` 里 `unknown` 状态原样返回（界面显示「结果待确认」并提供重试）。
5. `POST /api/workspaces/:id/pr`：工作区必须 `ready`；`head` 取工作区分支，`base` 默认工作区的 `baseBranch`；调用 `github.ensurePull({repo, head, base, title, body}, {intents: control.intents, requestId})`；`title` 缺省用任务或分支名，`body` 末尾加一行 `Opened by TARSBot`；返回 `{pull, created}`。分支尚未推送（GitHub 上不存在 head）时返回 409 并提示先让 Bot `git push`，不要由服务端替它推送。head 对应的 PR 已合并或关闭时 `ensurePull` 抛 `conflict`，返回 409 并提示需要新分支或新工作。
6. 同一 `requestId` 的 `POST .../pr` 重复调用返回同一结果，不重复创建。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0），假服务、假 github，不联网。
- 必测：每条路由的成功与错误；重复 `POST /api/workspaces` 同 `requestId` 同内容返回同一个工作区、**不同内容返回 409**；`POST .../pr` 在「响应丢失」场景下重试得到同一个 PR（FT-M1-2，10 次）；已合并 PR 的 409；未注入依赖时不注册路由；响应中搜不到测试用的假 token 字符串。

最后输出：改动文件、测试结果、未验证项。
