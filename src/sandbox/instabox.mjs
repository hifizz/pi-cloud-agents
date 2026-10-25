// InstaBox (instabox.sh) shell primitive: `bash(command, {timeoutMs}) -> {stdout, stderr, exitCode, timedOut}`;
// SandboxEnv runs on top of it (alias `bash`/`info` below). Plain REST over fetch, no SDK dependency. Shapes verified
// against the live OpenAPI spec (GET https://api.instabox.sh/v1/openapi.json) and a real probe (docs/INSTABOX-PLAN.md §3):
//  - One long-lived machine shared by all Bots, found by name via GET /v1/machines/{idOrName}; created only by
//    scripts/instabox-setup.mjs (create takes `templateId` + `metadata` labels; free-plan keys may only use the
//    `agent-browser` template). Files under /data persist across stops and suspends; the guest user's home is /data/home.
//  - Persistence = auto-suspend (after ~30 idle minutes). exec on a suspended machine wakes it by itself. A 409
//    `machine_not_running` means stopped -> POST start (which resumes a paused machine and boots a stopped one); a 409
//    `operation_conflict` means an operation is in flight (e.g. idle suspend) -> POST wake, which waits it out. Both
//    are followed by one exec retry.
//  - exec is synchronous HTTP: POST /v1/machines/{id}/exec {cmd, cwd, envs, timeoutSeconds} -> ExecResult
//    {stdout, stderr, exitCode(124 if timed out), timedOut, truncated, signal?}. The platform runs `bash -lc <cmd>` as
//    the guest user, default cwd /data/home, kills the command at timeoutSeconds (1..600) and caps cmd at 64 KiB
//    (env.mjs writes files in 12 KiB base64 chunks, so its commands stay far below). env.mjs scripts are POSIX sh, so
//    the command goes as `exec /bin/sh -c '<single-quoted>'` (same wrapper as e2b.mjs: the text is quoted, never
//    spliced, and `exec` keeps the process tree / exit status exactly that of `sh -c <command>`).
//  - Mutating endpoints answer 202 with the bare Operation object ({id, state: queued|running|succeeded|failed,
//    machine?}) and need an Idempotency-Key header (random UUID per call); exec, wake and GETs do not. Operations are
//    polled at GET /v1/operations/{id}?wait=25s (only succeeded/failed are terminal).
//  - Our own AbortController sits budget + HTTP_SLACK_MS above the server-side kill: a transport loss before the
//    response means the command may or may not have run (INSTABOX_CONNECTION_ENDED, never retried). Only failures that
//    provably precede the request (ECONNREFUSED / ENOTFOUND / EAI_AGAIN, or a failure while resolving the machine)
//    are retried, exactly once.
//  - Errors are {"error":{"code","message"}} with codes like not_found / machine_not_running / operation_conflict;
//    every thrown message is redacted (key/env/secrets -> ***) and truncated.
// Does not import config.mjs (it reads process.env directly, and stays usable from tests without a .env).

import { randomUUID } from "node:crypto";
import { redactMessage } from "./sprites.mjs";

export { redactMessage };

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_CWD = "/data/home";
const DEFAULT_NAME = "pi-cloud-agents";
const DEFAULT_BASE_URL = "https://api.instabox.sh";
const DEFAULT_RETRY_DELAY_MS = 1000;
/** exec kills the command server-side at `timeoutSeconds` (max 600 s); our client abort sits this far above it. */
export const HTTP_SLACK_MS = 90_000;
/** Longest we allow a start operation (auto-suspend wake-up) to take. */
const DEFAULT_START_TIMEOUT_MS = 180_000;
/** operations are long-polled server-side (?wait=25s); give each poll a little more than that client-side. */
const OP_WAIT = "25s";
const OP_POLL_HTTP_MS = 35_000;
const TERMINAL_OP_STATES = new Set(["succeeded", "failed", "canceled"]);
/** fetch failure causes that provably happen before any request reached the server -> safe to retry. */
const PRE_SEND_NET_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
/** The platform caps exec's timeoutSeconds at 600. */
export const MAX_EXEC_SECONDS = 600;
/** The platform rejects exec bodies whose `cmd` exceeds 64 KiB (OpenAPI: maxLength 65536). */
export const MAX_CMD_BYTES = 65_536;
/** Longest API error text we put into our own errors. */
const MAX_ERROR_CHARS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Single-quote for POSIX sh. */
const shQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/** API error: `status` is the HTTP status, `apiCode` the platform's error code (e.g. machine_not_running). */
function apiError(status, apiCode, message) {
  const e = new Error(message);
  e.code = "INSTABOX_API";
  e.status = status;
  e.apiCode = apiCode;
  return e;
}

