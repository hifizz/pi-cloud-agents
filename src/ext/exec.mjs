// Runner-backed `bash` tool (M1-06). Replaces the built-in `bash` (installed after CodingTools: last registration wins, probe A1).
//
// Why this exists: the built-in bash is `replay: "unsafe"` and runs through `api.env.exec`; a safe replay of that would run the
// shell command a second time. Here every command is a detached runner execution (src/runner) identified by a run id derived
// from the TASK id, so re-entering `execute` after a crash re-attaches to the same process instead of starting another one.
//
// Fixed order of `execute` (every step happens before the remote is touched; see docs/M1-PLAN.md section 3.3 / 4.5):
//   1. resolve conversation -> workspace -> active binding -> runner (no workspace: error, NEVER a fallback to api.env.exec)
//   2. memo "exec" pins { runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash }; first write wins, so a replay reads
//      the ORIGINAL intent back. All later decisions use the memo values, not freshly computed ones.
//   3. re-check the control store: the pinned binding must still be the active one and the command must be the same one;
//      otherwise "result unconfirmed" and nothing is prepared / started / killed.
//   4. claim in the control store; only a fresh claim may prepare + start. An existing claim only queries the runner.
//   5. follow the log from byte 0 (a safe re-entry starts with empty progress, so the whole log is re-emitted).
//   6. timeout / user abort -> runner.kill; "stop unconfirmed" is reported as such, never as "stopped".
//
// Nothing here reads or forwards environment values directly: GH_TOKEN etc. travel in the provider's bash exec
// environment and are inherited by the runner-started process. Loop sessions pass `execEnv` through the resolver
// (currently {GH_TOKEN: ""}) — `prepare` stages only the NAMES; values are injected at `start` via the
// supportsEnv-capable bash primitive, never written to a file.
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { RunnerError, commandHash, runIdFor, sha256Hex } from "../runner/client.mjs";

export const EXEC_MEMO = "exec";
const START_MEMO = "exec.start";
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const ABORTED = Symbol("aborted");

const DESCRIPTION =
  "Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. If a result says 结果待确认 / result unconfirmed, the command may already have run: check the actual state instead of re-running it.";

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

/** Resolver installed by the server: `({ conversationId }) -> { store, runner, workspace, binding } | undefined`. */
let currentResolver;

/** Install the conversation -> workspace -> runner resolver used by the default `Exec` extension. */
export function setExecResolver(fn) {
  if (fn !== undefined && fn !== null && typeof fn !== "function") throw new TypeError("setExecResolver requires a function");
  currentResolver = fn ?? undefined;
}

