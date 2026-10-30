# 工作区菜单添加 Session 验收

结果：PASS。2026-10-30，分支 `spike/issue-loop`。正常路径走通即停止，不提交、不推送、不合并。

## 操作与观察

1. 打开本地 http://127.0.0.1:8090，点击左侧工作区右侧「⋯」。弹出「添加 Session」，截图 `01-menu.png`。
2. 点击「添加 Session」。页面内名称表单默认「新 Session」，填写中文名称「手动讨论 Demo」，截图 `02-name-form.png`。
3. 点击「创建」。完成后自动打开新 Session，左侧可见，聊天为空，usage 为 0。真实 entries API 返回 `[]`，没有复制旧历史或自动发首条消息。截图 `03-blank-session.png`，记录 `created.json`。
4. 发送第一条消息，要求在当前目录执行 pwd、Git 状态、分支与 SHA，并确认 README.md 存在，不 cd、不修改、不提交。
5. Agent 实际运行 bash，返回独立目录、detached HEAD、正确 SHA 与 README.md。截图 `04-chat-verified.png`，工具原始输出保存在 `entries.json`。程序断言唯一用户消息数为 1。

## 现场事实

- Session id `2d5d5f01`，conversation 153，名称 `手动讨论 Demo`。
- 原空间 `ws_e168e5f97244a35b`，同一 Sprite `pca-eae56f671c` v1，没有新建沙箱。
- 仓库默认分支 `main`，固定 SHA `3157db095cb9344e5b9cf0669657bf613d036b46`。
- 独立目录 `/home/sprite/sessions/ws_e168e5f97244a35b/session-dbd419d2`。
- Git status：`## HEAD (no branch)`；branch --show-current 空输出，工作树干净。
- 标题栏和 Environment 显示本 Session 的 detached SHA 与目录。不显示旧空间 PR/检查点操作。
- 没有伪造 issue，没有历史继承，也没有自动显示 issue 发布按钮。

## 自动化

worker 最终版本：后端 351 项，350 pass、1 既有 skip、0 fail；前端 140 项通过；typecheck 和 build 通过。父级检查 diff --check 通过，并读取真实 API entries 和 bash 工具输出核验，不只相信 Agent 总结。

## 范围

实现只在现有文件里接线，复用既有鉴权、空间 binding 与 createBot。实验入口仍限制测试仓库。没有增加异常重试、补偿、写锁或生产级恢复。worker 首轮超时，确认进程退出与未完成测试后续跑一次，完成自动化。未删除 data、目录、分支或 Sprite。