/** Transport error (fetch rejected). `preSend` marks failures that provably precede any request reaching the server. */
function transportError(err) {
  const cause = err?.cause ?? err;
  const aborted = err?.name === "AbortError" || cause?.name === "AbortError";
  const netCode = typeof cause?.code === "string" ? cause.code : undefined;
  const e = new Error(`InstaBox API unreachable: ${String(cause?.message ?? cause)}`);
  e.code = "INSTABOX_NETWORK";
  e.aborted = aborted;
  e.netCode = netCode;
  e.preSend = !aborted && PRE_SEND_NET_CODES.has(netCode);
  return e;
}

const opErrorText = (op) => String(op?.error?.message ?? op?.error ?? "unknown error");

/**
 * Low-level InstaBox API client shared by the bash primitive, `findInstaboxMachine` and scripts/instabox-setup.mjs.
 * Returns `{ call, getMachine, listMachines, createMachine, startMachine, deleteMachine, exec, waitOperation }`.
 */
export function instaboxApi({ fetchImpl = fetch, apiKey, baseUrl = DEFAULT_BASE_URL } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("instaboxApi requires a fetch implementation");
  if (typeof apiKey !== "string" || !apiKey) throw codedError("INSTABOX_CONFIG", "INSTABOX_API_KEY is not set (put it in .env)");
  const base = String(baseUrl).replace(/\/+$/, "");

  async function call(pathname, { method = "GET", body, idempotencyKey, signal } = {}) {
    const headers = { "x-api-key": apiKey };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let res;
    try {
      res = await fetchImpl(base + pathname, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e?.code === "INSTABOX_API" || e?.code === "INSTABOX_NETWORK") throw e;
      throw transportError(e);
    }
    let text = "";
    try {
      text = await res.text();
    } catch (e) {
      const t = transportError(e); // headers were received: the request definitely reached the server
      t.preSend = false;
      throw t;
    }
    let json;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw apiError(res.status, "malformed_response", `InstaBox API returned non-JSON (${res.status})`);
      }
    } else json = {};
    if (!res.ok) {
      throw apiError(
        res.status,
        String(json?.error?.code ?? `http_${res.status}`),
        String(json?.error?.message ?? json?.message ?? (res.statusText || "request failed")),
      );
    }
    return json;
  }

  const enc = encodeURIComponent;
  return {
    call,
    getMachine: (idOrName) => call(`/v1/machines/${enc(idOrName)}`),
    listMachines: (query) => call(`/v1/machines${query ? `?${query}` : ""}`),
    listTemplates: () => call("/v1/templates"),
    createMachine: (body) => call("/v1/machines", { method: "POST", body, idempotencyKey: randomUUID() }),
    startMachine: (id) => call(`/v1/machines/${enc(id)}/start`, { method: "POST", idempotencyKey: randomUUID() }),
    // wake: records activity / waits (<= 45 s) for an in-flight idle-suspend + auto-resume; no Idempotency-Key.
    wake: (id) => call(`/v1/machines/${enc(id)}/wake`, { method: "POST" }),
    deleteMachine: (id) => call(`/v1/machines/${enc(id)}`, { method: "DELETE", idempotencyKey: randomUUID() }),
    exec: (id, body, signal) => call(`/v1/machines/${enc(id)}/exec`, { method: "POST", body, signal }),
    waitOperation: (ref, opts) => waitOperation({ call }, ref, opts),
  };
}

/**
 * Poll an operation (the 202 body of a mutating endpoint) until it reaches a terminal state.
 * Returns the terminal operation (which on success carries `machine`); throws INSTABOX_OPERATION_TIMEOUT otherwise.
 */
