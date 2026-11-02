# Session、Loop 与 Orb 架构调研

记录 [Issue #31](https://github.com/hifizz/pi-cloud-agents/issues/31) 的调研结果。目标是决定如何将对话与执行环境解耦，管理并发容量，并接入 Sprites、E2B、Instabox 和 Modal。

**先读[最终综合报告](07-synthesis.md)。** 五份子任务报告保留原文，其中存在已被独立复核纠正的错误，不能直接作为实现规范。此归档不是实施授权，也不表示方案已定稿。

## 报告目录

| 文档 | 内容 | 阅读定位 |
|---|---|---|
| [01-capacity.md](01-capacity.md) | 现有规格、容量、调度与观测缺口 | 原始报告，含待纠正推论 |
| [02-domain-model.md](02-domain-model.md) | Session、Run、Workspace 与 Orb 的归属比较 | 原始报告，含待纠正推论 |
| [03-durable-scheduling.md](03-durable-scheduling.md) | Pi Durable 与资源调度职责 | 原始报告，框架限制部分被复核纠正 |
| [04-providers-recovery.md](04-providers-recovery.md) | 四家供应商与恢复语义 | 原始报告，供应商结论需结合复核 |
| [05-security-governance.md](05-security-governance.md) | 权限、隔离、预算与资源回收 | 原始报告，秘密保留和审批占槽部分被纠正 |
| [06-independent-review.md](06-independent-review.md) | 独立证据复核与错误清单 | 理解哪些论断不能采纳 |
| [07-synthesis.md](07-synthesis.md) | 纠正后的推荐模型、供应商判断与下一步 | 本轮最终结论 |
| [08-evidence-notes.md](08-evidence-notes.md) | 协调者的官方资料核验与源码检查备注 | 补充来源与限制，保留英文工作笔记 |

## 基线与方法

- 调研日期：2026-11-02。
- 固定源码：[9faf7c685dfda3f68fdede64a93721416ad99992](https://github.com/hifizz/pi-cloud-agents/tree/9faf7c685dfda3f68fdede64a93721416ad99992)。报告里的 `src/`、`docs/` 行号均相对于此版本，不是未来 HEAD。
- 研究时通过 `git archive` 导出独立快照，并复制已安装的 Pi Durable 与 Sprites SDK 作为证据。Pi Durable 版本核对为 1.4.0，但没有对安装包与发布包做逐字节校验。
- 第一轮 5 个独立 Pi 进程均由 pstack `agent` 启动，模型为 `magpie/auto/swe-2`，推理强度为 `high`。
- 独立复核模型为 `magpie/relay/gpt-6-astra`，推理强度为 `high`。
- 本轮只读检查源码与公开文档，没有运行测试、负载测量、云账号探测、机器操作或部署。
- 部分官方网页直接读取受网络地址安全检查阻止。相关结论来自搜索服务返回的官方页面摘录，没有绕过保护。
- 历史探针是旧时间点的证据，不能作为当前线上实例配置或容量的实测结果。

报告中的 `/tmp/pca-orb-research-RKFAus/` 路径记录当时的执行环境，不承诺长期存在。阅读本次归档不依赖该目录。官方网页会变化；实施前应按固定 SDK 版本重新核实。

## 关键纠正

1. Session 关联逻辑 Orb，Run、终端和服务持有使用权，Orb 再绑定具体实例与 generation。这些关系不是二选一。
2. Durable 允许异步等待；普通 Promise 等待本身不提供跨重启持久化。框架没有现成的资源调度器，不等于禁止等待资源。
3. 单一数据库写入者不排除未来增加外部执行 worker，但本期没有立即建设分布式平台的必要。
4. E2B 内存暂停可能降级；Modal 可以通过文件持久化与重建承载逻辑环境；Instabox 幂等键有保留期限。不能用绝对标签替代能力契约。
5. checkpoint 会警告某些疑似秘密文件仍被包含，不提供秘密清除保证。内存快照也可能保留进程秘密。
6. 当前等待审批的 Loop 仍占槽。缺少 `needs_approval` 显示转移，不代表释放并发额度。
7. 线上容量、真实成本和恢复承诺尚未实测。

## 后续边界

最终报告建议下一步先做有限的离线资源状态机探针，再另行审批真实 provider 实验。新建独立写任务是否默认独占、恢复承诺、审批保留期限和协调服务是否常驻，仍需产品决策。本次仅保存 Markdown 文档，不实施这些变更。
