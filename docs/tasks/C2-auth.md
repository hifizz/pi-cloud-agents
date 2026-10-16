# Cloud / C2-auth：白名单登录（Google + 密码）与全局守卫

依赖：无（与 C1、C3–C6 并行）。契约见 `docs/CLOUD-PLAN.md` §4，**严格按契约实现**，C3 前端按同一契约并行开发。

先读：`docs/CLOUD-PLAN.md` §4、§7；`src/api.mjs`（全文：`createApi`、`app`、`HttpError`、`send`、`readBody`、`createServer` 回调、`upgrade` 处理）；`src/server.mjs`（`loadRoutes`）；`src/routes/approvals.mjs`（路由插件写法）；`src/config.mjs`（`dataDir`）；`test/api.test.mjs`（测试写法）。Node 24 `node:sqlite` 的 `DatabaseSync` API 以 Node 文档为准。

## 你只能创建/修改

- `src/api.mjs`（只加 `app.guard` 机制，以及顶部 "no authentication" 注释的更新；不改已有路由行为）
- 新建 `src/auth.mjs`（存储、密码哈希、session、白名单、配置读取）
- 新建 `src/routes/auth.mjs`（`register(app)`：路由 + `app.guard`）
- 新建 `scripts/set-password.mjs`
- 新建 `test/auth.test.mjs`
- `src/routes/approvals.mjs`（仅更新 "no authentication" 注释）
- 失败时 `docs/fail-C2-auth.md`

**不要碰**：`src/config.mjs`、`src/server.mjs`（C1）、`test/api.test.mjs`（C1）、`web/`（C3）、`package.json`（不得新增依赖）。

## 要求

1. `api.mjs`：`app.guard(fn)` 按 §4.4 实现。HTTP 守卫在路由匹配前执行，仅对 `path.startsWith("/api/")`；`fn` 可以是 async；抛 `HttpError` 时按其 status 返回 JSON 错误。WS 守卫在 `upgrade` 中、`handleUpgrade` 之前执行，失败写 `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n` 并 `socket.destroy()`。未注册任何 guard 时行为与现在完全一致（现有 `test/api.test.mjs` 必须保持全绿）。把 `HttpError` 导出（若尚未导出）供插件使用。
2. `auth.mjs`：
   - `node:sqlite` 打开 `<dataDir>/auth.sqlite`（dataDir 取 `config.dataDir`；支持注入路径以便测试用临时目录），建表见 §4.2，开 WAL。
   - 密码：`crypto.scrypt`（N=16384, r=8, p=1, keylen 64, 16 字节 salt），校验用 `timingSafeEqual`。
   - session：`randomBytes(32)` base64url；库里存 sha256；30 天过期；读取时惰性删除过期行。
   - 白名单解析：逗号分隔，trim + 小写，空项忽略。
   - 读取 §4.1 所有环境变量；`TARSBOT_AUTH_DISABLED=1` 且 host（`process.env.TARSBOT_HOST ?? "127.0.0.1"`）非 loopback 时抛错。
3. `routes/auth.mjs`：实现 §4.3 全部接口与 §4.4 守卫（含 Origin 校验、登录失败限流、OAuth state 内存表 10 分钟过期）。Google 端点：授权 `https://accounts.google.com/o/oauth2/v2/auth`，换 token `https://oauth2.googleapis.com/token`（`application/x-www-form-urlencoded` POST），userinfo `https://openidconnect.googleapis.com/v1/userinfo`。外部 `fetch` 要可注入（`register(app, {fetch, ...})` 测试钩子），生产用全局 `fetch`。`TARSBOT_AUTH_DISABLED=1` 时守卫全放行、`/api/auth/me` 返回 `{email:"dev@local"}`，并 `console.warn` 一次。
4. `scripts/set-password.mjs <email>`：校验 email 在白名单；从 stdin 读密码（TTY 时关闭回显；非 TTY 读一行，便于 `fly ssh console` 管道），至少 12 个字符；写入/更新 `users`；只打印 "password set for <email>"。
5. 日志与响应中不得出现密码、session token、OAuth code、client secret。
6. `test/auth.test.mjs`（离线，`fauxProvider` 不需要；用 `createApi` + 临时 `TARSBOT_DATA_DIR` + 注入假 fetch）至少覆盖：
   - 未登录访问 `/api/bots` → 401；`/api/health` → 200；静态 `/` 不受影响。
   - 密码登录成功 → cookie 带 `HttpOnly`、`SameSite=Lax`、`Path=/`；https 时带 `Secure`；随后 `/api/auth/me` 200、`/api/bots` 200。
   - 错误密码 / 白名单外邮箱 → 401 同一错误文案；连续失败 → 429。
   - 非 GET 请求 Origin 不匹配或缺失 → 403。
   - WS 升级无 cookie → 401；有 cookie → 升级成功。
   - Google：state 不匹配 → 302 `/?auth_error=state`；`email_verified:false` 或白名单外 → `denied`；成功 → 302 `/` 并 Set-Cookie。
   - logout 后 cookie 失效；过期 session 被拒。
   - `TARSBOT_AUTH_DISABLED=1` + `TARSBOT_HOST=0.0.0.0` → 抛错。
   - `set-password.mjs` 用非 TTY 管道设置密码后可登录（子进程测试）。

## 验收

- `TARSBOT_NO_DOTENV=1 node --test test/auth.test.mjs test/api.test.mjs` 全绿；再跑 `TARSBOT_NO_DOTENV=1 npm test`（C1 的改动可能同时进行，非本任务文件导致的失败注明后忽略）。
- 不运行 `npm start`、不做浏览器验收（C7 统一做）。

最后输出：改动文件、测试命令与结果、接口与契约的任何偏差（必须为零，或写明原因）、未验证项。
