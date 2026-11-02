# 本地逐项验收清单（Issue 13 / Issue 14）

用户要求：逐项验收、通过即勾选，持续推进至所有任务完成。此文件为验收进度真相，worker PASS 不等于父级验收 PASS。

## 环境与规则
- Issue13：`feat/amp13-local-workflow`，PR base `spike/issue-loop`。本地 127.0.0.1:8090，当前EGO space 7 / p1（原space8已不存在，用户授权接管旧应用页）。
- Issue14：独立 `/Users/zilin/side/pi-cloud-agents-loops` / `feat/loops-phase-1`，PR base `feat/loops`。单独验收；不得两进程写相同data。
- 仅现有测试空间 `ws_e168e5f97244a35b` / Sprite `pca-eae56f671c` / `hifizz/tars-sandbox-playground`。
- 保留鉴权、审批。不创建/删除Sprite，不合并或部署。密钥不进入截图或记录。
- [x] 只表示父级已观察对应真实行为并记录证据；mock、计划或未经运行的代码不勾选。

## Issue13 用户验收
- [x] F1 Files：打开Session目录、读取已有文件、上传带空格文件名并回读。`docs/acceptance/amp13/01-files-upload.png`。
- [x] T1 命令控制台：正确worktree、真实输出、非零退出码。`02-console-exit.png`。注意不是PTY。
- [x] T2 控制台取消和拒绝：运行中sleep30取消显示exit143，随后命令exit0；无害printf包含gh pr merge文字被分类器拒绝（未执行破坏性命令）。`11-console-cancel.png`。
- [x] G1 Git工作区：上传文件显示未跟踪，展示真实diff。`03-git-untracked.png`。
- [x] G2 Git提交与分支：查看3157db0 README commit diff，选择main显示无差异（HEAD确为main），只读。`docs/acceptance/amp13/04-git-commit.png`。
- [x] P1 Preview：通过Files上传HTML/CSS/JS，命令控制台启动8765本地服务，iframe导航到HTML、外链CSS/JS加载、点击计数变1。`08-preview-interactive.png`。资源异步加载需等完成。无服务错误仍在P2补查。
- [x] P2 Preview安全：cookieless有效限定cap200，无凭据/错误cap401，响应CSP sandbox+nosniff；直接URL也能运行JS且受同响应策略，8766无服务错误可见。`preview-auth.json`、`17-preview-no-service.png`。cap未写入证据。
- [x] S1 搜索：同空间搜索pr-11-review的hello.txt内容，预览entry241，显式引用发送到issue-12-exec；聊天出现真实引用来源。`docs/acceptance/amp13/05-session-reference.png`。
- [x] D1 委派：UI创建child `7c9a958a`，独立 `task-d080a01a` worktree/branch实际执行只读命令，打开child并回传真实README/HEAD结果。`06-delegation-child.png`、`07-delegation-result.png`。首次网络失败明确保留；结果读取顺序错误已修复重验。
- [x] D2 委派组合：新child d91393ce / task-b1c89377，Files读取README、Git显示子分支干净、PTY pwd分支一致，Header正确。`16-child-git.png`、`15-pty-interactive.png`。旧验收child未补metadata，不作新路径证据。
- [x] E1 事件：开启后sandbox Issue13真实评论6532572536进入feed，UI投递到issue-13-discuss；重复同步0新事件，真实user消息仅1条，验收后停用。`09-event-delivery.png`。当前是手动同步，后台自动轮询仍需补齐。
- [x] E2a 后台同步：启用后未点立即同步，60秒自动摄取真实评论6532987819，pollCount=1；停止按钮成功。`18-autopoll.png`。
- [x] E2b 组合版UI订阅PR15，真实Checks API显示head84c0513 success；重启后自动pollCount=1、订阅和check状态保留、lastError空，停止成功。`docs/acceptance/combined/04-pr-checks-subscription.png`、events-restart.json。
- [x] I1a Skill安装/使用/停用/卸载：UI安装acceptance-greeting，Pi真实load_skill并回复标记；停用后实际toolResult拒绝，卸载记录消失。`14-skill-agent-load.png`。
- [x] I1b Skill重启保留（21），Files在新验收child上传此前不存在的SKILL.md，UI从文件安装（22），新Session dc978ed3真实load_skill回复FILE_SKILL_INSTALLED（23）。不覆盖已有文件。
- [x] I2 MCP安装：UI安装本地真实HTTP MCP；Pi调用add审批前计数0、批准后1，sum42；停用调用拒绝；重启后重新批准sum5。`19-mcp-approval.png`、`20-mcp-result.png`、`21-integrations-restart.png`。只证明此transport工具子集，不宣称OAuth/外部厂商兼容。
- [x] C1 分享：UI复制链接，p2打开child深链接并刷新保持；切到讨论后浏览器back返回child正确。
- [x] C2 窄屏：390px下展开侧栏选讨论Session、输入发送消息；scrollWidth=390，无横向溢出；面板可开关。`10-mobile-message.png`。
- [x] C3 通知权限：用户处理后接管旧space7/p1，真实Notification.permission=granted；显式UI申请和页面通知约束已验证，后台push非本轮功能。
- [x] R1 回归：组合版PR16同SHA重复Review前后15bot不增加；人工结果/状态仍显示；草稿跨Session隔离、task-only首条完整测试通过；现场fresh publish见loops/phase-2/publish.json，新手动Session见23-new-session-skill.png。
- [x] A1 鉴权：实际新HTTP/console WS/PTY WS匿名401见auth-checks.json；敏感路径与跨空间拒绝测试通过，preview有签名范围认证而非匿名放行。
- [x] Q1 最终组合版后端551通过/1既有skip，前端224通过，typecheck/build与diff检查通过。
- [x] Q2 独立审查/tmp/pca-amp13-review.md，MCP工具namespace冲突和HTTP凭据风险已修并回归；父级纠正Git --exit-code错误与空格文件名路径。独立报告中“clean”仅离线范围，不替代现场。
- [x] PR13：commit65c5292，Draft PR #23（base spike/issue-loop），后续组合修复独立integration分支，不混改原PR。

