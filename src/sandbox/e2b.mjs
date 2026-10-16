// E2B shell primitive: `bash(command, {timeoutMs}) -> {stdout, stderr, exitCode, timedOut}`; SandboxEnv runs on top of it
// (alias `bash`/`info` below). Behaviour is dictated by the measurements in docs/e2b-probe.md and the e2b@2.56.0 types.
//  - One long-lived sandbox shared by all Bots, found by metadata {app, name}; created only by scripts/e2b-setup.sh.
//  - Persistence = E2B pause. The sandbox is created with lifecycle.onTimeout "pause"; when its timeout elapses it is
//    paused (filesystem + memory kept). `Sandbox.connect(id, {timeoutMs})` resumes a paused sandbox AND, for a running one,
//    only ever extends the timeout (never shortens it) - so calling it before a command is both "resume" and "keep alive".
//    The E2B timeout is absolute (not reset by activity), so we re-connect whenever the remaining time we know of would not
//    cover idleTimeoutMs / the command: timeout = max(idleTimeoutMs, commandTimeout + 60 s). Calls inside the known-alive
//    window skip the extra round trip (see `ensure`).
//  - SDK `commands.run` executes `/bin/bash -l -c <cmd>` (login bash, no extra wrapper). env.mjs scripts are POSIX sh, so
//    we pass `exec /bin/sh -c '<single-quoted command>'`: the command text is quoted, never spliced into other shell text,
//    and `exec` makes the process tree / exit status exactly that of `sh -c <command>`.
//  - Timeout: the SDK's commands.run defaults to 60 s and, on expiry, throws without killing the remote process. We always
//    pass an explicit timeoutMs (a bit larger than ours), run in background mode, enforce our own timer, and kill the pid.
//  - Non-zero exit: the SDK throws CommandExitError; converted into a normal result. A command killed by a signal comes
//    back with exitCode -1 (measured); it is mapped to 128+signal (137 for SIGKILL) like a normal shell would report.
//  - A single argv element is limited to 128 KB by the kernel ("fork/exec /bin/sh: argument list too long", measured at
//    200 KB). Scripts above LARGE_SCRIPT_BYTES are therefore written to a temp file with files.write and run from there.
//  - Hobby accounts cap the sandbox timeout at 1 h (setTimeout(24h) is accepted but endAt = now + 60 min), so the timeout we
//    ask for is clamped to maxTimeoutMs (default 1 h).
// Does not import config.mjs (it reads process.env directly, and stays usable from tests without a .env).

import { redactMessage } from "./sprites.mjs";

export { redactMessage };

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_CWD = "/home/user";
const DEFAULT_NAME = "pi-cloud-agents";
const APP = "pi-cloud-agents";
/** Extra sandbox lifetime beyond the command's own timeout. */
const MARGIN_MS = 60_000;
/** The SDK's own command timeout is set this much above ours so that our timer (which kills the pid) always fires first. */
const SDK_SLACK_MS = 30_000;
/** How long to wait for kill() / the final drain after a timeout. */
const KILL_WAIT_MS = 5000;
/** Above this many bytes the script is uploaded instead of passed as argv (kernel limit is 128 KB per argument). */
const LARGE_SCRIPT_BYTES = 100_000;
const DEFAULT_MAX_TIMEOUT_MS = 3_600_000;
/** Longest SDK error text we put into our own errors. */
const MAX_ERROR_CHARS = 400;

