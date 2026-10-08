# Batch 1 / Task 7：网络搜索工具（Exa）

先读：`docs/CONTRACTS.md`、`docs/PLAN.md` Task 7。实现前用 web 搜索/抓取查证 Exa Search API 当前字段（`https://docs.exa.ai`，`POST https://api.exa.ai/search`，header `x-api-key`）。

## 你只能创建/修改这些文件
- `src/ext/search.mjs`
- `test/search.test.mjs`（离线，mock fetch）
- `scratch/search-demo.mjs`
- 失败时：`docs/fail-search.md`

## 要求
- 导出 `Search = defineExtension({ name: "tarsbot.search", tools: [webSearch] })` 和 `createWebSearchTool({ fetch?, apiKey?, timeoutMs? })`（依赖注入；默认 `globalThis.fetch`、`process.env.EXA_API_KEY`、15000ms）。
- 工具 `web_search {query: string, numResults?: 1..10 (默认5), includeText?: boolean (默认 true)}`，`replay: "safe"`。
- 请求体：`{query, numResults, type:"auto", contents:{ text:{ maxCharacters: 1500 } }}`（按官方文档校正）。
- 结果 text：编号列表 `title / url / publishedDate? / 摘要(截断)`；`details` 放结构化结果数组 `{title,url,publishedDate}`（不含长文本）。
- 无 key → 抛 Error("EXA_API_KEY is not set")；非 2xx → 抛 Error 含状态码与简短 body（不含 key）；超时用 AbortSignal.timeout → 抛 Error("web_search timed out")。
- **绝不**在任何输出、错误、日志中包含 API key。

## 验收
- `npm test` 全绿（成功、401、超时、无 key、numResults 边界）。
- `node scratch/search-demo.mjs "Node.js current LTS version"`：真实调用一次，打印前 3 条标题与 URL（不打印 key）。

最后输出：改动文件、测试结果、demo 输出摘要、未验证项。