## 明确未完整实现的能力（不能以部分功能勾选替代）
- [x] 交互PTY终端：用户确认后真实shell，pwd/分支输出正确，read读取后续stdin并回显，Kill关闭。`15-pty-interactive.png`。显示器有限ANSI，不承诺vim/CJK完整渲染。
- Slack、完整插件生态、OAuth MCP、原生客户端不在本轮最低路径内，后续调研Issues #15-20不自动实施。

## Issue14 阶段门
- [x] L1 Phase1 worker交付并独立审查；取消竞态/readonly bash问题修复，父级完整测试复跑通过。
- [x] L2 Phase1实际UI与API：CRUD/版本/开关、Run now、Session来源、5run排队/取消、kill-9重启、定时首slot、Bearer/Standard Webhooks鉴权去重。证据在独立loops worktree `docs/acceptance/loops/phase-1/`。
- [x] L3 Phase1 Draft PR #21，commit0fd371f，base feat/loops；不合并不部署。
- [x] L4 Phase2本地Demo验收：Draft PR24，真实审批push/PR15与Issue触发PR16、总览回流、双向Webhook/poll去重、fresh发布和组合Files/Git/权限入口通过。其他事件矩阵/条件/负例用离线确定性测试验证，不冒充全量现场。证据`docs/acceptance/combined/README.md`，公网Webhook部署非本轮。
- [x] L5 范围处理：Phase3明确延期到独立 Issue #22（https://github.com/hifizz/pi-cloud-agents/issues/22），下一次大任务开发。本勾选仅代表拆分记录完成，不代表Phase3实现。

## 失败与修复记录
1. Files真实Sprite sh不支持shopt：改POSIX glob，重验F1通过。
2. Files路径拼接多余括号/空格quote：修复并带空格文件真实回读通过。
3. 深链接write/read effect竞争：测试捕获修复，完整前端及C1现场通过。
4. Preview只在iframe隔离且opaque iframe不携带cookie：响应级CSP+精确capability鉴权修复，P1/P2现场通过。
5. Terminal/Loops测试等待未结束fake任务超时：已记录并有界续跑，未把超时当通过。
