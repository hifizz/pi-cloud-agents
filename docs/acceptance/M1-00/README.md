# M1-00 探针与只读浏览器烟测

日期：2026-10-25（UTC+08）。详细结论、失败重跑与设计修改清单见 [docs/m1-probe.md](../../m1-probe.md)。

| 验收 | 版本与方法 | 实测 | 结果 |
|---|---|---|---|
| A1–A6 | Node v24.21.0；隔离安装 pi-durable/pi-ai/chord 1.4.0；假模型、临时 SQLite、子进程 SIGKILL | 195/195 断言；safe / unsafe 各10次；最终全量两次均通过 | PASS |
| 后端回归 | 相同1.4.0隔离副本 | 首轮163/164（副本缺脚本fixture）；补齐后164/164；原失败记录保留 | PASS |
| B1–B6 | Sprites SDK0.2.3，3个带应用标签的真实专用实例 | 创建、标签、错误状态、后台进程、取消、传输哈希、网络策略均有证据 | PASS |
| 资源清理 | 精确本次名字+前缀+标签校验后删除，再按前缀查询 | 3创建、3删除；结束与独立复核均0残留 | PASS |
| 现有UI烟测 | EGO TaskSpace2；现有pi.zilin.im部署 | 读取会话列表、现有会话和Environment面板，显示Sprite名称与工作目录 | PASS（仅只读烟测） |

浏览器步骤：

1. 使用 ego-browser 技能创建本次 TaskSpace，打开现有 `https://pi.zilin.im`。
2. 等待原有登录会话加载，观察列表与现有会话正常显示。
3. 点击 Environment，核对显示 `Sprite pi-cloud-agents`、`/home/sprite/workspace`。
4. 保存 [01-environment-smoke.png](01-environment-smoke.png)，检查无token；关闭本次TaskSpace。

没有发送消息、创建Bot、触发模型或执行远端命令。截图中的模型和聊天均为原有内容，不表示本次使用该模型做测试。后续真实模型测试按用户2026-10-25约定仅使用 SWE-2、GLM 5.3 或 GPT-6.1-sol；本次 A 使用 fauxProvider，没有付费模型调用。

此烟测不代表新runner、工作区或恢复功能已完成。M1-00是API与进程行为探针，M1-14的完整UI链路仍待实现后验收。

证据：

- [A正式JSON](../../../scratch/m1-probe-a-results.json)
- [B正式JSON](../../../scratch/m1-probe-b-results.json)
- [完整报告](../../m1-probe.md)
