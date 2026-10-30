# PR Review、Session 状态、结果回流验收

结果：Fast Demo 正常路径 PASS，2026-10-30。开发与整合均使用 Devin SWE-2，不使用 Haiku。父级独立重跑整合版本：后端 361 项（360 pass、1 既有 skip、0 fail）；前端 151 项通过；typecheck/build 通过，只有既有 bundle >500kB 提示。

## 实际操作

1. 点击工作区打开总览，点击真实测试仓库 PR #11 的 Review 按钮。
2. 自动创建 `pr-11-review`（bot `9f13b125`），复用空间 `ws_e168e5f97244a35b` 和 Sprite `pca-eae56f671c`。Agent 接收真实 PR 正文、SHA、diff，读取代码并完成审查。没有改文件、评论 GitHub、审批或合并 PR。
3. 实际 Git 检查：目录 `/home/sprite/reviews/ws_e168e5f97244a35b/pr-11-4eca06c7`，`## HEAD (no branch)`，HEAD `1862ce13ad43b453b8f5e7b72a51379c5db60ffe` 等于 PR head。记录 `git.json`。
4. 再点击同一 PR 的 Review，返回同一 Session，Session 总数不变。记录 `evidence.json`。截图 `03-review-complete.png`。
5. 打开已有执行 `issue-12-exec`，将状态从执行中改为待确认，查询 API 确认保存。填写结果摘要、人工测试记录与真实 PR 编号 11，提交成功；再手动标为已完成。截图 `01-result-form-saved.png`。
6. 点击工作区，Issue #12 下显示该执行的已完成状态、摘要、人工测试记录和经过 GitHub 验证的 PR #11 链接。截图 `02-overview-results.png`。

## 事实与边界

- PR #11 是原有验收 PR，并非本次执行产生。表单摘要明确写了“仅用于验证关联已有 PR 的交互，不是这次任务产出的 PR”。不伪造任务产出。
- 测试文本仅记录之前实际观察的 pwd/Git/文件回读，并明确“未运行自动测试套件”。界面标记人工填写，没有自动成功标签。
- 待确认是业务状态，不等于已有工具审批。没有新增审批机制或把 idle 推断为完成。
- Review 输出是模型审查意见，未将其每条结论作为验证过的缺陷。本次验证的是 PR 读取、代码起点、会话执行与 UI 路径。
- 真实 GitHub diff 读取失败直接失败，不无声退化为没有 diff 的 review。
- 同 PR 更新 head 后会新建 review 的路径仅离线验证；没有为测试修改远端分支。
- 未实现生产级并发锁、事务恢复、自动回填或自动评论。无新 Sprite，无提交、推送、合并或部署。
- 独立 worker 工作树保留在 `/Users/zilin/side/pi-cloud-agents-review-demo`；主工作树已经整合，尚未提交。