const SIGNALS = { hangup: 1, interrupt: 2, quit: 3, "illegal instruction": 4, aborted: 6, killed: 9, "segmentation fault": 11, terminated: 15 };
/** Exit codes < 0 mean "killed by a signal" (measured: `kill -9 $$` -> -1, error "signal: killed"). */
function normalizeExitCode(code, error) {
  if (Number.isInteger(code) && code >= 0) return code;
  const m = /signal:\s*([a-z ]+)/i.exec(String(error ?? ""));
  const n = m ? SIGNALS[m[1].trim().toLowerCase()] : undefined;
  return 128 + (n ?? 9);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const errName = (e) => String(e?.name ?? e?.constructor?.name ?? "");
const isNotFound = (e) => /^(SandboxNotFoundError|NotFoundError)$/.test(errName(e));
const isExitError = (e) => errName(e) === "CommandExitError";
const isTimeout = (e) => errName(e) === "TimeoutError";

/** Single-quote for POSIX sh. */
const shQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/**
 * Find the shared sandbox by metadata (running or paused), connect to it (resuming it when paused) and return the SDK
 * Sandbox instance; null when there is none.
 */
export async function findE2bSandbox({ Sandbox, apiKey, name = DEFAULT_NAME, timeoutMs = DEFAULT_IDLE_MS } = {}) {
  const paginator = Sandbox.list({ apiKey, query: { metadata: { app: APP, name }, state: ["running", "paused"] }, limit: 10 });
  const found = [];
  while (true) {
    found.push(...(await paginator.nextItems()));
    if (!paginator.hasNext) break;
  }
  if (found.length === 0) return null;
  // Several matches should not happen; prefer a running one, then the most recently started.
  found.sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || new Date(b.startedAt) - new Date(a.startedAt));
  try {
    return await Sandbox.connect(found[0].sandboxId, { apiKey, timeoutMs });
  } catch (e) {
    if (isNotFound(e)) return null; // vanished between list and connect
    throw e;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.Sandbox e2b `Sandbox` class (or a fake with list/connect)
 * @param {string} opts.apiKey
 * @param {string} [opts.name] sandbox metadata name (default "pi-cloud-agents")
 * @param {number} [opts.idleTimeoutMs] sandbox timeout before auto-pause (default 10 min)
 * @param {Record<string,string>} [opts.env] per-command envs (e.g. {GH_TOKEN}); never persisted in the sandbox
 * @param {string[]} [opts.secrets] extra values to redact from errors (apiKey and env values are always redacted)
 * @param {number} [opts.defaultTimeoutMs] used when a call passes no timeoutMs (default 10 min)
 * @param {string} [opts.cwd] default /home/user
 * @param {(entry: object) => void} [opts.log] receives {commandLength, ms, exitCode, retries, outcome, resumed}
 * @param {number} [opts.retryDelayMs]
 * @param {number} [opts.maxTimeoutMs] upper bound for the sandbox timeout we request (default 1 h, the Hobby limit)
 */
export function createE2bBash({
  Sandbox,
  apiKey,
  name = DEFAULT_NAME,
  template, // informational only: runtime never creates sandboxes
  idleTimeoutMs = DEFAULT_IDLE_MS,
  env = {},
  secrets = [],
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  cwd = DEFAULT_CWD,
  log = () => {},
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
} = {}) {
  void template;
  if (!Sandbox || typeof Sandbox.connect !== "function" || typeof Sandbox.list !== "function") {
    throw new TypeError("createE2bBash requires a Sandbox class with list() and connect()");
  }
  if (typeof apiKey !== "string" || !apiKey) throw codedError("E2B_CONFIG", "E2B_API_KEY is not set (put it in .env)");

  const redactList = [apiKey, ...Object.values(env), ...secrets].filter((v) => typeof v === "string");
  const redact = (m) => redactMessage(m, redactList);
  // SDK errors can embed the whole command ("error starting process '/bin/bash -l -c <script>'"): callers pass the
  // texts to hide; the rest is truncated.
  const msgOf = (e, hide = []) => {
    let t = String(e?.message ?? e);
    for (const h of hide) if (typeof h === "string" && h.length >= 8) t = t.split(h).join("<command>");
    t = t.replace(/\s+/g, " ");
    return t.length > MAX_ERROR_CHARS ? `${t.slice(0, MAX_ERROR_CHARS)}...` : t;
  };
  const fail = (code, message) => codedError(code, redact(message));
  const envs = Object.keys(env).length ? { ...env } : undefined;

  let sandbox; // cached SDK instance
  let aliveUntil = 0; // ms epoch until which we know the sandbox timeout covers
  let finding; // in-flight first lookup, shared by concurrent callers

  const missing = () =>
    fail("E2B_SANDBOX_MISSING", `E2B sandbox "${name}" (metadata app=${APP}) not found; run scripts/e2b-setup.sh to create it`);

  /** Ensure `sandbox` is running and lives at least `needMs` more. Returns true when it had to (re)connect. */
  async function ensure(needMs) {
    const now = Date.now();
    // When the command needs more than the platform allows we cannot cover it anyway; just keep at least half a window.
    const required = needMs > maxTimeoutMs ? maxTimeoutMs / 2 : needMs;
    if (sandbox && aliveUntil - now >= required) return false;
    const timeoutMs = Math.min(Math.max(idleTimeoutMs, needMs), maxTimeoutMs);
    if (!sandbox) {
      finding ??= findE2bSandbox({ Sandbox, apiKey, name, timeoutMs }).finally(() => {
        finding = undefined;
      });
      const found = await finding;
      if (!found) throw missing();
      sandbox = found;
    } else {
      try {
        sandbox = await Sandbox.connect(sandbox.sandboxId, { apiKey, timeoutMs });
      } catch (e) {
        sandbox = undefined;
        aliveUntil = 0;
        if (isNotFound(e)) throw missing();
        throw e;
      }
    }
    aliveUntil = Date.now() + timeoutMs;
    return true;
  }

  const forget = () => {
    sandbox = undefined;
    aliveUntil = 0;
  };

  return async function e2bBashRun(command, { timeoutMs } = {}) {
    if (typeof command !== "string") throw new TypeError("command must be a string");
    const started = Date.now();
    const budget = timeoutMs ?? defaultTimeoutMs;
    const deadline = started + budget;
    let retries = 0;
    let resumed = false;
    const note = (outcome, exitCode) => {
      try {
        log({ commandLength: command.length, ms: Date.now() - started, exitCode, retries, outcome, resumed });
      } catch {
        // logging must never break a call
      }
    };
    const inline = `exec /bin/sh -c ${shQuote(command)}`;
    const large = Buffer.byteLength(inline) > LARGE_SCRIPT_BYTES;
    const remotePath = large ? `/tmp/.pca-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.sh` : undefined;
    const script = large ? `/bin/sh ${remotePath}; rc=$?; rm -f ${remotePath}; exit $rc` : inline;

    /** One attempt. Returns {kind:"done"|"timeout", ...} or throws {phase:"start"|"run", error}. */
    async function attempt(remaining) {
      let handle;
      try {
        const reconnected = await ensure(remaining + MARGIN_MS);
        resumed ||= reconnected;
        if (large) await sandbox.files.write(remotePath, command);
        handle = await sandbox.commands.run(script, {
          background: true,
          cwd,
          envs,
          timeoutMs: remaining + SDK_SLACK_MS,
        });
      } catch (e) {
        throw { phase: "start", error: e };
      }

      let timer;
      let timedOut = false;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, Math.max(0, remaining));
      });
      const finished = handle.wait().then(
        (r) => ({ exitCode: r.exitCode }),
        (e) => (isExitError(e) ? { exitCode: normalizeExitCode(e.exitCode, e.error) } : { error: e }),
      );
      const first = await Promise.race([finished, timeout.then(() => "timeout")]);
      clearTimeout(timer);

      if (first === "timeout" || timedOut) {
        // Kill the remote process (SDK timeouts do not), then give the stream a moment to deliver what was produced.
        await Promise.race([handle.kill().catch(() => {}), sleep(KILL_WAIT_MS)]);
        await Promise.race([finished, sleep(KILL_WAIT_MS)]);
        return { kind: "timeout", stdout: handle.stdout ?? "", stderr: handle.stderr ?? "" };
      }
      if (first.error) {
        if (isTimeout(first.error) && Date.now() >= deadline - 1000) {
          await Promise.race([handle.kill().catch(() => {}), sleep(KILL_WAIT_MS)]);
          return { kind: "timeout", stdout: handle.stdout ?? "", stderr: handle.stderr ?? "" };
        }
        throw { phase: "run", error: first.error };
      }
      return { kind: "done", exitCode: first.exitCode, stdout: handle.stdout ?? "", stderr: handle.stderr ?? "" };
    }

    let r;
    for (;;) {
      try {
        r = await attempt(Math.max(0, deadline - Date.now()));
        break;
      } catch (f) {
        const e = f?.error ?? f;
        if (f?.phase === "start") {
          forget();
          if (e?.code === "E2B_SANDBOX_MISSING" || (isNotFound(e) && retries > 0)) {
            note("error");
            throw e?.code ? e : missing();
          }
          if (retries === 0) {
            // The command never started -> safe to retry exactly once (re-resolves / resumes the sandbox).
            retries = 1;
            await sleep(retryDelayMs);
            if (deadline - Date.now() <= 0) {
              note("timeout");
              return { stdout: "", stderr: "", timedOut: true };
            }
            continue;
          }
          note("error");
          throw e?.code === "E2B_CONFIG" ? e : fail("E2B_CONNECT_FAILED", `E2B sandbox could not be reached after 1 retry: ${msgOf(e, [command, inline, script])}`);
        }
        note("error");
        forget();
        throw fail("E2B_CONNECTION_ENDED", `E2B command connection error after start; command may or may not have run: ${msgOf(e, [command, inline, script])}`);
      }
    }

    if (r.kind === "timeout") {
      note("timeout");
      return { stdout: r.stdout, stderr: r.stderr, timedOut: true };
    }
    note("ok", r.exitCode);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: false };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Production instance (lazy, one per process)