export async function waitOperation(client, ref, { timeoutMs = DEFAULT_START_TIMEOUT_MS, pollHttpMs = OP_POLL_HTTP_MS } = {}) {
  const first = ref?.operation ?? ref;
  const opId = ref?.operationId ?? first?.operationId ?? first?.id;
  if (!opId) throw codedError("INSTABOX_API", "operation response carries no operationId");
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (end - Date.now() <= 0) {
      throw codedError("INSTABOX_OPERATION_TIMEOUT", `operation ${opId} did not finish within ${timeoutMs} ms`);
    }
    const op = await client.call(`/v1/operations/${encodeURIComponent(opId)}?wait=${OP_WAIT}`, {
      signal: AbortSignal.timeout(Math.min(pollHttpMs, end - Date.now() + 5_000)),
    });
    const body = op?.operation ?? op;
    if (TERMINAL_OP_STATES.has(body?.state)) return body;
    // non-terminal: the server already long-polled ~25 s, go around again
  }
}

/** API 404s: the spec's error enum has `not_found`; machine routes may also phrase it `machine_not_found`. */
const isNotFoundApi = (e) => e?.code === "INSTABOX_API" && (e.apiCode === "machine_not_found" || e.apiCode === "not_found" || e.status === 404);

/**
 * Find the machine by name (any state). Returns the machine object, or null when it does not exist.
 */
export async function findInstaboxMachine({ fetchImpl = fetch, apiKey, baseUrl, name = DEFAULT_NAME } = {}) {
  const client = instaboxApi({ fetchImpl, apiKey, baseUrl });
  try {
    return await client.getMachine(name);
  } catch (e) {
    if (isNotFoundApi(e)) return null;
    throw e;
  }
}

/**
 * @param {object} opts
 * @param {typeof fetch} [opts.fetchImpl] fetch (or a fake) used for every call
 * @param {string} opts.apiKey InstaBox API key
 * @param {string} [opts.baseUrl] default https://api.instabox.sh (INSTABOX_BASE_URL for probes/tests)
 * @param {string} [opts.name] machine name (default "pi-cloud-agents")
 * @param {Record<string,string>} [opts.env] per-command envs (e.g. {GH_TOKEN}); never written to the machine
 * @param {string[]} [opts.secrets] extra values to redact from errors (apiKey and env values are always redacted)
 * @param {number} [opts.defaultTimeoutMs] used when a call passes no timeoutMs (default 10 min)
 * @param {string} [opts.cwd] default /data/home
 * @param {(entry: object) => void} [opts.log] receives {commandLength, ms, exitCode, retries, outcome, woke, truncated}
 * @param {number} [opts.retryDelayMs]
 * @param {number} [opts.startTimeoutMs] how long a stopped machine may take to start (default 3 min)
 */
