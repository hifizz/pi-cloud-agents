# Batch 1 / Task 5（WP3）：ExecutionEnv 适配器

先读：`docs/CONTRACTS.md`（全部）、`docs/PLAN.md` Task 5、`node_modules/@earendil-works/pi-durable/dist/env/index.d.ts`、`dist/env/node.d.ts`、`dist/testing/*.d.ts`、`vendor-ref/durable-examples/29-sandbox-per-conversation.ts`。

## 你只能创建/修改这些文件
- `src/env.mjs`
- `test/env.test.mjs`（node:test，离线，用 mock space）
- `test/vitest/env-conformance.test.mjs`（vitest，跑 `registerEnvConformance`，连真实 Space）
- `scratch/env-demo.mjs`
- 失败时：`docs/fail-WP3.md`

## 要求
1. `export class CuaEnv`，实现完整 `ExecutionEnv`（FileSystem + Shell）。构造：`new CuaEnv({ cwd, bash, write? })`，其中 `bash(command, {timeoutMs}) => {stdout, stderr, exitCode, timedOut}`（默认 `spaceBash`），便于单测注入 mock。`id = "cua:main"`。
2. `exec(command, options, context)`：string 直接作为 shell 命令；argv 数组用 `shellQuote()` 转义（单引号方案）。处理 `cwd`（`cd <q> && ...`）、`env`（`export K=<q>;`）、`timeout`（秒→ms，超时返回 `err(new ExecutionError("timeout", ...))`）、context 取消（`aborted`）。stdout/stderr 在结束后各回调一次 `onOutput`。返回 `ok({exitCode})`。spill/window 可忽略。
3. 文件读取：`readBinaryFile`/`readTextFile` 通过 `base64 -w0 <file>` 解码；`fileInfo` 通过 `stat -c '%F|%s|%Y' `（注意 `%Y` 秒→ms，kind 映射 file/directory/symlink，不存在→`not_found`，`lstat` 语义按 d.ts 注释）；`openBinaryReader` 打开时一次性读入内存（上限 32MB，超出返回 `invalid`），`read`/`info`/`scanLines`（用 `LineScanner` from `@earendil-works/pi-durable/env`）在内存计算；目录 → `is_directory`。
4. 写：`writeFile` 先 `mkdir -p` 父目录，用 base64 经 bash 写入（`printf %s <b64> | base64 -d > file`；大文件分块 append，每块 ≤ 64KB 原文）。`appendFile`、`truncateFile`、`renameFile`、`remove`、`createDir`、`createTempDir`、`createTempFile`、`exists`、`canonicalPath`（`realpath -e`）、`absolutePath`/`joinPath`（纯函数，POSIX，相对路径基于 cwd）、`listDir`/`openDirReader`（`find <dir> -mindepth 1 -maxdepth 1 -printf ...`）、`flushFile`（`sync`）。`watch` 返回 `err(not_supported)` 除非一致性套件要求（若要求，用轮询实现）。错误码从 stderr 映射（No such file → not_found，Permission denied → permission_denied，Not a directory → not_directory，Is a directory → is_directory）。
5. `export function spaceEnv()` → `({cwd}) => new CuaEnv({cwd: cwd ?? config.spaceCwd})`；首次使用时确保 `config.spaceCwd` 目录存在。
6. `export function shellQuote(argv)`。

## 验收
- `npm test` 全绿（含你的 `test/env.test.mjs`：argv 转义——空格、单/双引号、`$`、反引号、换行、空串；错误码映射；absolutePath/joinPath）。
- `npx vitest run test/vitest/env-conformance.test.mjs` 通过（TEST-F03-0）。用 `registerEnvConformance({describe, expect, it}, "CuaEnv", async (use) => { 在 /tmp/conf-<rand> 下新建 CuaEnv 并 use(env)，结束后 rm -rf })`。若 symlinks/shell 选项需要，按 `dist/testing/types.d.ts` 传。两轮修不过的用例：在 `docs/fail-WP3.md` 记录并说明降级。
- `node scratch/env-demo.mjs`：在 `/home/cua/work/hello.txt` 写入当前日期，再读回打印；并打印 `docker exec tarsbot-probe cat /home/cua/work/hello.txt` 的结果一致（TEST-F03-1 预检）。

最后输出：改动文件、测试命令与结果（通过数/失败数）、未验证项。
