# M1-01：控制库（projects / workspaces / bindings / links / intents / checkpoints）

依赖：无。

先读：`docs/M1-PLAN.md` §3、§4.1；`src/auth.mjs`（`node:sqlite` 的现有用法）；`src/config.mjs`；`test/auth.test.mjs`（临时库测试写法）。

## 你只能创建/修改
- `src/control/db.mjs`（打开库、迁移）、`src/control/store.mjs`（对外 API）
- `test/control-store.test.mjs`

## 要求
1. 按 `docs/M1-PLAN.md` §4.1 实现 `openControlStore({ path })`，签名和字段名不得改。`path: null` 用内存库。
2. 表：`projects`、`workspaces`、`workspace_steps`、`runtime_bindings`、`conversation_links`、`intents`、`checkpoints`、`meta`、`executions`、`requests`。迁移用 `PRAGMA user_version`，迁移函数数组、事务内执行、可重复打开。
3. 约束写进 schema，不只靠代码：
   - `workspaces.request_id` 唯一；`create` 对同一 `requestId` 返回原记录（`created: false`），不报唯一约束错。
   - 每个工作区至多一个 `active` 绑定（部分唯一索引）；`bind` 在一个事务里把旧的置为 `replaced`、`version` 加一。
   - `conversation_links.conversation_id` 唯一；`link` 对同一会话重复调用幂等，对不同工作区报错。
   - `intents.request_id` 唯一；`begin` 返回 `{intent, created}`，已存在则 `created: false` 且不改状态。
   - `executions.run_id` 唯一；`claim` 返回 `{execution, created}`，已存在则 `created: false` 且不改状态。状态集合 `claimed | started | exited | lost | unknown`，用 CHECK 约束。
   - `requests (scope, request_id)` 唯一；`begin({scope, requestId, payloadHash})`：首次写入返回 `{created:true, conflict:false}`；同 payloadHash 再来返回 `{created:false, conflict:false}`；**payloadHash 不同返回 `{created:false, conflict:true}`，且不覆盖原记录**。
   - `meta`：`ensure(key, makeValue)` 首次调用写入 `makeValue()` 并返回，之后一律返回已有值（同一事务内完成，不会被覆盖）。库创建时由调用方 `ensure("namespace", randomId)`、`ensure("generation", () => 1)`；本任务提供 `bumpGeneration()`（从备份恢复到新部署时用），每次加一。
4. 时间用 ISO 字符串；JSON 字段（`model`、`evidence`）读写时序列化，读出来是对象。
5. 写操作都是同步事务，单进程单写者（沿用 AGENTS.md 的存储规则）。库文件目录不存在时自动创建。
6. 不读任何环境变量、不 import `config.mjs`（路径由调用方传入），保持可单测。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0；本任务本身不依赖它，但全量测试依赖）。
- 测试覆盖：重复 `create`（同 requestId）、并发式连续两次 `bind` 后版本为 1、2 且只有一个 active、`link` 幂等与冲突、`intents.begin` 重复、`executions.claim` 重复与状态 CHECK、`requests.begin` 的三种结果（新建 / 同内容 / 冲突）且冲突不覆盖原记录、`meta.ensure` 重开后读到同一个值、`bumpGeneration`、关闭后用同一文件重新打开数据仍在、迁移可重复运行（打开两次不报错）、`checkpoints` 增删与 pinned。

最后输出：改动文件、表结构摘要、测试结果、与 `docs/M1-PLAN.md` §4.1 不一致的地方（有则列出，不要自行改契约）。
