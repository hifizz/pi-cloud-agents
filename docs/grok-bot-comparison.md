# Grok Bot 与 pi-cloud-agents 概念对照

> 参考来源：`docs.x.ai/grok-bot/` 官方文档（2026-10-07 版本，读了 overview、bots、chat-and-collaboration、skills-routines-and-automations、computer-and-apps 五页；审批、安全、团队与 X 集成部分未覆盖）。

## 1. 本项目核心概念

```
Session（alice.sqlite，全局唯一）
 ├─ Bot "tars"      = 1 个 ownerless Conversation + agent 配置（模型、instructions、tools）
 ├─ Bot "foo"       = 另一个 Conversation
 ├─ Bot "foo-fork"  = 从 foo 某条 entry fork 出来的 Conversation（继承历史）
 └─ Session doc     = tarsbot.routines（跨 Bot 的 routine 列表）
```

| 概念 | 谁定义的 | 存在哪 | 是什么 |
|---|---|---|---|
| Session | pi-durable | `data/alice.sqlite` | Harness 打开的整个持久库，全应用只有 1 个 |
| Conversation | pi-durable | sqlite | 一条持久对话：entries、inbox、agent 配置 |
| Bot | 本项目（`src/bots.mjs`） | `bots.json` | 对 Conversation 的命名和索引；Bot 与 Conversation 严格 1:1 |
| Fork | pi-durable `conv.fork` | sqlite + `bots.json` | 从某条 entry 分出的新 Conversation，同时登记为新 Bot |
| Task | pi-durable | sqlite | 持久任务：工具调用、routine 循环等 |
| Routine | 本项目（`src/ext/routines.mjs`） | sqlite session doc + `routine.tick` Task | 定时向指定 Bot 提交一条 prompt |
| Approval | 本项目（`src/ext/approval.mjs`） | 等待队列在内存，verdict 存 task memo | 危险工具调用的人工审批 |

## 2. Grok Bot 的 Bot 概念

文档原文："A Bot is a durable AI teammate with a name, a job, its own conversation, and working context that develops over time."

即：Bot = 有名字、有职责、有自己对话、上下文持续积累的持久 AI 同事。与本项目的模型高度一致。

## 3. 一致的地方

| | Grok Bot | pi-cloud-agents |
|---|---|---|
| Bot 与对话 | 每个 Bot 一条自己的对话 | Bot 与 Conversation 严格 1:1 |
| 持久性 | 关掉电脑也继续跑，routine 照常 | 服务端常驻，重启后 `harness.resume()` 恢复 |
| 共享电脑 | 同一账号所有 Bot 共用一台云电脑（文件、登录态、凭证共享；"屏幕"之间不是安全边界） | 所有 Bot 共用一个 Sprite，同样无隔离 |
| Routine | 属于某个 Bot，按计划触发 | 挂在 Bot 的 Conversation 上，到点发 prompt |
| 危险操作 | 需要审批 | `approval` 扩展（git/gh 规则） |
| 忙时发消息 | 新消息可改变当前这一轮 | 默认 `followUp` 排队不打断；abort 单独操作 |

## 4. 差异

| | Grok Bot | pi-cloud-agents |
|---|---|---|
| Bot 的设定 | 名字、标签、描述、头像；描述写长期规则 | `name` + `instructions`，无头像/标签 |
| 记忆 | 偏好、事实、历史摘要，按 Bot 独立 | 仅整条对话历史 + compaction 摘要，无独立记忆层 |
| Skill（可复用做法） | 有；所有 Bot 共用一个库，可从任务保存、`/` 调用、录屏示范 | 无 |
| 创建 routine | Bot 自己可以创建（在对话里说） | 只能走 `POST /api/routines`，Bot 没有该工具 |
| 触发方式 | 定时 + Slack/GitHub 等事件触发 | 仅定时 |
| Bot 间协作 | 互发消息、交接任务、2–6 个 Bot 的群聊 | 无；只能通过共享文件间接传递 |
| 复制与分享 | 复制（不带历史）、分享模板、Marketplace | 仅 fork（带历史，可选只读） |
| 删除/隐藏 | 可隐藏；删除连带删除 routine | 仅登记与 fork，无隐藏/删除 |
| 电脑 | 带浏览器与桌面的云电脑，可接管登录/验证码 | 仅 shell + 文件工具，无图形环境 |
| 连接器 | 有（Slack、邮件等），账号级 | 无；只有 `web_search` 和 git/gh |
| 用户 | 个人、团队、企业，有 Team Bot | 单用户，白名单邮箱 |
| Routine 限额 | 每 Bot ≤50 个，调度间隔 ≥5 分钟 | 间隔 ≥1 秒，无数量上限 |
| 语音/草稿/移动端 | 有 | 无 |

## 5. 对本项目的参考（按优先级）

1. **让 Bot 自己能创建 routine**：加一个工具即可，补上"Bot 没有 schedule 工具"的缺口。
2. **Bot 之间互发消息**：文档的做法是接收方被唤醒、处理、之后可回复。Conversation `submit` 已能实现，缺一个工具。
3. **Skill**：最小做法是在 Sprite 里放 markdown 文件，让 preamble 告诉 Bot 去读。
4. **Routine 限额**：加最小间隔与数量上限，避免 Bot 自建 routine 后失控。
5. 浏览器/桌面操作与连接器：工作量大，暂不建议。

## 6. 与 Cloudflare DO 方案的关系

Grok Bot 用"一个账号一台电脑 + 多个 Bot"的模型，与本项目相同。说明按用户拆成一个 session 是合理边界；Earendil 的 pi-durable-on-cloudflare 示例里"1 个 DO = 1 个 session，里面多个 conversation"正好对应本项目的整体形态。
