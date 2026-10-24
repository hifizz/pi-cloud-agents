# M1-02：薄 GitHub 客户端（`GITHUB_TOKEN`）

依赖：无（`ensurePull` 用到的 `intents` 是传入的对象，测试里用桩）。

先读：`docs/M1-PLAN.md` §3.4、§4.2；`src/ext/approval.mjs` 里 GitHub 相关规则（了解什么操作需要审批，本模块不得绕过）。参考思路（只读，不要复制代码，也不要引入它）：`/Users/zilin/side/thread-chatbot/feat-cloud-work/lib/github/pull-requests-write.ts` 的「按 head 分支找回 PR」。

## 你只能创建/修改
- `src/github.mjs`
- `test/github.test.mjs`

## 要求
1. 按 `docs/M1-PLAN.md` §4.2 实现 `createGithubClient`，只用全局 `fetch`，不加依赖。`token` 缺失时构造不报错，调用时抛 `GithubError{code:"unauthorized"}`。
2. 方法：`listRepos`、`listBranches`、`getBranch`、`findPullByHead`、`createPull`、`ensurePull`。分页最多取到 `limit`（默认 100 个仓库、300 个分支）。
3. `findPullByHead(repo, branch)`：`GET /repos/{repo}/pulls?head={owner}:{branch}&state=all`，有 open 的优先返回；已合并的 `merged: true`。
4. `ensurePull`：`intents.begin({requestId, kind:"github.pr", target:`${repo}#${head}`})` → 先 `findPullByHead` → 没有再 `createPull`（把意图置为 `sent`）→ **`createPull` 抛任何网络错误、超时、5xx 后都再 `findPullByHead` 核对一次**：找到就当成功，找不到才把错误抛出并把意图置为 `unknown`。成功则 `settle(confirmed, {number, url})`。已存在则 `created: false`。**绝不把超时直接当失败后重建。**
5. 如果找到的 PR 已 `closed` 或 `merged`，`ensurePull` 不新建、不复用，抛 `GithubError{code:"conflict"}`，消息说明需要新分支或新工作（对应需求 AC09.4）。
6. 脱敏：错误消息、返回值、日志里不得出现 token 值；用 `fetch` 抛出的原始错误时也要过滤。HTTP 401/403 → `unauthorized`/`rate_limited`（看 `x-ratelimit-remaining`），404 → `not_found`，422 且消息含 "already exists" → `conflict`。
7. 请求头带 `User-Agent` 与 `X-GitHub-Api-Version`。`apiBase` 默认 `https://api.github.com`，可注入以便测试。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0；本任务本身不依赖它），测试全部用注入的假 `fetch`，不联网。
- 必测：正常创建；创建后响应丢失（假 fetch 先让服务端「生效」再抛网络错）→ `ensurePull` 找回同一个 PR；这个场景在「POST 之前失败」「POST 之后失败」两个窗口各重复 10 次，PR 始终只有 1 个；已合并 PR 的 `conflict`；token 不出现在任何错误文本（用一个特征字符串做断言）；分页。
- 不做联网验收（编排者在 M1-14 对测试仓库做）。

最后输出：改动文件、测试结果、未验证项。
