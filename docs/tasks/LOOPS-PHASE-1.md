# Issue 14 Phase 1 worker 任务书

## 用户目标与权限
用户明确授权从 Issue #14 的调研/设计进入实现，并要求一个子代理开发、父级测试及 EGO 用户验收。你是唯一 Loops worker，模型 magpie/devin/swe-2，thinking high。独占 /Users/zilin/side/pi-cloud-agents-loops，基线 774f73d，阶段分支 feat/loops-phase-1，PR base feat/loops（同样从774f73d创建）。不与 Issue13 合并或依赖其未提交代码。

先完整读 AGENTS.md 和 docs/tasks/LOOPS-ISSUE-14.md。Issue14 顶部“仅调研”已被用户当前实现授权更新。按 Phase1 -> 父级验收 -> Phase2 -> 父级验收 -> Phase3 顺序执行。本次只实现 Phase1，完成后停下报告；不要把全部阶段大改塞进一次交付。

## Phase1 边界
完整实现 Issue14 §5.7 Phase1 和 §6 Phase1 的手动/定时/通用Webhook、持久loop定义/版本、FIFO队列、Session/worktree、UI与离线测试。不可用内存queue冒充持久化；不可把单测mock称作现场验收。Loops是新要求，不受之前 Fast Demo 无DB扩展限制，遵从本Issue明确数据模型与恢复语义。不实现Phase2 GitHub事件/真实GitHub写工具或Phase3模板/草稿/计费，但结构不能提前允许未实现权限。保留原routine行为。读写能力需真实约束，不只写prompt；未开放的工具和路径不得可调用。不得以无merge工具为由忽视bash可merge的风险。

## 可改文件
- src/control/db.mjs、src/control/store.mjs（迁移与存储接口，不破坏既有数据）
- src/loops/*.mjs（本阶段需要的 store/queue/runner/schedule等）
- src/routes/loops.mjs
- src/routes/auth.mjs（仅下面的严格机器认证集成，不放开普通API）
- src/api.mjs（仅增加真实所需 PATCH/DELETE 注册与受限raw-body能力，禁止业务逻辑进入router）
- src/runtime.mjs（唯一运行时集成点）、src/server.mjs（最小装配/生命周期，不放业务逻辑）
- src/bots.mjs（loopRun元数据和必要能力配置）
- src/config.mjs、src/ext/routines.mjs、src/ext/approval.mjs（必要集成，原有行为不变）
- src/routes/workspaces.mjs（必要复用context组装，保持原API与task-only发布语义）
- web/src/types.ts、web/src/lib/loops.ts、web/src/components/LoopsList.tsx、LoopEditor.tsx、LoopRuns.tsx、BotList.tsx、web/src/shell/SessionHeader.tsx、web/src/App.tsx
- test/loops-*.test.mjs、web/test/loops.test.tsx、必要更新现有受接口影响测试（不得删弱断言）
- docs/tasks/LOOPS-PHASE-1-NOTES.md（架构/运行方法/未验证清单）
其他文件需先在报告说明，不擅自改。依赖只读软链接，不安装/改共享node_modules或web/dist。可 build --outDir /tmp/<unique>。

## 鉴权与安全硬约束
所有API/WS仍经全局guard。通用Webhook是独立机器凭据认证，不是匿名豁免。必须在guard内调用真正的签名/Bearer校验，只允许精确method/path，失败401，普通API仍要求登录/Origin。不要添加startsWith('/api/loops')免登录。公网Webhook只接受有大小限制的原始body，签名验证在解析/副作用之前，常量时间比较、时间窗、去重、限速。若现有guard接口不足，最小扩展并补集成测试，不绕过它。GitHub webhook留到Phase2。
Standard Webhooks HMAC需要原始密钥，不能从不可逆hash验证；用服务端环境变量提供HMAC材料，Bearer仅存hash；轮换语义需真实成立。不要声称单存hash即可HMAC。密钥不得放Session/日志/Sprite/版本snapshot。返回一次明文的rotate UI不得持久存localStorage/URL。缺配置显式503，不生成不持久的假可用配置。
code none/read/readwrite、web及工具权限必须通过工具白名单/执行边界实施，禁用code不等于只写prompt。共享Sprite不是强隔离，明确限制。运行本身不允许自动merge。审批扩展保持有效，绝不移除绕过审批。readwrite Phase1只验证独立branch，不现场push/PR。
恢复需要实际使用 durable API类型验证。数据库只能server单写，临时测试DB与data隔离；禁用loop不可enqueue；排队顺序/并发计数/取消与starting竞态覆盖。重启恢复不重复创建bot/worktree，不把needs_approval当完成释放槽。异常输出需脱敏。

## 执行顺序与报告
先在 NOTES 写出数据模型、生命周期/恢复状态转换、鉴权接缝和每个风险的测试办法；再分可验证小步实现。运行完整后端 TARSBOT_NO_DOTENV=1 npm test、web npm test、typecheck、build到独立临时outDir。测试用内存/临时存储、fauxProvider/假时钟，不调用模型/Sprite/GitHub。
不能启动npm start/Vite或常驻服务，不能占8090/5183，不能操作远端、不能读.env、不能打印凭据、不能commit/push/merge、不能删data/创建或删Sprite、不能派其他代理。父级负责真实服务和浏览器。
最终报告必须列出真实测试结果、改动文件、父级启动配置、迁移/恢复注意点、用户点击步骤、每条Issue验收条件对应证据、未完成/不可验项。遇到无法满足的安全/协议条件明确BLOCKED，不以降级隐藏。不做无关美化。
