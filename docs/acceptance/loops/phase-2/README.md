# Phase2 现场验收记录（部分通过，非全量完成）

测试使用独立data `/tmp/pca-loops-acceptance` 与既有测试Sprite，未删除用户文件。模型SWE-2。

## 已验证
- UI创建readwrite Loop，显式勾选推送/开PR权限。Pi新增本次验收文件LOOPS-PHASE2-ACCEPTANCE.txt，本地提交84c0513，不改已有文件。
- 两次独立审批分别允许send_git_push、send_github_open_pr。真实测试仓库Draft PR https://github.com/hifizz/tars-sandbox-playground/pull/15，未合并/关闭。见01/02/03截图和pr15.json。
- PR正文产品链接 `?loopRun=run_98a2887835409edd` 可打开正确Session；run记录prNumber15。
- 新GitHub Issue comment 6540774795经30秒durable poll自动触发1个run，Pi回复真实Issue13标题。04-github-poll-run.png。
- 对上述真实comment payload做本地签名Webhook重放：202且新增run0，delivery重放duplicate_delivery，错误签名401。不是GitHub公网hook投递；没有部署公网hook。webhook-poll-dedup.json，重复轮询后仍仅1run（event-dedup-final.json）。
- 用户确认发布Pi生成草稿：fresh Session bb999a2e，独立publish worktree/branch，起点3157db0，首条消息严格等于确认文字，无loopRun权限继承。publish.json、05-published-fresh-session.png。未写文件。

## 现场发现并修复
1. modelTools.add误用工具名string，真实SDK需ToolRegistration对象，导致strict JSON undefined并在首条提交前失败。改对象并通过回归。
2. control.links.ofConversation数字ID对SQLite TEXT键查询失败，工具看不到所属run。统一String转换，复跑真实push/PR通过。
3. durable poll任务runtime.commit返回裸checkpoint，不是NextTaskState，造成Harness SessionFailed。worker真实SQLite复现修复为单个sleeping状态commit；父级重跑并真实poll通过。
4. UI缺GitHub权限开关，补勾选且保存；创建/编辑/启停未sync poller，补生命周期接线。
5. webhook delivery标记仍在副作用前，父级改成功摄取后mark。
6. publish工作树有分支但meta/header当detached，补branch传递（后续组合重验）。

## 尚未完成的验收
- 双通道反向（Webhook先、poll后），所有要求的Issue/PR event矩阵、标签移除再加、checks/reviews真实路径。
- scope能力否定路径目前离线测试；真实审批拒绝/越对象、取消时不发生写操作需进一步覆盖。
- Issue触发readwrite产出PR并回流Issue总览（本次PR任务是manual）；UI自动产物不冒充人工测试记录。
- 合并Issue13后全部工具面板与Loop Session组合验证。

父级全量复跑日志 `/tmp/loops-phase2-live-final-{backend,web,build}.log`，typecheck/build通过。Phase2未commit/开PR；Phase1仍独立Draft PR21。
