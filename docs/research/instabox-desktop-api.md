# Instabox 桌面 API 与 Session 右侧面板接入调研

## 结论与验证范围

Instabox 官方提供桌面画面接入能力，可以在本项目 Session 右侧新增“桌面”面板，观看 Linux 桌面，也可以支持鼠标和键盘操作。

主要有两条接入路径：使用官方 viewer 链接嵌入 iframe，或者后端转发 VNC WebSocket、前端使用 noVNC。选择取决于机器归属、API key 类型，以及我们需要怎样的访问控制。

本报告是 API 与接入方案调研，不是实现或上线记录。检查了官方文档搜索摘录和本地代码，没有连接真实机器、读取凭据、创建资源或测试桌面流。直接读取官方页面受网络地址安全检查阻止，未绕过检查。当前公开文档的能力与限制应在实现前按固定 SDK 版本再次核验。

本地源码基线：[39c0bbf74d863d077626ff257399ccd5f4682a95](https://github.com/hifizz/pi-cloud-agents/tree/39c0bbf74d863d077626ff257399ccd5f4682a95)。

## 1. 方式一：iframe 嵌入官方桌面 viewer

这是最小接入方案，不需要我们解码桌面画面或实现远程桌面客户端。

### 启动桌面

```http
POST https://api.instabox.sh/v1/machines/{machineId}/desktop
X-API-Key: <仅后端持有的凭据>
Content-Type: application/json
```

```json
{
  "action": "start",
  "width": 1280,
  "height": 800
}
```

官方文档说明：

- `agent-browser` 模板自带 Linux 桌面和浏览器。
- `desktop.start()` 可重复调用，已经运行的桌面保持不变。
- 默认屏幕为 1280 × 800；SDK 文档列出的范围为宽 800–2560、高 600–1600。
- 不带桌面的模板，SDK 的 `start()` 会先安装桌面，不能把它当作瞬时操作。

### 生成 viewer 链接

```http
POST https://api.instabox.sh/v1/machines/{machineId}/desktop/stream
X-API-Key: <仅后端持有的凭据>
Content-Type: application/json
```

```json
{
  "viewOnly": true,
  "ttlSeconds": 600
}
```

返回字段为 `url` 和 `expiresAt`。SDK 对应调用：

```js
const { url, expiresAt } = await sbx.desktop.streamUrl({
  viewOnly: true,
  ttlSeconds: 600,
});
```

前端将服务端返回的 URL 交给 iframe：

```html
<iframe
  src="服务端返回的桌面链接"
  title="Session 桌面"
  referrerpolicy="no-referrer"
  style="width:100%;height:100%;border:0"
></iframe>
```

以上仅是接口用法示意，不是生产组件。实现时需验证 iframe sandbox、CSP、全屏与剪贴板权限，不能直接照搬现有网页预览面板的限制。

### 凭据与权限限制

| 项目 | 官方文档定义 |
|---|---|
| 创建和撤销链接 | 仅机器创建者，使用登录身份或其个人 key；key 需具有 `machines:write` |
| workspace key | 不能创建分享链接，返回 `403 permission_denied` |
| 个人 key 的范围 | 只能访问其个人 workspace 的机器 |
| 默认模式 | `viewOnly: true`，仅观看 |
| 交互模式 | `viewOnly: false`，允许控制 |
| 链接有效期 | 60–86400 秒，默认 3600 秒 |
| viewer 身份 | 拿到链接即可连接，不要求登录 Instabox |
| 只读强制 | 服务端拦截键盘、鼠标和剪贴板输入，不只是前端禁用按钮 |

链接本身是访问凭证。它不是管理 API key，但不能写入普通日志、公开对话、截图或无保护的持久记录。生成链接的接口仍须经过本应用鉴权和机器归属校验。

### 到期与撤销不是同一件事

官方文档明确说明，链接到期只阻止新连接，已经连接的观看者可以继续保持连接。

主动撤销接口：

```http
DELETE https://api.instabox.sh/v1/machines/{machineId}/desktop/stream
X-API-Key: <仅后端持有的凭据>
```

SDK 对应 `sbx.desktop.revokeStreamUrls()`。它撤销该机器的全部分享链接，并在几秒内断开现有 viewer。删除机器也会使链接失效。

这不是按用户或单个链接撤销。因此不能在关闭一个面板时无条件调用该接口，否则可能断开其他用户或 Session 的桌面。关闭 iframe 也不等于已撤销此前发出的访问链接。

来源：[Desktop](https://instabox.sh/docs/desktop)、[SDK reference](https://instabox.sh/docs/sdk)。

## 2. 方式二：后端转发 VNC WebSocket

workspace key 应使用以下接口：

```http
GET /v1/machines/{machineId}/vnc
```

这是 WebSocket Upgrade 接口，传输 VNC/RFB 协议，不是可以直接放进 iframe 的网页，也不是 `<video>` 可以播放的视频地址。

我们的服务端连接：

```text
wss://api.instabox.sh/v1/machines/{machineId}/vnc
```

在上游握手中携带 `X-API-Key`。可访问该机器且具有 `machines:write` 的 key 可以连接，包含 workspace key。浏览器不持有这个管理凭据。

前端 noVNC 连接我们自己的已鉴权 WebSocket 路由，由后端转发二进制消息。路由名称和返回格式尚未设计，本报告不新增或承诺任何本项目 API。

### 收益与成本

| 方面 | 接入影响 |
|---|---|
| 登录与归属 | 使用本项目登录态，服务端决定用户可连接哪台机器 |
| 撤权 | 可以关闭某个用户的连接；完整实现仍需定义登出、会话过期和权限变化后的断开策略 |
| 链接泄漏 | 不向浏览器提供独立于本项目登录的官方分享链接 |
| 前端 | 需要 VNC viewer，例如 noVNC |
| 后端 | 需要管理上游鉴权、二进制转发、关闭、错误、重连与背压 |
| 容量 | 画面流量经过主服务，增加带宽、缓冲与连接负载，需实测 |

### 只读不能仅由前端开关保证

把 noVNC 客户端设为 view-only，不代表服务端禁止输入。客户端设置可能被修改。

当前核验资料没有给出原始 `/vnc` 接口的可靠只读参数契约。若我们提供只读角色，需核实供应商的服务端限制，或采用经过验证的协议级输入限制。不能简单丢弃全部客户端消息，因为 VNC 握手和画面更新请求也需要双向通信。

最小实现可以只向明确拥有完整控制权限的用户开放原始 VNC；真正的只读分享则优先使用官方服务端强制的 viewer 链接，前提是符合个人创建者的凭据限制。

### 并发连接上限

官方 Desktop 文档称，每用户同时最多有 8 个终端和桌面连接。workspace key 按 workspace owner 计数，第 9 个 `/vnc` 连接返回可重试的 `429 quota_exceeded`。

因此多个 Session、浏览器标签页和终端可能共同消耗额度。面板离开时必须关闭上下游连接，并避免无上限重连。实际账户限制和连接释放时间仍需验证。

来源：[Integrate with the SDK](https://instabox.sh/docs/integrate)、[Desktop](https://instabox.sh/docs/desktop)。

## 3. 在本项目中如何接入

### 新增桌面面板，不替换网页预览

当前面板注册入口是 `web/src/panels/index.ts`，预览面板位于 `web/src/panels/preview/index.tsx`。

建议将两种功能分开：

- “预览”展示某个开发服务器提供的网页。
- “桌面”展示整台 Instabox 的图形环境，包括浏览器、终端和其他 GUI 程序。

现有 Preview 后端通过 `bash + curl` 转发普通 HTTP 请求，不能直接承担 VNC WebSocket 转发。

### Session 归属必须由服务端解析

前端提交当前 Bot/Session ID。服务端解析其实际绑定的执行环境，验证 provider、机器归属和访问权限，再创建 viewer 链接或 VNC 上游连接。

不能接受客户端任意给定的 machine ID、上游 URL 或管理 key，并直接连接。

当前代码位置：

| 文件 | 可复用的结构或需注意的限制 |
|---|---|
| `web/src/panels/index.ts` | 右侧面板注册 |
| `web/src/panels/preview/index.tsx` | 面板布局与 iframe 示例；其 sandbox 策略不能直接照搬 |
| `src/routes/terminal.mjs` | 已鉴权 WebSocket 路由的现有模式 |
| `src/routes/auth.mjs` | 登录态与 WebSocket Origin 校验 |
| `src/workspace-env.mjs` | 当前 Session 经 Workspace 解析 runtime binding |
| `src/preview-env.mjs` | 普通 HTTP 预览实现，不支持通用 WebSocket 桌面流 |

API 和 WebSocket 都必须继续经过鉴权。只在初次握手认证，不自动保证连接期间的撤权；需要明确登出、会话到期和绑定变更的处理方式。

### 桌面是机器级，不是 Session 级

Instabox 桌面接口的对象是 machine。如果多个 Session 共用同一台机器，它们看到和控制的是同一个桌面。独立 worktree 不会自动产生独立显示环境。

因此当前共享模式应标注“工作区共享桌面”。未来 Session 绑定独占 Orb 后，才自然获得独立桌面。切换机器绑定时必须断开旧连接，不能让新 Session 继续显示旧机器。

这项能力可以先独立接入，不要求先完成整个 Orb 重构，但不能忽略共享桌面的产品语义。

## 4. Agent 操作桌面是另一组能力

除了 viewer，SDK 提供以下工具：

```js
await sbx.desktop.status();
await sbx.desktop.screenshot();
await sbx.desktop.open("https://example.com");
await sbx.desktop.click(640, 400);
await sbx.desktop.type("hello");
await sbx.desktop.press(["ctrl", "l"]);
await sbx.desktop.scroll({ direction: "down", amount: 5 });
```

另有 `move`、`drag`、`cursorPosition`。`screenshot()` 返回 PNG 字节，可以供视觉模型使用；截图不是实时桌面流的替代品。

官方说明桌面运行在 X display `:1`。只有在这个可见桌面上启动的 GUI 程序才能出现在画面里。Agent 启动 headless 浏览器，不会因为接入 viewer 就自动变成可见浏览器。

官方控制台描述了“点击接管、空闲一分钟后交还 Agent”的体验，但本次没有找到足够明确的公开 API 契约，证明它自动协调我们自己的 Agent 工具调用。因此：

- 首版建议默认观看。
- 人工接管和 Agent 输入之间的互斥需单独设计、验证。
- 不承诺 viewer 接入后就自动解决人机抢鼠标的问题。

来源：[Desktop](https://instabox.sh/docs/desktop)、[SDK reference](https://instabox.sh/docs/sdk)。

## 5. 暂停与失败行为

官方错误文档列出 `desktop_not_running`，HTTP 409。应先启动桌面，再请求连接，而不是无限重连。

官方 idle-suspend 文档区分自动暂停与用户手动暂停：自动暂停可以在使用时唤醒；手动暂停或停止需要明确 resume/start。最长运行时间触发的暂停还可能有 cooldown，唤醒返回带重试等待时间的 `409 machine_cooldown`。

不能把官方控制台打开桌面会唤醒机器，直接推导为所有原始 VNC 或 viewer 路径具有完全相同的行为。必须逐路径验证，也不能在打开面板时偷偷恢复用户手动停止的机器。

来源：[Errors](https://instabox.sh/docs/errors.md)、[Idle pause and max-run](https://instabox.sh/docs/idle-suspend)。

## 6. 推荐与最小验证

### 短期展示验证

如果机器由个人账号创建，且接受“拿到链接即可访问”的权限模型，采用官方 viewer iframe，默认只读。这样无需新建 VNC 转发层。

### 长期产品能力

如果使用 workspace key，或要求桌面访问始终受本项目的登录与撤权机制控制，采用鉴权 WebSocket 转发与 noVNC。

不要仅为了减少前端开发，就将所有机器改为个人 key 创建；这会改变资源归属和权限安排。

### 实施前最小验证清单

- [ ] 确认实际机器创建方式、key 类型和所需 scopes，不读取或回显密钥值。
- [ ] 验证官方 iframe 在我们站点的 CSP、sandbox 和浏览器环境下可正常显示。
- [ ] 验证只读模式、链接过期后的重连、主动撤销已有连接。
- [ ] 验证关闭面板、切换 Session、登出和绑定变更时释放连接。
- [ ] 验证两名观看者下，机器级撤销的影响范围。
- [ ] 验证 VNC 连接限额、429 退避与异常断线后的资源释放。
- [ ] 验证自动暂停、手动暂停、cooldown 下的提示与恢复策略。
- [ ] 验证 viewer 显示的是 Agent 实际操作的桌面，而非另一套 headless 浏览器。
- [ ] 对 VNC 转发测量带宽、缓冲与主服务内存，再决定并发上限。
- [ ] 若开放人工输入，验证接管期间 Agent 不会同时操作同一桌面。

以上全部是待执行项。本轮未做真实资源测试，也没有修改运行配置。

## 官方来源

1. [Desktop: see it and control it](https://instabox.sh/docs/desktop)
2. [SDK reference](https://instabox.sh/docs/sdk)
3. [Integrate with the SDK](https://instabox.sh/docs/integrate)
4. [Machines API](https://instabox.sh/docs/api/machines)
5. [API overview](https://instabox.sh/docs/api)
6. [Errors](https://instabox.sh/docs/errors.md)
7. [Idle pause and max-run](https://instabox.sh/docs/idle-suspend)

相关架构讨论见 [Session、Loop 与 Orb 调研索引](issue-31-orb/README.md)。
