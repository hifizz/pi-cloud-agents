# M2-02：写锁存储与控制库迁移 v2

依赖：无。**控制库迁移 v2 归本任务所有**：`workspace_locks`、`workspaces.mode`、`workspaces.plan_approved_at` 一次建好，M2-03 / 04 / 08 只使用，不改 `db.mjs`。

先读：`docs/M2-PLAN.md` §3.1、§3.4、§4；`src/control/db.mjs`（`MIGRATIONS`、`migrate()`、`PRAGMA user_version`）；`src/control/store.mjs`（事务封装 `tx`、`links`、`workspaces`、`ControlStoreError`、行映射写法）；`test/control-store.test.mjs`（测试写法与文件库的重启用例）。

## 你只能创建/修改
- `src/control/db.mjs`
- `src/control/store.mjs`
- `test/control-store.test.mjs`

**共享文件规则**见 `docs/M2-PLAN.md` §8.1（精确小编辑，只在自己负责的区域改，发现冲突写进汇报）。

## 要求
1. 迁移 v2（追加到 `MIGRATIONS`，不改 v1）：
   - `workspace_locks(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), holder_kind TEXT CHECK(holder_kind IN ('conversation','user')), holder_id TEXT, epoch INTEGER NOT NULL, acquired_at TEXT, updated_at TEXT NOT NULL)`。**释放时保留行**（`holder_kind`/`holder_id` 置空），这样 `epoch` 只增不减。
   - `workspaces.mode TEXT NOT NULL DEFAULT 'direct' CHECK(mode IN ('direct','plan'))`、`workspaces.plan_approved_at TEXT`。
   - 全新开始：v1 到 v2 只需要 `ALTER TABLE` / `CREATE TABLE`；`migrate()` 对已是 v2 的库幂等。
2. `store.locks`：
   - `current(workspaceId) -> { workspaceId, holderKind, holderId, epoch, acquiredAt } | undefined`；没有行或已释放时 `holderId` 为 `null`，`epoch` 仍可读。
   - `acquire(workspaceId, { kind, id, expectEpoch? }) -> { acquired: true, epoch } | { acquired: false, holder, epoch }`：锁空闲 → 取得并 `epoch + 1`；已被同一持有者持有 → 幂等返回当前 `epoch`（不加一）；被别人持有 → `acquired: false`。`expectEpoch` 给出时，当前 `epoch` 不等则按失败处理（防止两个并发申请者都以为自己拿到）。
   - `takeover(workspaceId, { kind, id }) -> { epoch, previous }`：无论谁持有都强制取得，`epoch + 1`，返回被顶掉的持有者（可能为 `null`）。
   - `release(workspaceId, { kind, id }) -> { released: boolean }`：只有当前持有者能释放；释放不改 `epoch`（下一次 `acquire` 才加一）。
   - `assertHolder(workspaceId, { kind, id, epoch }) -> { ok: true } | { ok: false, reason: "released"|"taken-over"|"other-holder"|"no-lock", holder?, epoch }`：给围栏用的**只读**同步检查，必须很快，不写库。`released`（锁空闲）对 `conversation` 持有者的语义由调用方决定，所以这里如实返回原因，不做取舍。
   - 所有写操作在事务里；对不存在的工作区抛 `ControlStoreError("not_found")`。
3. `store.workspaces`：`create` 接受并保存 `mode`（默认 `direct`）；`update` 允许改 `mode`、`planApprovedAt`；行映射里带上 `mode`、`planApprovedAt`。**不要**改变现有字段的允许集合之外的行为，M1 的测试必须保持通过。
4. 不读环境变量，不 import `config.mjs`。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0）。
- 必测（文件库，含关库再开）：
  - v1 库（先用 M1 的迁移建一个带数据的库）升到 v2 后数据完整，`mode` 默认 `direct`；已是 v2 再开幂等；
  - `acquire` 的幂等、冲突、`expectEpoch` 不符；`takeover` 后旧持有者的 `assertHolder` 返回 `taken-over`；
  - 释放后再取得，`epoch` 严格递增，整个历史里**从不回退**（对一个 20 步的随机序列做断言）；
  - 两个并发的 `acquire`（同一进程内连续调用）只有一个成功；
  - 重启后锁状态与 `epoch` 保持；
  - 不存在的工作区报 `not_found`。

最后输出：改动文件、测试结果、对 PLAN 契约的偏离、未验证项。