export function createInstaboxBash({
  fetchImpl = fetch,
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  name = DEFAULT_NAME,
  env = {},
  secrets = [],
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  cwd = DEFAULT_CWD,
  log = () => {},
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createInstaboxBash requires a fetch implementation");
  if (typeof name !== "string" || !name) throw new TypeError("createInstaboxBash requires a machine name");
  if (typeof apiKey !== "string" || !apiKey) throw codedError("INSTABOX_CONFIG", "INSTABOX_API_KEY is not set (put it in .env)");

  const client = instaboxApi({ fetchImpl, apiKey, baseUrl });
  const redactList = [apiKey, ...Object.values(env), ...secrets].filter((v) => typeof v === "string");
  const redact = (m) => redactMessage(m, redactList);
  // API errors can echo the request body (i.e. the command text); callers pass the texts to hide; the rest is truncated.
  const msgOf = (e, hide = []) => {
    let t = String(e?.message ?? e);
    for (const h of hide) if (typeof h === "string" && h.length >= 8) t = t.split(h).join("<command>");
    t = t.replace(/\s+/g, " ");
    return t.length > MAX_ERROR_CHARS ? `${t.slice(0, MAX_ERROR_CHARS)}...` : t;
  };
  const fail = (code, message) => codedError(code, redact(message));
  const envs = Object.keys(env).length ? { ...env } : undefined;

  let machineId; // cached machine id (stable across stops/suspends; changes when the machine is recreated)
  let resolving; // in-flight name lookup, shared by concurrent callers

  async function resolve() {
    if (machineId) return machineId;
    resolving ??= client
      .getMachine(name)
      .then((m) => {
        if (typeof m?.id !== "string" || !m.id) throw apiError(0, "malformed_response", "machine response carries no id");
        machineId = m.id;
        return m.id;
      })
      .finally(() => {
        resolving = undefined;
      });
    try {
      return await resolving;
    } catch (e) {
      if (isNotFoundApi(e)) {
        throw codedError("INSTABOX_SANDBOX_MISSING", `InstaBox machine "${name}" not found; run scripts/instabox-setup.mjs to create it`);
      }
      throw e;
    }
  }

  const forget = () => {
    machineId = undefined;
  };

  /** Poll the machine until it is running again (an operation is already in flight; wake/start answered a conflict). */
  async function waitUntilRunning(id, timeoutMs = startTimeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const m = await client.getMachine(id);
      if (m?.state === "running") return true;
      if (m?.state === "error" || m?.state === "deleted") {
        throw codedError("INSTABOX_START_FAILED", `machine "${name}" is in state "${m.state}"`);
      }
      await sleep(2000);
    }
    throw codedError("INSTABOX_OPERATION_TIMEOUT", `machine "${name}" did not return to running within ${timeoutMs} ms`);
  }

  /**
   * Bring a machine back to running. `machine_not_running` -> start (resumes a paused machine, boots a stopped one);
   * `operation_conflict` -> wake (waits out an in-flight idle-suspend + auto-resume). If either answers another
   * operation_conflict, something else is already in flight: poll the machine until it settles.
   */
  async function ensureAwake(id, cause) {
    let ref;
    try {
      ref = await (cause === "operation_conflict" ? client.wake(id) : client.startMachine(id));
    } catch (e) {
      if (e?.code === "INSTABOX_API" && e.apiCode === "operation_conflict") {
        await waitUntilRunning(id); // another operation is already in flight; let it settle
        return;
      }
      throw e;
    }
    if (ref && (typeof ref.id === "string" || typeof ref.state === "string")) {
      const done = await client.waitOperation(ref, { timeoutMs: startTimeoutMs });
      if (done.state !== "succeeded") {
        throw codedError("INSTABOX_START_FAILED", `waking machine "${name}" failed: ${opErrorText(done)}`);
      }
      return;
    }
    await waitUntilRunning(id); // wake may answer with the machine instead of an operation
  }

  return async function instaboxBashRun(command, { timeoutMs } = {}) {
    if (typeof command !== "string") throw new TypeError("command must be a string");
    const started = Date.now();
    const budget = timeoutMs ?? defaultTimeoutMs;
    const deadline = started + budget;
    let retries = 0;
    let woke = false;
    const note = (outcome, exitCode, truncated = false) => {
      try {
        log({ commandLength: command.length, ms: Date.now() - started, exitCode, retries, outcome, woke, truncated });
      } catch {
        // logging must never break a call
      }
    };
    const wrapped = `exec /bin/sh -c ${shQuote(command)}`;
    const wrappedBytes = Buffer.byteLength(wrapped);
    if (wrappedBytes > MAX_CMD_BYTES) {
      // The platform rejects exec bodies above 64 KiB (OpenAPI maxLength); fail before any network call.
      throw codedError(
        "INSTABOX_COMMAND_TOO_LARGE",
        `Command is too large for an InstaBox exec (${wrappedBytes} bytes > ${MAX_CMD_BYTES}); the API caps cmd at 64 KiB. Send large data in smaller pieces.`,
      );
    }

    /**
     * One exec attempt. Resolves the exec response; throws tagged {phase, error}:
     *   phase "start"  – the command provably never started (resolve failed / pre-send transport / exec 404 / 409)
     *   phase "run"    – the command may or may not have run (transport loss or 5xx after the request was sent)
     *   phase "fatal"  – waking the machine itself failed; never retried
     */
    async function attempt(remaining) {
      let id;
      try {
        id = await resolve();
      } catch (e) {
        throw { phase: "start", error: e };
      }
      const timeoutSeconds = Math.min(MAX_EXEC_SECONDS, Math.max(1, Math.ceil(remaining / 1000)));
      let res;
      try {
        res = await client.exec(
          id,
          { cmd: wrapped, cwd, envs, timeoutSeconds },
          AbortSignal.timeout(remaining + HTTP_SLACK_MS),
        );
      } catch (e) {
        if (e?.code === "INSTABOX_API") {
          if (isNotFoundApi(e)) {
            forget(); // recreated under the same name -> re-resolve, the command never started
            throw { phase: "start", error: e };
          }
          if (e.status === 409 && (e.apiCode === "machine_not_running" || e.apiCode === "operation_conflict")) {
            try {
              await ensureAwake(id, e.apiCode);
              woke = true;
            } catch (e2) {
              throw { phase: "fatal", error: e2 };
            }
            throw { phase: "start", error: e };
          }
          if (e.status >= 500 || e.apiCode === "malformed_response") throw { phase: "run", error: e };
          throw { phase: "start", error: e }; // other 4xx: rejected before anything ran
        }
        if (e?.code === "INSTABOX_NETWORK") {
          throw { phase: e.preSend ? "start" : "run", error: e };
        }
        throw { phase: "run", error: e };
      }
      return res;
    }

    let r;
    for (;;) {
      try {
        r = await attempt(Math.max(0, deadline - Date.now()));
        break;
      } catch (f) {
        const e = f?.error ?? f;
        if (f?.phase === "fatal") {
          note("error");
          throw e?.code === "INSTABOX_START_FAILED" ? fail("INSTABOX_START_FAILED", msgOf(e)) : fail("INSTABOX_START_FAILED", `could not wake machine: ${msgOf(e)}`);
        }
        if (f?.phase === "run") {
          note("error");
          throw fail(
            "INSTABOX_CONNECTION_ENDED",
            `InstaBox exec failed after the request was sent; command may or may not have run: ${msgOf(e, [command, wrapped])}`,
          );
        }
        // phase "start": the command never started -> safe to retry exactly once
        if (retries === 0) {
          retries = 1;
          await sleep(retryDelayMs);
          if (deadline - Date.now() <= 0) {
            note("timeout");
            return { stdout: "", stderr: "", timedOut: true };
          }
          continue;
        }
        note("error");
        if (e?.code === "INSTABOX_SANDBOX_MISSING" || e?.code === "INSTABOX_CONFIG") throw e;
        if (e?.code === "INSTABOX_OPERATION_TIMEOUT") throw fail("INSTABOX_START_FAILED", msgOf(e));
        throw fail("INSTABOX_CONNECT_FAILED", `InstaBox machine could not be reached after 1 retry: ${msgOf(e, [command, wrapped])}`);
      }
    }

    const stdout = String(r.stdout ?? "");
    const stderr = String(r.stderr ?? "");
    if (r.timedOut === true) {
      note("timeout", undefined, r.truncated === true);
      return { stdout, stderr, timedOut: true };
    }
    if (!Number.isInteger(r.exitCode) || r.exitCode < 0) {
      note("error", r.exitCode);
      throw fail("INSTABOX_API", `InstaBox exec returned no usable exit code (${JSON.stringify(r.exitCode)}); command may or may not have run`);
    }
    note("ok", r.exitCode, r.truncated === true);
    return { stdout, stderr, exitCode: r.exitCode, timedOut: false };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Production instance (lazy, one per process)

let prod;

async function getProd() {
  if (prod) return prod;
  const apiKey = process.env.INSTABOX_API_KEY;
  if (!apiKey) throw codedError("INSTABOX_CONFIG", "INSTABOX_API_KEY is not set (put it in .env)");
  const gh = process.env.GITHUB_TOKEN;
  prod = createInstaboxBash({
    apiKey,
    baseUrl: process.env.INSTABOX_BASE_URL || DEFAULT_BASE_URL,
    name: process.env.TARSBOT_INSTABOX_NAME || DEFAULT_NAME,
    env: gh ? { GH_TOKEN: gh } : {},
    log: process.env.TARSBOT_INSTABOX_LOG ? (e) => console.error(`[instabox] ${JSON.stringify(e)}`) : undefined,
  });
  return prod;
}

/** Run a shell command in the InstaBox machine. Returns { stdout, stderr, exitCode, timedOut }. */
export async function instaboxBash(command, { timeoutMs } = {}) {
  return (await getProd())(command, { timeoutMs });
}

/** For /api/space: never contains a key. */
export function getInstaboxInfo() {
  return { sandbox: "instabox", name: process.env.TARSBOT_INSTABOX_NAME || DEFAULT_NAME };
}

/** Provider interface (docs/CLOUD-PLAN.md §3): `bash` and `info`. */
export { instaboxBash as bash, getInstaboxInfo as info };