function validateTimeout(timeout) {
  if (timeout === undefined) return;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  if (timeout > MAX_TIMEOUT_SECONDS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
}

/** Short, single-line error text; never includes anything but the error's own message. */
function brief(e) {
  const text = String(e?.message ?? e ?? "").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * True when the failure proves that nothing was claimed / started: bad input rejected by the client before any exec, or a
 * definite `error=` answer of the runner. Connection errors, timeouts and generic non-zero exits are NOT definite.
 */
function isDefiniteFailure(e) {
  if (e instanceof TypeError || e instanceof RangeError) return true;
  if (!(e instanceof RunnerError) || e.outcomeUnknown) return false;
  return !e.code.startsWith("RUNNER_") || e.code === "RUNNER_STAGE_FAILED";
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function storeResolver({ store, runnerFor }) {
  return ({ conversationId }) => {
    const workspace = store.links.workspaceOf(String(conversationId));
    if (!workspace) return undefined;
    const binding = store.bindings.current(workspace.id);
    if (!binding) return { store, workspace, binding: undefined, runner: undefined };
    return { store, workspace, binding, runner: runnerFor({ workspace, binding }) };
  };
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.resolve] `({conversationId}) -> {store, runner, workspace, binding} | undefined` (default: the one set by setExecResolver)
 * @param {object} [opts.store] control store; with `runnerFor`, builds the resolver itself (tests)
 * @param {(x: {workspace: object, binding: object}) => object} [opts.runnerFor]
 * @param {() => number} [opts.now] clock for the timeout deadline (default: the Harness clock)
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [opts.sleep] backoff sleep
 * @param {number} [opts.retryBudgetMs] how long a failing `wait` is retried (default 60 s)
 * @param {number} [opts.waitSeconds] longest single runner wait (default 25)
 * @param {number} [opts.graceSeconds] SIGTERM grace before SIGKILL on stop (default 5)
 */
export function createExec(opts = {}) {
  const resolve =
    opts.resolve ?? (opts.store && opts.runnerFor ? storeResolver(opts) : (target) => (currentResolver ? currentResolver(target) : undefined));
  const sleep = opts.sleep ?? abortableSleep;
  const retryBudgetMs = opts.retryBudgetMs ?? 60_000;
  const waitSeconds = opts.waitSeconds ?? 25;
  const graceSeconds = opts.graceSeconds ?? 5;

  const tool = defineTool({
    name: "bash",
    description: DESCRIPTION,
    parameters: bashSchema,
    replay: "safe",
    outputLimits: { retain: "tail" },
    async execute(args, api, context) {
      validateTimeout(args.timeout);
      const command = args.command;
      const signal = context.abortSignal;
      const clock = opts.now ?? (() => api.now());

      // ---- 1. resolve (no fallback to api.env.exec, ever) ------------------------------------------------------------
      // A replay of a call that already pinned its intent must never end as a hard failure just because the world is
      // briefly unresolvable now (resolver installed a moment late, binding missing during a rebuild): the command may
      // have started, so the honest answer is "result unconfirmed". The read-only memo lookup tells the two cases apart.
      const conversationId = String(api.conversationId);
      const earlier = await api.memo(EXEC_MEMO, context);
      const cannotRun = (reason) => {
        if (earlier !== undefined) {
          return {
            isError: true,
            details: { runId: earlier.runId, state: "claimed", exit: null, offset: 0 },
            diagnostics: [
              {
                severity: "error",
                code: "result_unconfirmed",
                message: `结果待确认：${reason}。命令可能已经执行（或仍在运行），不会自动重新运行。请先检查实际状态再决定下一步。 (result unconfirmed: the command may have run; verify before retrying)`,
              },
            ],
          };
        }
        throw new Error(`bash 不可用：${reason}。不会回退到本地环境。`);
      };
      if (!currentResolver && !opts.resolve && !(opts.store && opts.runnerFor)) {
        return cannotRun("执行解析器尚未设置（Exec resolver not installed）");
      }
      const resolved = await resolve({ conversationId });
      if (!resolved) return cannotRun(`会话 ${conversationId} 没有关联工作区（no workspace for this conversation）`);
      const { store, runner, workspace, binding, execEnv } = resolved;
      if (!store || !workspace || !runner || !binding) {
        return cannotRun(`工作区 ${workspace?.id ?? "(未知)"} 没有可用的运行环境绑定（no active runtime binding）`);
      }
      const agent = await api.agent(context);
      const cwd = agent.cwd ?? workspace.cwd;
      if (typeof cwd !== "string" || !cwd.startsWith("/")) return cannotRun(`工作目录无效（${String(cwd)}）`);

      // ---- 2. pin the intent ----------------------------------------------------------------------------------------
      const namespace = store.meta.get("namespace");
      const generation = store.meta.get("generation");
      if (namespace === undefined || generation === undefined) throw new Error("bash 不可用：控制库缺少 namespace / generation。");
      const candidate = {
        runId: runIdFor({ namespace, generation, taskId: api.taskId }),
        workspaceId: workspace.id,
        runtimeId: binding.runtimeId,
        bindingVersion: binding.version,
        cwd,
        commandHash: commandHash(command, cwd),
      };
      const pinned = await api.memo(EXEC_MEMO, candidate, context);
      const runId = pinned.runId;
      const info = { runId, state: "claimed", exit: null, offset: 0 };
      const detailsNow = () => ({ runId: info.runId, state: info.state, exit: info.exit, offset: info.offset });
      const report = async () => {
        try {
          await api.details(detailsNow(), context);
        } catch {
          // progress is best-effort; an aborted invocation rejects here
        }
      };
      const mark = (patch) => {
        try {
          store.executions.update(runId, patch);
        } catch {
          // bookkeeping only; the runner is the source of truth
        }
      };
      /** "Result unconfirmed": the command may have run (or still run). Nothing is retried or restarted. */
      const unconfirmed = (reason, patch) => {
        if (patch) mark(patch);
        return {
          isError: true,
          details: detailsNow(),
          diagnostics: [
            {
              severity: "error",
              code: "result_unconfirmed",
              message: `结果待确认：${reason}。命令可能已经执行（或仍在运行），不会自动重新运行。请先检查实际状态再决定下一步。 (result unconfirmed: the command may have run; verify before retrying)`,
            },
          ],
        };
      };

      // ---- 3. is it still the same intent against the same runtime? -------------------------------------------------
      if (commandHash(command, pinned.cwd) !== pinned.commandHash) {
        return unconfirmed("重放时的命令与最初记录的不一致");
      }
      const current = store.bindings.current(pinned.workspaceId);
      if (
        !current ||
        current.runtimeId !== pinned.runtimeId ||
        current.version !== pinned.bindingVersion ||
        binding.runtimeId !== pinned.runtimeId ||
        binding.version !== pinned.bindingVersion
      ) {
        return unconfirmed(`工作区运行环境已变更（命令发出时为绑定 v${pinned.bindingVersion}，现为 ${current ? `v${current.version}` : "无"}）`);
      }
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");

      const startedAt = await api.memo(START_MEMO, clock(), context);
      const deadline = args.timeout === undefined ? Number.POSITIVE_INFINITY : startedAt + args.timeout * 1000;

      // ---- 4. claim; only a fresh claim may start --------------------------------------------------------------------
      const { execution, created } = store.executions.claim({
        runId,
        workspaceId: pinned.workspaceId,
        runtimeId: pinned.runtimeId,
        bindingVersion: pinned.bindingVersion,
        cwd: pinned.cwd,
        commandHash: pinned.commandHash,
      });
      if (!created) {
        if (
          execution.commandHash !== pinned.commandHash ||
          execution.runtimeId !== pinned.runtimeId ||
          execution.bindingVersion !== pinned.bindingVersion
        ) {
          return unconfirmed("控制库里该执行记录与最初记录的不一致");
        }
        let st;
        try {
          st = await runner.status(runId);
        } catch (e) {
          return unconfirmed(`无法查询运行状态（${brief(e)}）`);
        }
        if (st.cmdSha256 !== undefined && st.cmdSha256 !== sha256Hex(command)) {
          return unconfirmed("runner 上记录的命令与本次不一致", { state: "unknown" });
        }
        if (st.state !== "running" && st.state !== "exited") {
          return unconfirmed(`runner 上该执行的状态为 ${st.state}`, { state: st.state === "lost" ? "lost" : "unknown" });
        }
      } else {
        try {
          const p = await runner.prepare({ id: runId, cwd: pinned.cwd, command, ...(execEnv ? { env: execEnv } : {}) });
          if (p.prepared !== "new") {
            return unconfirmed("runner 上已存在同编号的执行（控制库记录与 runner 不一致）", { state: "unknown" });
          }
        } catch (e) {
          if (isDefiniteFailure(e)) throw new Error(`bash 未执行：runner prepare 失败（${brief(e)}）`);
          return unconfirmed(`runner prepare 状态不明（${brief(e)}）`, { state: "unknown" });
        }
        try {
          await runner.start(runId);
        } catch (e) {
          if (isDefiniteFailure(e)) throw new Error(`bash 未执行：runner start 失败（${brief(e)}）`);
          return unconfirmed(`runner start 状态不明（${brief(e)}）`, { state: "unknown" });
        }
        mark({ state: "started" });
      }

      // ---- 5. follow the log from byte 0 -----------------------------------------------------------------------------
      let from = 0;
      let lastReported;
      let failingSince;
      let backoff = 1000;
      let onAbort;
      const abortPromise = new Promise((res) => {
        if (!signal) return;
        onAbort = () => res(ABORTED);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });

      /** Ask the runner to stop the run. true only when the stop is confirmed. */
      const stop = async () => {
        try {
          const k = await runner.kill(runId, { graceSeconds });
          if (k.killed === "confirmed") return true;
        } catch {
          // fall through to a status check
        }
        try {
          return (await runner.status(runId)).state === "exited";
        } catch {
          return false;
        }
      };
      /** Best effort: emit what the command wrote before it stopped. */
      const drain = async () => {
        for (let i = 0; i < 4; i++) {
          try {
            const r = await runner.wait({ id: runId, from, maxSeconds: 1 });
            if (r.text) api.output(r.text);
            from = r.offset;
            info.offset = from;
            if (r.done || (r.state !== "running" && r.offset >= (r.size ?? 0))) return;
          } catch {
            return;
          }
        }
      };
      /** A user abort kills the run; a harness shutdown (close) leaves it running to be re-attached after restart. */
      const isUserAbort = async () => {
        try {
          const record = await api.getTask(api.taskId, withoutAbortSignal(context));
          return record?.abortRequested === true && record.abortReason === undefined;
        } catch {
          return false;
        }
      };
      const abortError = () => signal?.reason ?? new Error("Command aborted");

      try {
        for (;;) {
          if (signal?.aborted) return await handleAbort();
          const remainingMs = deadline - clock();
          if (remainingMs <= 0) return await handleTimeout();
          const maxSeconds = Number.isFinite(remainingMs) ? Math.max(1, Math.min(waitSeconds, Math.ceil(remainingMs / 1000))) : waitSeconds;

          let res;
          const pending = runner.wait({ id: runId, from, maxSeconds });
          pending.catch(() => {}); // an abandoned wait (abort) must not become an unhandled rejection
          try {
            res = await Promise.race([pending, abortPromise]);
            failingSince = undefined;
            backoff = 1000;
          } catch (e) {
            if (e instanceof TypeError || e instanceof RangeError) throw e;
            failingSince ??= Date.now();
            if (Date.now() - failingSince > retryBudgetMs) {
              return unconfirmed(`无法连接运行环境读取输出（${brief(e)}），命令仍可能在运行`, { state: "unknown" });
            }
            await Promise.race([sleep(backoff, signal), abortPromise]);
            backoff = Math.min(backoff * 2, 10_000);
            continue;
          }
          // Outside the try above: the abort handler's own throw must not be treated as a failed `wait`.
          if (res === ABORTED) return await handleAbort();

          if (res.text) api.output(res.text);
          from = res.offset;
          info.offset = from;
          info.state = res.state;
          if (res.exit !== undefined) info.exit = res.exit;
          if (lastReported !== res.state) {
            lastReported = res.state;
            await report();
          }

          if (res.state === "running") continue;
          if (res.state === "exited") {
            if (!res.done) continue; // more log to read
            if (res.exit === undefined) return unconfirmed("命令已结束但没有退出码", { state: "unknown" });
            mark({ state: "exited", exit: { code: res.exit } });
            if (res.exit === 0) return { details: detailsNow() };
            return {
              isError: true,
              details: detailsNow(),
              diagnostics: [{ severity: "error", code: "exit_code", message: `Command exited with code ${res.exit}` }],
            };
          }
          if (res.state === "lost" && res.offset < (res.size ?? 0)) continue; // read the rest of the log first
          return unconfirmed(
            res.state === "lost" ? "进程已不在但没有退出码" : `runner 上该执行的状态为 ${res.state}`,
            { state: res.state === "lost" ? "lost" : "unknown" },
          );
        }
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }

      async function handleTimeout() {
        const stopped = await stop();
        await drain();
        info.state = stopped ? "exited" : info.state;
        mark(stopped ? { state: "exited", exit: { killed: "timeout" } } : { state: "unknown" });
        await report();
        throw new Error(
          `Command timed out after ${args.timeout} seconds; ${stopped ? "已停止（进程组已确认终止）" : "停止待确认（进程可能仍在运行）"}`,
        );
      }

      async function handleAbort() {
        if (!(await isUserAbort())) {
          // The Harness is closing: keep the command running; a restart re-attaches by run id.
          throw abortError();
        }
        const stopped = await stop();
        await drain();
        mark(stopped ? { state: "exited", exit: { killed: "abort" } } : { state: "unknown" });
        api.diagnostic({
          severity: stopped ? "info" : "warn",
          code: stopped ? "stopped" : "stop_unconfirmed",
          message: stopped ? "已停止：中止时命令的进程组已确认终止" : "停止待确认：已请求终止，但无法确认进程已退出，它可能仍在运行",
        });
        throw abortError();
      }
    },
  });

  return defineExtension({ name: "tarsbot.exec", tools: [tool] });
}

/** Production extension: install AFTER CodingTools (same-name override of the built-in bash) and BEFORE Approval. */
export const Exec = createExec();
