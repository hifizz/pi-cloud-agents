# Phase2 推送复审：仍不通过

父级离线复现（无网络、仅假凭据）：在临时git仓库配置credential.helper本地shell函数，再加CLI -c credential.helper=服务端函数，运行git credential fill。本地helper先执行并返回凭据，证明CLI追加不是清除。当前src/loops/tools.mjs send_git_push仍信任agent可写local config，不能宣称hooks/config/helpers隔离。

必须解决：
1. 不在携带真token的命令中读取agent控制的git配置/helper/url insteadOf/http proxy等。最小可靠做法先用无token原语导出指定run分支bundle，再在服务端控制的独立临时bare repo中（不复制源config）导入对象和固定ref，然后仅该干净repo带凭据push到服务端固定https URL。可执行路径、环境、hooks/config完全控制。共享Sprite仍同信任域，明确不能防进程窃取，不夸大。
2. 至少在现有方案中credential.helper需先空值reset，但仅此不够（local insteadOf/http.proxy等仍生效）。测试必须实际临时git + 恶意helper/URL配置 + 假token证明不执行，而不只匹配命令字符串。
3. 环境剥离：报告末尾说GH_TOKEN仍存在，与server的execEnv空值矛盾。用完整assemble/faux provider证明loop Agent bash spawn env无值，普通session不变；read/write env操作也不能把token带入模型命令。不声称shell正则不可绕过。
4. result形状：现在executionResult只有{kind,prNumber,prUrl,branch,runId}，UI读取summary/testsReportedByHuman/pull且overview只聚合issueLoop.sourceBotId。补兼容的显式loop result显示与Issue关联（按loopRun.entity/run触发issue），测试真实UI fixture。自动产物不可标成人工测试PASS。不吞bots.update异常后假称成功。
5. 明确剩余Issue14 Phase2 criteria覆盖，不用API JSON链接代替产品可打开的运行历史深链接（新增?loopRun=...选择即可）。

在同worktree，允许新增安全push helper模块/src/loops/内，离线真实git临时目录测试。无remote/server/browser/credentials/commit。按25分钟checkpoint，不能完成明说不要再称全部blockers解决。记录取舍和残余，不实现Phase3。
