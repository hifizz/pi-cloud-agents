# 首页与思考强度本地验收

## 最终 UI 调整

- Issues / PR 各展示最多 12 条，长标题最多两行，同排等高并加大列表区域。所有「还有 N 个，查看全部」均可点击，打开对应底部 Sheet。
- 模型与思考强度按钮取消点击缩放；模型选择回显只显示模型名称，不含 provider 前缀。EGO 鼠标按下时两个触发器的宽高均保持不变，computed scale/transform 均为 none。
- 最终前端 252/252（24 files，`--maxWorkers=4`）；typecheck/build 通过。后端最后一轮 622 pass / 1 skip。
- `07-taller-lists.png`、`08-stable-model-picker.png` 为最终调整证据，前面的 8 条列表截图仅记录中间版本。

## 移除仓库白名单

用户明确要求全部放开：删除 issue-loop / GitHub events 仓库名单、配置字段和演示环境变量。仍保留登录鉴权、就绪和运行时绑定检查、事件同步的显式启用以及现有审批。

- 离线：任意 owner/repo 的讨论与手动 Session 成功；事件同步 enable/sync/startPolling 接受其他仓库；非 ready 仍拒绝。
- 后端 622 pass / 1 skip；前端 251 pass，typecheck/build 通过。
- EGO 实际打开 thread-chatbot 工作区 `ws_0da35f122751031d`，用不存在的 issue `2147483647` 验证守卫已放行：得到 GitHub issue 不存在的 404，而非仓库白名单 409。没有启动讨论、没有修改远端仓库。截图 `06-unrestricted-repo.png`，Events 中不再显示仅限测试仓库。

## 后续布局调整

- Loops / Events 各占半宽，同排卡片内容框等高。EGO 实测两个框均为 552×71.5，Issues / PR 均为 552×186.5。
- Issues / PR 首页最多展示 8 条；点击 PR 标题打开底部 Sheet，选中对应行；详情保留 GitHub 链接。各「查看全部」入口统一底部 Sheet，设置仍保留侧边。
- EGO 验证 PR 标题点击、选中行和 Issues 查看全部；1440×900 下底部 Sheet 宽 1440、高 675。截图 `04-equal-cards.png`、`05-bottom-pulls.png`。
- 本轮前端 251/251，typecheck / build 通过。

## 可访问入口

- 前端：http://127.0.0.1:5183
- 首页：`/?workspace=ws_e168e5f97244a35b`
- SWE-2 会话：`/?bot=223f3535`

## 数据恢复边界

原 `/tmp/pca-wia-demo-data` 数据库及 `/tmp/pca-loops-acceptance` 来源目录缺失，原因未知。用户授权恢复一个可测试环境。清单启动器使用 SQLite backup API，从主仓 `data/` 只读复制到 `/Users/zilin/side/pca-wia-demo-state`。原数据未改，未创建或删除 Sprite。只恢复旧副本含有的测试工作区，旧链接 `8912f72e` 不在此副本，不宣称恢复该会话。

入口仍是 `node /Users/zilin/side/pca-wia-demo/scripts/demo.mjs restart wia`。密钥保存在新数据目录的 `env.key`，文件权限 0600，不进 Git。

## 验证

- 合并后的后端：623 tests，622 pass，1 skip。
- 前端：250/250（`--maxWorkers=4`）；typecheck 与 build 通过，保留原有 bundle 大小警告。
- EGO：登录、首页六板块加载完成且无 alert；Integrations 抽屉出现明确会话选择器；Routines 抽屉可打开并 Esc 关闭。
- EGO：会话 223f3535 从默认选择最大，刷新后按钮仍显示最大；真实 API 返回 `levels: [medium,high,max], current: max`。未发模型任务，本次只证明配置持久化，实际参数另有离线 wire 测试。
- 桌面 1440×900 六块可见；390px 页面无水平溢出。截图 01 的 Issues/PR 正处重新加载，完整加载通过在此前独立检查中确认。
- `01-home.png`、`02-thinking.png`、`03-mobile.png` 为截图。未为测试创建 Loop/Routine/Integration，相关板块为空属于旧副本现状；不伪造内容。
