# Issue 13 本地功能交付

用户目标：逐项实现 https://github.com/hifizz/pi-cloud-agents/issues/13 的能力，由每项 SWE-2 high worker 开发，父级集成并从用户视角 EGO 截图验收。起点 774f73d。

## 分支与发布授权

用户后续明确要求独立 PR，不混入上一轮差异。集成分支 `feat/amp13-local-workflow` 从 `774f73d` 创建；PR base 必须为 `spike/issue-loop`，不得误用 main。原分支不承接本轮提交。用户授权在本目录做本地测试和验收，并授权验收后提交、推送新分支、创建 PR；不合并、不部署。workers 仍只离线开发、不 commit/push。

## 阶段
- [x] Read poteto-mode Principles; Frame：读取 Issue，检查路由、鉴权、Session 与 UI panel 接缝。
- [x] Design the workflow：9 个独立 worktree，独立任务书，统一 panel 接入由父级负责。
- [ ] Fan out：每项一个 magpie/devin/swe-2 high worker。
- [ ] Aggregate：检查每项实际 diff、测试、未完成内容；按接口合入，不覆盖他人结果。
- [ ] Run the loop：逐项自动化验证，然后真实本地 UI 用户操作；失败修复后重验。
- [ ] Keep the audit trail：记录关键决定、证据和未验收边界。
- [ ] Verify and hand back：完整后端/前端/typecheck/build，EGO 截图和结果矩阵。

## 完成判据
所有功能都有真实可达 UI、真实数据路径、离线测试和父级 EGO 操作证据。任何只有 mock 或需要外部未配置服务的子项为 NOT VERIFIED，不称为完成/达到 Amp 全功能。无凭据泄露，无新增鉴权豁免，无 Sprite 创建/删除，无合并/部署；提交、推送新分支和开 PR 依上述后续授权。

## 并行与吞吐检查点
9 个功能 worker 是上限，不递归派工。共同基线、独立目录、依赖只读软链接。workers 只离线测试，不启动持久 server，不占 8090/5183，不操作远端。完成后父级逐项集成，避免多写者。每项给出最低可交付路径与非目标，若架构/API受阻直接报告，不造替代成功。

## 验收矩阵
1. Preview：Sprite demo HTTP app 实际渲染，资源/交互可用，未登录不可访问，目标仅当前工作区。
2. Files/Terminal：选当前 Session 路径，浏览/上传/读回同一文件，执行命令并看到真实输出/退出码；不读取宿主或敏感文件。
3. Git：看到 bash/untracked 改动、真实 diff、commit、分支比较；只读且无 reset/checkout。
4. Search/reference：跨同工作区 Session 搜索唯一文本，显式选择引用到当前会话并看到来源，不改变发布任务语义。
5. Delegation：产品 UI 发起子任务、独立 worktree 子 Session 执行、来源关系和结果回看，不是开发工具代理。
6. GitHub events：用户启用同步，真实新评论/事件可见，重复同步不重复提交；未验证 webhook 不称为 webhook 完成。
7. Integrations（用户纠正）：有面向云端Pi的Skill/MCP安装、启停和卸载入口；Pi按需加载Skill、自主调用MCP并经过审批，配置按工作区持久化。人工调用/粘贴文本不算实现。密钥只从环境取。详见修订AMP13-integrations.md。
8. Collaboration：会话深链接在另一个已登录页面打开、刷新保留；窄屏可操作；通知权限显式申请；不能匿名分享。
9. Review/results：固定 SHA/reuse、人工状态与结果回流、旧 issue-loop 和 add-session 回归。

外部平台配置若不可用，不绕过安全边界。父级仅操作现有测试工作区 ws_e168e5f97244a35b / pca-eae56f671c / hifizz/tars-sandbox-playground。本地真实鉴权保留。
