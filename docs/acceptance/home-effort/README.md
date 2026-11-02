# 首页与思考强度本地验收

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
