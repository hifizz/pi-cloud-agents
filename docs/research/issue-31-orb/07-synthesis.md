# Issue 31 调研综合结论

[阅读索引](README.md) · [独立复核](06-independent-review.md) · [证据备注](08-evidence-notes.md) · [Issue #31](https://github.com/hifizz/pi-cloud-agents/issues/31)

状态：资料与代码调研完成；未实施、未做线上实测。基线 9faf7c685dfda3f68fdede64a93721416ad99992。汇总时主目录 HEAD 未变且 git status --short 为空。5 个 SWE-2 high 研究进程及 1 个 gpt-6-astra high 独立审查进程均已完成。使用 pstack agent，无 subagent 工作流。原始报告不能直接作为结论，已按独立审查纠正。

## 推荐模型

Session 保持与逻辑 Orb 的关联；Run、PTY 和需要保留的服务分别持有可追踪的使用权；Orb 指向当前 provider 实例并记录 generation。Session 生命周期不等于机器运行时间，Run 结束也不等于后台进程停止。

这是职责分离，不要求七张新表。每个独立写任务默认独占环境是长期建议，尚待产品确认；纯文本对话不必申请机器。迁移期先把当前 workspace binding 表达为共享 Orb，保留既有 Session 路由；新建独立任务再显式绑定独占 Orb。可写 fork 仍需实现工作状态复制与一致路由，并非新建机器即可完成。

同一 Session 的 Agent 工具、终端、Files、Git 与 Preview 必须访问同一逻辑环境。实际实例替换时保留 exec 现有的版本核对与结果待确认策略，不把旧命令重放到新实例。Lease 版本不能代替环境 generation。

## 当前应优先解决

1. 配置与实际容量区分。创建请求提交 4 CPU/4096 MB；历史探针与公开文档显示平台行为存在差异，不能给当前线上实例固定容量承诺。无按机器 CPU/RAM/磁盘/活跃工作量视图，也无覆盖普通 Session、PTY、Loop 的统一准入控制。
2. 主服务常驻问题。fly.toml 允许 suspend/min=0；进程冻结时本地 timer 不运行。是否实际挂起与补跑行为未经线上测试。若产品承诺准时无人值守 Loops，建议保留单个常驻协调者；这是配置变更建议，本轮未执行。
3. 资源生命周期对账。会话回答完、租约到期、命令取消、机器空闲是不同事实。收回资源前必须确认在途命令和服务，不能仅靠数据库终态。
4. 恢复与秘密保留政策。checkpoint.mjs:168-184 对疑似秘密文件仅警告其仍被包含，不提供脱敏保证；bundle 也可能包含历史对象。文件拷贝不等于活跃数据库一致性备份；内存快照可能保存进程秘密。

## Pi Durable 的分工

Durable 继续负责对话、任务恢复、持久时间等待、子任务 join 与工具 replay。应用资源服务负责环境申请、配额、队列、使用权与实际资源对账。不要重造对话调度器。

更正原始 C 报告：Durable 允许 async env factory 和普通异步等待；只有普通 Promise 等待本身不能跨重启持久化。可以使用持久申请队列与重查/任务组合；不能宣称框架禁止等待外部资源。memo 不提供外部副作用 exactly-once。

当前单存储写入者不代表未来永远不能有多个执行 worker；未来可单协调者写状态，外部 worker 执行。但本期没有引入分布式调度的证据需求。

当前 Loop 等审批仍占槽：store 的 countOccupying 包含 starting/running/needs_approval。未显式切换 needs_approval 显示态，不等于释放容量。未来是否分离执行槽与保留使用权，需要明确改变契约。

## 四家供应商判断

以下为官方文档声明及源码证据，不是账号实测。部分网页直接读取受网络安全检查阻止，使用搜索服务返回的官方页面摘录。

| provider | 建议定位 | 核心约束 |
|---|---|---|
| Sprites | 先在已有实现上建立逻辑 Orb 和恢复契约 | 创建参数、历史规格与实际配额须重新核实；原生生命周期不能直接等同我们的 Session 生命周期 |
| E2B | 优先做第二 provider 的有限探针 | 默认超时可销毁，需要显式 pause；内存 pause 在特定故障下可退化为 filesystem-only，需保存实际恢复级别 |
| Instabox | 与 E2B 比较的候选，尤其验证生命周期和操作对账 | suspend 与磁盘 snapshot 语义不同；幂等键保留七天，不能代替长期本地意图与对账 |
| Modal | 适合研究一次性任务，也可通过文件快照/Volumes 支持逻辑 Orb 重建 | 不应一票否决长期环境；内存快照有 TTL、源实例终止及 exec 限制，JS exit snapshot 文档有冲突，需固定 SDK 核验 |

E2B 优先是已有项目经验和集成契合度的条件性建议，不是唯一或最便宜的结论。不承诺跨 provider 进程恢复；首版跨 provider 仅定义可验证的代码与产物重建。git bundle 是现有实现，不是唯一可能方案。

官方参考：
- https://docs.sprites.dev/concepts/lifecycle/
- https://docs.e2b.dev/sandbox/persistence
- https://docs.e2b.dev/faq/sandbox-lifetime
- https://instabox.sh/docs/api/machines
- https://instabox.sh/docs/api/lifecycle
- https://instabox.sh/docs/api
- https://modal.com/docs/guide/sandbox-snapshots
- https://modal.com/docs/guide/sandbox-files
- https://modal.com/docs/guide/sandbox-exit-snapshots
- https://modal.com/docs/sdk/js/latest/Sandbox

## 安全结论

工作目录隔离不等于 OS 隔离；去除一个进程的 token 不等于共享 UID 环境完全无凭据。全局 credential helper 是读取环境变量的程序，不等于 token 全局落盘。正则阻断只对匹配字符串强制生效，不是对所有等价程序的封锁。独占 Orb 也不能替代认证、授权、路径检查和预览隔离。

主 Agent 可在服务端策略允许范围内申请环境；不能持有任意创建云资源的管理权限。并发机器数、创建速率、子任务深度、超时和预算都应在控制层约束，不能只靠提示。

## 下一步建议（需新增授权）

先完成一个离线最小探针，而非完整重构或直接四云对接。fake provider 场景：满额排队、授权/创建响应丢失、协调者重启、取消与授权竞争、generation 更换。

通过要求：稳定申请 ID 不重复创建或启动；旧 generation 不接管新环境；不确定结果不自动重跑；审批、PTY、后台服务不被误记为空闲；同一 Session 所有入口一致路由。

通过后，再提交真实实验的资源数、时长、费用、凭据和清理方案，单独获批后执行。当前未创建或操作任何线上机器。

待 owner 确认：独立写任务默认独占是否采纳；首版恢复承诺保代码产物、进程恢复仅按能力是否接受；无人值守 Loop 是否要求主协调者常驻；审批/后台服务保留期限。

## Attention

reviewed by magpie/relay/gpt-6-astra

独立审查状态 ISSUES，指出原始研究存在影响架构选择的错误。本综合报告已撤销 Session-vs-Run 伪二选一、Durable 禁止异步等待、单写禁止所有 worker 扩展、Modal 一票否决、快照自动脱敏及等待审批不占槽等论断。供应商实时容量、费用、SDK 文档冲突与故障恢复仍未实测。

五份原始报告、独立审查报告及证据备注已归档到本目录，见[阅读索引](README.md)。原始执行快照和过程记录仍位于临时目录 `/tmp/pca-orb-research-RKFAus/`，不作为长期可用的证据链接；源码证据以固定 Git commit 为准。本轮没有自动更新 Issue #31。
