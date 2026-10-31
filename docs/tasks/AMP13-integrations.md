# AMP13-integrations 修订：给云端 Pi 安装 MCP 与 Skills

## 用户纠正（取代旧任务范围）
用户明确：不是人工面板调用/粘贴文本，是给 Pi Agent 用的 MCP 和 Skill，必须有安装入口。旧版本不满足需求，不算完成。本轮属于已有Issue13授权的纠正，不另等Issue18授权。

## 用户路径与数据
工作区级安装记录（workspaceId、id、kind、source、enabled、name、description、version/digest、配置变量名），只供该工作区Session使用。保存在本应用dataDir，不是本机 ~/.pi。跨Session worktree共享“安装配置”，不把任意文件全局开放。
- UI：安装 Skill / 添加 MCP、查看已安装、启用/停用、卸载、状态/错误、作用范围。
- Skill：至少支持上传SKILL.md（name/description frontmatter）、从工作区内已有SKILL.md安装。保存快照/来源，安装前可预览，内容不是自动执行指令。让 Pi 系统上下文可见已启用name/description，提供load_skill工具按需加载正文；不得以发送普通用户消息充当安装。不要执行安装脚本，不改用户代码或.git，禁止symlink逃逸。卸载仅删除应用自己记录的安装，不删除原始仓库文件。可选git/url安装需安全与明确版本，无法完成就报告，不造入口。
- MCP：UI可添加命名HTTP endpoint（用户是白名单可信操作者，仍限制公开http(s)并阻断SSRF/redirect/DNS私网绕过），可选运维预配置连接；不要仅做无安装意义的下拉选择。凭据只存允许的环境变量引用，不接收/保存明文secret、不写Sprite；显示支持transport及OAuth未支持。安装时真实initialize/listTools校验，记录配置；工具以稳定命名空间进入该工作区Pi可调用工具集，参数/schema来自真实server，执行结果是tool result。不是人工调用按钮。
- 使用已安装依赖与pi-durable扩展机制；先读node_modules权威types和相关源码，不凭记忆猜动态工具注册。若需新增依赖先报告精确版本理由，由父级安装，不能改共享node_modules。
- 生命周期：当前空闲Session安装后可用（必要时configure）；busy时明确409或下次turn生效，不能静默竞态。新Session自动继承工作区启用配置，重启仍能加载。停用/卸载后实际执行路径拒绝旧tool，不能只从UI移除。
- MCP调用必须接入审批；默认每个外部工具需确认（尤其不能只按工具名危险正则漏过未知MCP写操作）。继承Approval，不能自行把全部工具自动批准。输出外部内容标识不可信。只读fork及受限Session不得因集成获得更高权限；测试否定路径。

## 允许修改
独占 /Users/zilin/side/pi-cloud-agents-amp13-integrations，保留此前改动并重做错误交互。
src/integrations.mjs、src/routes/integrations.mjs、src/skills-env.mjs、src/ext/integrations.mjs、src/runtime.mjs、src/ext/approval.mjs（最小集成，原审批语义保持）、src/bots.mjs（必要会话配置）、web/src/panels/integrations/index.tsx、test/integrations*.test.mjs、web/test/integrations.test.tsx、docs/tasks/AMP13-integrations-NOTES.md。
server.mjs仅给父级最小ctx/生命周期接入片段，公共panel注册由父级负责。不要改其他功能文件。主worktree已有旧版拷贝，父级将按你最终差异合并，不能直接修改主worktree。

## 验证
离线：真实fauxProvider harness + MemoryStorage实际agent tool call，不只HTTP fake断言。Skill安装后模型获得目录并调load_skill，MCP模型调用先被审批阻塞，批准后只调用一次并有toolResult。覆盖workspace隔离、禁用卸载/重启、readOnly拒绝、busy行为、secret不泄露、SSRF与非法schema。UI测试安装/开关/卸载/错误真实交互。
父级EGO：从UI安装真实Skill，提示Pi按该Skill执行并看到load_skill；添加可达MCP，Pi产生工具调用、出现审批、批准返回真实结果。缺端点配置不得算通过。

禁止真实外网/Sprite操作、读.env、浏览器、常驻server、占8090/5183、commit/push、递归agents、安装依赖或修改共享web/dist。每测试命令限90s/per-test timeout，完整套件一次，build临时outDir。约25分钟checkpoint；不能完成就列剩余工作，禁止靠自动降级宣布完成。
最终精简回执+NOTES：接口、动态工具接入依据、测试实际结果、父级配置/合并点、未实现的安装来源与协议范围。
