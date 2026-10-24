# M1-05：按会话路由的执行环境

依赖：M1-01（控制库）、M1-03（供应商）。M1-00 已完成：A4 的结论是「工作区未就绪时，env 工厂**直接抛错**」（见下）。

先读：`docs/M1-PLAN.md` §3.2、§3.7、§4.5；`src/env.mjs`（`SandboxEnv`、`spaceEnv`、构造参数 `bash` / `id` / `home` / `cwd`）；`docs/m1-probe.md`（A4、A6）；`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts` 里的 `EnvTarget` 与 `HarnessOptions.env`。

## 已由探针确定的事实
- env 工厂抛错：bash / read 等工具得到可见的 `tool_error`（带你的错误消息），模型可继续；纯聊天不受影响（工厂也会被调用，所以**工厂本身不能有副作用**）。
- 只让 `exec` 报错的 env（`NodeExecutionEnv` 改写 `exec`）**仍然放过文件读写**，不能当作“未就绪”的实现。
- `cwd` 原样透传到 `EnvTarget.cwd`，不存在的目录不会被拦；内置 `write` 会替不存在的路径建出父目录。所以 `cwd` 不是就绪证明，是否就绪只看工作区状态与绑定。

## 你只能创建/修改
- `src/workspace-env.mjs`
- `test/workspace-env.test.mjs`

## 要求
1. 导出 `createWorkspaceEnv({ store, providers }) -> ({ conversationId, cwd }) => ExecutionEnv`，`providers` 是 `{ [kind]: provider }`。**没有 `legacyEnv`**：项目是全新开始，不再有全局共享沙箱这条路径。
2. 解析顺序：`store.links.workspaceOf(conversationId)`（**没有关联就抛错**）→ `store.bindings.current(workspaceId)` → `providers[binding.provider].bash(binding.runtimeId)` → `new SandboxEnv({ cwd: cwd ?? workspace.cwd, bash, home, id })`。
3. `id` 为 `<provider>:<runtimeId>:v<bindingVersion>`。同一工作区的多次调用返回等价环境（`SandboxEnv` 是轻量对象，不需要缓存，但 `bash` 原语要复用）。
4. **绝不回退，且直接抛错**：会话没有工作区关联、工作区存在但没有 active 绑定、绑定对应的供应商未注册、工作区 `preparing` / `failed`，工厂都**抛出带原因的 Error**（「工作区未就绪：<步骤> <原因>」）。不要返回“只封 exec”的 env。
5. `home` 取供应商给出的值（Sprites 为 `/home/sprite`）；本任务不碰 `src/config.mjs`。
6. 每次解析都是读控制库（同步、很快），不要缓存绑定：重建后绑定版本会变，必须立即生效。工厂不做网络调用、不写库。

## 验收
- `TARSBOT_NO_DOTENV=1 npm test` 全绿（先 `npm ls @earendil-works/pi-durable` 确认 1.4.0），用内存控制库 + 假 provider。
- 必测：**没有工作区关联的会话抛错，且不会落到任何全局沙箱**；有关联会话的 `bash` 用的是该工作区绑定的 runtime，**两个工作区各自的 `exec` 落到各自的 runtime 且互不串用**；绑定从 v1 换到 v2 后下一次解析用 v2；未就绪时抛错；未就绪时用真实 harness（`fauxProvider`）发一条纯聊天仍能完成、发一次 `read` / `bash` 得到包含原因的 `tool_error`；id 格式。

最后输出：改动文件、测试结果、未验证项。
