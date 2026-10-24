# M1-03：Sprites 供应商（每个工作区一台 Sprite）

依赖：无（接口见 PLAN）。M1-00 已完成，B1、B2、B6 的事实写在 `docs/m1-probe.md`，并已收进 `docs/M1-PLAN.md` §4.3，**以修订后的 PLAN 为准**。

先读：`docs/M1-PLAN.md` §3.4、§4.3；`docs/m1-probe.md`（B1、B2、B6）；`AGENTS.md`「安全红线」；`src/sandbox/sprites.mjs`（`createSpritesBash`、`redactMessage`）；`scratch/sprite-setup.mjs`（要抽出的初始化步骤）；`scratch/m1-probe-b.mjs`（B1 的错误形态与清理写法，可参考）；`node_modules/@fly/sprites/dist/client.d.ts`、`types.d.ts`（类型真相：`createSprite(name, {config, labels, waitForCapacity})`、`getSprite`、`listSprites({prefix})`、`deleteSprite`）；`docs/sprites-probe.md`。

## 已由探针确定的事实
- 创建约 0.5 秒；返回的 Sprite 带你传入的 `labels`，`getSprite`、`listSprites` 都能读回。
- **重名创建：`APIError`，`statusCode === 409`**；`getSprite`、`deleteSprite` 对不存在的名字：`statusCode === 404`。错误对象的字段是 `statusCode` 与 `errorCode`（里面是消息文本），**不是 `status` / `code`**。
- 新实例用户 `sprite`（uid 1001），`HOME=/home/sprite`；`gh`、`node` 已在 `/.sprite/bin`，`git`、`setsid`、`flock`、`base64`、`sha256sum`、`tar`、`perl`、`dash` 都有。
- 新实例默认网络不受限；`sprite.updateNetworkPolicy({rules})` 应用现有 allowlist 后 GitHub、npm 可达、`example.com` 不可达，且可恢复为 `{rules: []}`。

## 你只能创建/修改
- `src/providers/sprites.mjs`、`src/providers/sprites-init.mjs`
- `test/providers-sprites.test.mjs`
- **不要修改** `scratch/sprite-setup.mjs` 与 `src/sandbox/sprites.mjs`（本供应商复用其中的 `createSpritesBash` / `redactMessage`；不再使用的全局沙箱代码由 M1-13 统一清理）；初始化步骤复用 `sprite-setup.mjs` 里的做法，在新文件里重写

## 要求
1. 按 `docs/M1-PLAN.md` §4.3 实现 `createSpritesProvider({ client, ghToken, gitEmail, log })`；`client` 是 `SpritesClient` 或同形的假对象。
2. `runtimeName(requestId)`：`pca-` + `sha256(requestId)` 前 10 位十六进制。纯函数。
3. `isManaged(name)`：名字以 `pca-` 开头。能读到标签时还要求包含 `app:pi-cloud-agents`。**`release` 与任何删除路径必须先过这个检查，不通过就抛错；旧共享 Sprite `pi-cloud-agents`（及 `TARSBOT_SPRITE_NAME`）永远不是受管的。** 这是 AGENTS.md 红线的代码落点，写专门的测试。
4. `ensure({requestId, workspaceId})`：先 `getSprite(name)`；存在就返回 `{created:false}`；**仅当 `statusCode === 404`** 才 `createSprite(name, {config:{cpus, ramMB}, labels:["app:pi-cloud-agents", `ws:${workspaceId}`], waitForCapacity:true})`；创建报 `statusCode === 409`（并发或响应丢失后重试）按成功处理，再 `getSprite` 确认并**核对标签含 `app:pi-cloud-agents`**（不含则抛错，说明有同名但非本应用创建的实例）。`getSprite` 报的不是 404（网络、5xx、认证、限流）时**不要去创建**，原样抛出（保留 `statusCode`），由上层把步骤标成待确认。创建成功只表示对象存在，不等于 exec 已就绪；`init` 负责后者。CPU/内存沿用 `TARSBOT_SPRITE_CPUS` / `TARSBOT_SPRITE_RAM_MB` 的默认值（4 / 4096），由参数注入。
5. `init(runtimeId)`：幂等地完成 gh（**先探测 `command -v gh`，新实例已带，通常无需安装**）、git 身份与凭据助手（token 只经 exec 的 env `GH_TOKEN` 传入，不写进 Sprite 磁盘、不进 git config）、网络策略（与 `scratch/sprite-setup.mjs` 的白名单一致）。每步已就绪就跳过。不做 npm 自检、不做 checkpoint。
6. `status(runtimeId)`：`available` / `missing`（`statusCode === 404`）/ `unknown`（其他错误，**不是 `missing`**）。`list()`：`listSprites({prefix:"pca-"})` 再按标签过滤。
7. `bash(runtimeId)`：用 `createSpritesBash({ client, name, env:{GH_TOKEN}, secrets:[token] })`，按名字缓存；返回的函数与 `src/sandbox/sprites.mjs` 的原语契约一致。**注意 exec 的 argv 在 URL 里（上限 64,000 字符，`createSpritesBash` 已检查），本任务不负责分块。**
8. `release(runtimeId)`：先过 `isManaged`（并读标签核对），不通过抛错；删除时 `statusCode === 404` 视为已不存在。
9. 所有错误经 `redactMessage`；日志只记长度、耗时、结果，不记命令、不记 token。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0），全部用假 client，不联网。假 client 抛出的错误对象要带 `statusCode`（与真实 `APIError` 一致）。
- 必测：`ensure` 幂等（连续两次只有 1 次 `createSprite`）；`getSprite` 报网络错或 5xx 时不会 `createSprite`；创建报 409 按成功，且标签不含应用标签时抛错；`release` 对 `pi-cloud-agents`、对无前缀名、对无标签的 `pca-` 名都抛错，对已删除（404）视为成功；`status` 在 5xx 时是 `unknown` 而不是 `missing`；`init` 第二次不重复安装、已有 `gh` 时不下载；错误文本不含 token。
- 联网验收不在本任务（编排者在 M1-14 做）。

最后输出：改动文件、测试结果、与探针结论不一致的假设、未验证项。