let prod;

async function getProd() {
  if (prod) return prod;
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw codedError("E2B_CONFIG", "E2B_API_KEY is not set (put it in .env)");
  const { Sandbox } = await import("e2b");
  const gh = process.env.GITHUB_TOKEN;
  const idle = Number(process.env.TARSBOT_E2B_IDLE_MS);
  prod = createE2bBash({
    Sandbox,
    apiKey,
    name: process.env.TARSBOT_E2B_NAME || DEFAULT_NAME,
    idleTimeoutMs: Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_IDLE_MS,
    env: gh ? { GH_TOKEN: gh } : {},
    log: process.env.TARSBOT_E2B_LOG ? (e) => console.error(`[e2b] ${JSON.stringify(e)}`) : undefined,
  });
  return prod;
}

/** Run a shell command in the E2B sandbox. Returns { stdout, stderr, exitCode, timedOut }. */
export async function e2bBash(command, { timeoutMs } = {}) {
  return (await getProd())(command, { timeoutMs });
}

/** For /api/space: never contains a key. */
export function getE2bInfo() {
  return { sandbox: "e2b", name: process.env.TARSBOT_E2B_NAME || DEFAULT_NAME };
}

/** Provider interface (docs/CLOUD-PLAN.md §3): `bash` and `info`. */
export { e2bBash as bash, getE2bInfo as info };
