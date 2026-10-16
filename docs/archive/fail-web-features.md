# B5 web-features：Fork-at-entry 被后端路由缺陷阻塞

## 现象
前端 "Fork from here" 发送 `POST /api/bots/:id/fork {entryId, name, ...}` 时：
- `entryId` 为数字（线上 entry.id 是 number，如 299）→ `400 {"error":"entryId must be a string"}`
- `entryId` 为字符串 `"299"` → `{"error":"Storage.entry() requires an entry ID"}`（conv.fork 需要 number）

## 复现
```
curl -XPOST localhost:8080/api/bots/3c7efdd8/fork -H 'content-type: application/json' \
  -d '{"name":"ui-test-x","entryId":299}'      # 400 must be a string
curl -XPOST localhost:8080/api/bots/3c7efdd8/fork -H 'content-type: application/json' \
  -d '{"name":"ui-test-x","entryId":"299"}'    # Storage.entry() requires an entry ID
```
省略 `entryId`（fork 最新 entry）工作正常：返回 `parent:{botId, entryId:303}`、`readOnly:true`。

## 猜测 / 建议修复（src/routes/fork.mjs，编排者）
`optString(b,"entryId")` 应改为接受 number（或数字字符串并 `Number()` 转换）后再传给 `bots.forkBot`。
`test/fork.test.mjs` 只在 `forkBot` 层传数字 entryId，路由层仅测了 `"bogus"`→400，所以没发现。

## 前端处理
`api.forkBot` 按路由当前校验发送 `String(entryId)`；路由修复后（接受数字字符串并转为 number）无需改前端。
若改为只接受 number，则把 `web/src/lib/api.ts` 中 `String(input.entryId)` 改回 `input.entryId`。
