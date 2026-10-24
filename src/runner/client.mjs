// Client for src/runner/runner.sh (docs/M1-PLAN.md section 4.4). Everything goes through the sandbox `bash` primitive:
//   bash(command, {timeoutMs, env?}) -> Promise<{stdout, stderr, exitCode, timedOut}>
//
// What this file guarantees
//  - Command text and environment values never travel in argv beyond the 12 KiB chunk limit: the command is written to
//    `<home>/stage/<id>/` in chunks of WRITE_CHUNK_BYTES raw bytes (base64, one exec each) and the runner reads it from
//    there. Environment VALUES are never written to any file or put in a command line: they are passed only through the
//    `env` option of `bash`, which the primitive must advertise with `bash.supportsEnv === true`. Without it, a call that
//    carries `env` is rejected (no fallback to files). Only the NAMES are staged, so `start` can refuse to run a command
//    whose variables are not set.
//  - `prepare` and `start` are NEVER retried and never swallow an error: if `bash` throws ("connection ended, command may
//    have run") the error is rethrown as is; a `timedOut` result is turned into a RunnerError with outcomeUnknown=true.
//    The caller must then treat the run as "outcome unknown" and look at `status`, not call `start` again blindly.
//  - `wait` and `status` are read-only and are retried a few times.
//  - `wait` asks the runner for base64 (stdout is decoded as UTF-8 by the primitives, which would corrupt raw log bytes),
//    checks that the number of bytes received matches the offsets the runner reported, and decodes text with a
//    StreamDecoder (kept per run id) so a multi-byte character split on a chunk boundary stays whole.
//
// Known deviations: stdout and stderr are merged; states `claimed` / `lost` are reported, never repaired; commands that
// escape the process group are not reached by `kill`; Linux only. See runner.sh.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { StreamDecoder } from "@earendil-works/pi-durable/env";
import { WRITE_CHUNK_BYTES, shellQuote } from "../env.mjs";

export const RUNNER_SOURCE_URL = new URL("./runner.sh", import.meta.url);
/** Same limit as runner.sh MAX_CMD_BYTES (Linux allows 128 KiB for one argument; the wrapper passes the command as one). */
export const MAX_COMMAND_BYTES = 126_000;
/** Most log bytes `wait` returns per call (runner.sh MAX_DATA). */
export const MAX_WAIT_BYTES = 32 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_HOME = "~/.pca";

export class RunnerError extends Error {
  /**
   * @param {string} code runner `error=` key, or one of RUNNER_* client codes
   * @param {string} message
   * @param {{outcomeUnknown?: boolean, detail?: string}} [extra]
   */
  constructor(code, message, { outcomeUnknown = false, detail } = {}) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    if (detail !== undefined) this.detail = detail;
  }
}

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
export { sha256Hex };

/** Run id: sha256(`${namespace}:${generation}:${taskId}`), first 24 hex chars. Pure. */
export function runIdFor({ namespace, generation, taskId }) {
  if (namespace === undefined || generation === undefined || taskId === undefined) {
    throw new TypeError("runIdFor needs namespace, generation and taskId");
  }
  return sha256Hex(`${namespace}:${generation}:${taskId}`).slice(0, 24);
}

/** sha256 over (cwd, command); unambiguous because the cwd is length-prefixed. For replay: "still the same command?" */
export function commandHash(command, cwd) {
  const cmd = toBytes(command);
  const dir = Buffer.from(String(cwd), "utf8");
  return sha256Hex(Buffer.concat([Buffer.from(`${dir.length}:`), dir, Buffer.from("\n"), cmd]));
}

function toBytes(command) {
  if (typeof command === "string") return Buffer.from(command, "utf8");
  if (command instanceof Uint8Array) return Buffer.from(command);
  throw new TypeError("command must be a string or Uint8Array");
}

/** Shell word for a path under the sandbox user's home (`~/x` -> "$HOME"/'x'); other paths are single-quoted. */
function pathWord(p) {
  if (p === "~") return '"$HOME"';
  if (p.startsWith("~/")) return `"$HOME"/${shellQuote([p.slice(2)])}`;
  return shellQuote([p]);
}

/** Parse the leading `key=value` lines of runner output. Stops at the first line that is not one. */
export function parseKeyValues(text) {
  const out = {};
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end === -1) end = text.length;
    const line = text.slice(pos, end);
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line);
    if (!m) break;
    out[m[1]] = m[2];
    pos = end + 1;
  }
  return out;
}

const intOrUndefined = (v) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);

function normalizeState(kv) {
  const state = {
    state: kv.state,
    exit: intOrUndefined(kv.exit),
    pid: intOrUndefined(kv.pid),
    size: intOrUndefined(kv.size),
    cmdSha256: kv.cmd_sha256,
    cwd: kv.cwd,
    launched: kv.launched === "1",
  };
  return state;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {(command: string, o?: {timeoutMs?: number, env?: Record<string,string>}) => Promise<{stdout:string, stderr:string, exitCode?:number, timedOut?:boolean}>} opts.bash
 * @param {string} [opts.runnerPath] where runner.sh lives in the sandbox (default `<home>/runner.sh`)
 * @param {string} [opts.home] runner state root in the sandbox (default `~/.pca`; becomes PCA_HOME for every call)
 * @param {URL|string} [opts.runnerSource] local runner.sh (default the one next to this file)
 * @param {number} [opts.readRetries] extra attempts for wait/status (default 2)
 * @param {number} [opts.retryDelayMs] (default 400)
 */
export function createRunnerClient({
  bash,
  runnerPath,
  home = DEFAULT_HOME,
  runnerSource = RUNNER_SOURCE_URL,
  readRetries = 2,
  retryDelayMs = 400,
} = {}) {
  if (typeof bash !== "function") throw new TypeError("createRunnerClient requires a bash primitive");
  const homeWord = pathWord(home);
  const runnerWord = pathWord(runnerPath ?? `${home}/runner.sh`);
  const sub = (...segments) => `${homeWord}${segments.map((s) => `/${shellQuote([s])}`).join("")}`;
  const runner = (...args) => `PCA_HOME=${homeWord} ${runnerWord} ${args.join(" ")}`;
  /** Environment values supplied at prepare(), used by start(id) of the same client instance. */
  const pendingEnv = new Map();
  /** Per-run decoders so a character split across two wait() calls stays whole. */
  const decoders = new Map();

  const assertId = (id) => {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new TypeError("invalid run id");
  };

  /** One exec. Throws what `bash` throws; a timeout becomes an outcome-unknown RunnerError. */
  async function exec(command, { timeoutMs, env, what }) {
    const r = await bash(command, env ? { timeoutMs, env } : { timeoutMs });
    if (r?.timedOut) {
      throw new RunnerError("RUNNER_TIMEOUT", `runner ${what} timed out; the command may or may not have run`, { outcomeUnknown: true });
    }
    return r;
  }

  /** Parse a runner reply (exit 0 with key=value lines, or exit 2 with error=). */
  function parseReply(r, what) {
    const stdout = String(r.stdout ?? "");
    const kv = parseKeyValues(stdout);
    if (kv.error !== undefined) {
      throw new RunnerError(kv.error, `runner ${what} failed: ${kv.error}${kv.detail ? ` (${kv.detail})` : ""}`, { detail: kv.detail });
    }
    if (r.exitCode !== 0 || Object.keys(kv).length === 0) {
      const err = String(r.stderr ?? "").trim().slice(0, 300);
      throw new RunnerError("RUNNER_FAILED", `runner ${what} exited ${r.exitCode}${err ? `: ${err}` : ""}`);
    }
    return { kv, stdout };
  }

  async function readOnly(fn) {
    let lastErr;
    for (let attempt = 0; attempt <= readRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (e instanceof RunnerError && !e.outcomeUnknown && e.code !== "RUNNER_FAILED") throw e; // definite runner answer
        if (attempt < readRetries) await sleep(retryDelayMs);
      }
    }
    throw lastErr;
  }

  /** Write `bytes` to `<dir>/<name>.part.NNNNNN` files, one exec per chunk (idempotent per file). */
  async function writeParts(dirSegments, name, bytes) {
    const dir = sub(...dirSegments);
    let n = 0;
    for (let off = 0; off === 0 || off < bytes.length; off += WRITE_CHUNK_BYTES) {
      const b64 = bytes.subarray(off, off + WRITE_CHUNK_BYTES).toString("base64");
      const file = `${dir}/${shellQuote([`${name}.part.${String(n).padStart(6, "0")}`])}`;
      const r = await exec(`printf %s '${b64}' | base64 -d > ${file}`, { timeoutMs: 60_000, what: "stage write" });
      if (r.exitCode !== 0) throw new RunnerError("RUNNER_STAGE_FAILED", `staging chunk ${n} failed: ${String(r.stderr ?? "").trim().slice(0, 200)}`);
      n++;
    }
    return n;
  }

  async function install() {
    const source = await readFile(runnerSource);
    const localSha = sha256Hex(source);
    const localVersion = /^RUNNER_VERSION=(\d+)$/m.exec(source.toString("utf8"))?.[1];
    if (!localVersion) throw new Error("runner.sh has no RUNNER_VERSION");
    try {
      const r = await exec(`${runner("version")} 2>/dev/null`, { timeoutMs: 30_000, what: "version" });
      const kv = parseKeyValues(String(r.stdout ?? ""));
      if (r.exitCode === 0 && kv.version === localVersion && kv.sha256 === localSha) return { installed: false, version: Number(localVersion) };
    } catch (e) {
      if (!(e instanceof RunnerError)) throw e;
    }
    const dir = homeWord;
    const target = runnerWord;
    const r0 = await exec(`mkdir -p ${dir} && rm -f ${dir}/'runner.install'.part.*`, { timeoutMs: 30_000, what: "install" });
    if (r0.exitCode !== 0) throw new RunnerError("RUNNER_INSTALL_FAILED", `cannot create runner directory: ${String(r0.stderr ?? "").trim().slice(0, 200)}`);
    // Parts live next to the target (same filesystem) so the final rename is atomic.
    const name = "runner.install";
    let n = 0;
    for (let off = 0; off < source.length; off += WRITE_CHUNK_BYTES) {
      const b64 = source.subarray(off, off + WRITE_CHUNK_BYTES).toString("base64");
      const file = `${dir}/${shellQuote([`${name}.part.${String(n).padStart(6, "0")}`])}`;
      const r = await exec(`printf %s '${b64}' | base64 -d > ${file}`, { timeoutMs: 60_000, what: "install" });
      if (r.exitCode !== 0) throw new RunnerError("RUNNER_INSTALL_FAILED", `install chunk ${n} failed: ${String(r.stderr ?? "").trim().slice(0, 200)}`);
      n++;
    }
    const assemble =
      `cat ${dir}/'runner.install'.part.* > ${dir}/'runner.install.new' && ` +
      `[ "$(sha256sum < ${dir}/'runner.install.new' | cut -d' ' -f1)" = '${localSha}' ] && ` +
      `chmod +x ${dir}/'runner.install.new' && mv ${dir}/'runner.install.new' ${target} && ` +
      `rm -f ${dir}/'runner.install'.part.* && echo installed`;
    const r = await exec(assemble, { timeoutMs: 30_000, what: "install" });
    if (r.exitCode !== 0 || !String(r.stdout).includes("installed")) {
      throw new RunnerError("RUNNER_INSTALL_FAILED", "runner.sh upload failed checksum verification");
    }
    return { installed: true, version: Number(localVersion) };
  }

  async function prepare({ id, cwd, command, env } = {}) {
    assertId(id);
    if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.includes("\n")) throw new TypeError("cwd must be an absolute path without newlines");
    const bytes = toBytes(command);
    if (bytes.length === 0) throw new RangeError("command is empty");
    if (bytes.length > MAX_COMMAND_BYTES) throw new RangeError(`command is ${bytes.length} bytes; limit is ${MAX_COMMAND_BYTES}`);
    if (bytes.includes(0)) throw new RangeError("command contains a NUL byte");
    const envEntries = Object.entries(env ?? {});
    if (envEntries.length > 0) {
      if (bash.supportsEnv !== true) {
        throw new RunnerError(
          "RUNNER_ENV_UNSUPPORTED",
          "this bash primitive cannot pass per-call environment variables; refusing to stage secrets in files",
        );
      }
      for (const [k, v] of envEntries) {
        if (!ENV_NAME_RE.test(k) || k.startsWith("PCA_")) throw new TypeError(`invalid environment variable name: ${k}`);
        if (typeof v !== "string") throw new TypeError(`environment variable ${k} must be a string`);
      }
    }
    const names = envEntries.map(([k]) => k);

    const stageDir = ["stage", id];
    const w = await exec(`rm -rf ${sub(...stageDir)} && mkdir -p ${sub(...stageDir)}`, { timeoutMs: 30_000, what: "stage" });
    if (w.exitCode !== 0) throw new RunnerError("RUNNER_STAGE_FAILED", `cannot create stage directory: ${String(w.stderr ?? "").trim().slice(0, 200)}`);
    await writeParts(stageDir, "cmd", bytes);
    const stage = sub(...stageDir);
    const parts = [`cd ${stage}`, `cat ${stage}/'cmd.part.'* > ${stage}/cmd`];
    const args = [`prepare`, shellQuote([id]), "--cwd", shellQuote([cwd]), "--cmd-file", `${stage}/cmd`, "--cmd-sha256", sha256Hex(bytes)];
    if (names.length > 0) {
      await writeParts(stageDir, "env", Buffer.from(`${names.join("\n")}\n`, "utf8"));
      parts.push(`cat ${stage}/'env.part.'* > ${stage}/env`);
      args.push("--env-file", `${stage}/env`);
    }
    // From here on the run may be claimed: no retry, no swallowing.
    const r = await exec(`${parts.join(" && ")} && ${runner(...args)}`, { timeoutMs: 60_000, what: "prepare" });
    const { kv } = parseReply(r, "prepare");
    if (names.length > 0) pendingEnv.set(id, Object.fromEntries(envEntries));
    return { prepared: kv.prepared, ...normalizeState(kv) };
  }

  async function start(id, { env } = {}) {
    assertId(id);
    const values = env ?? pendingEnv.get(id);
    if (values && Object.keys(values).length > 0 && bash.supportsEnv !== true) {
      throw new RunnerError("RUNNER_ENV_UNSUPPORTED", "this bash primitive cannot pass per-call environment variables");
    }
    const r = await exec(runner("start", shellQuote([id])), { timeoutMs: 60_000, env: values && Object.keys(values).length > 0 ? values : undefined, what: "start" });
    const { kv } = parseReply(r, "start");
    pendingEnv.delete(id);
    return { started: kv.started, reason: kv.reason, ...normalizeState(kv) };
  }

  async function status(id) {
    assertId(id);
    return readOnly(async () => {
      const r = await exec(runner("status", shellQuote([id])), { timeoutMs: 30_000, what: "status" });
      return normalizeState(parseReply(r, "status").kv);
    });
  }

  /**
   * Block until new output past `from`, the run ended, or `maxSeconds`. Returns the next slice (at most 32 KiB):
   * { state, exit, offset (next byte to ask for), size, bytes, text, done }. `done` = exited and everything was read.
   */
  async function wait({ id, from = 0, maxSeconds = 20, decoder } = {}) {
    assertId(id);
    if (!Number.isInteger(from) || from < 0) throw new RangeError("from must be a non-negative integer");
    if (!Number.isInteger(maxSeconds) || maxSeconds < 0) throw new RangeError("maxSeconds must be a non-negative integer");
    const res = await readOnly(async () => {
      const r = await exec(runner("wait", shellQuote([id]), "--from", String(from), "--max", String(maxSeconds), "--encoding", "base64"), {
        timeoutMs: (maxSeconds + 30) * 1000,
        what: "wait",
      });
      const { kv, stdout } = parseReply(r, "wait");
      const marker = stdout.indexOf("\n--data--\n");
      if (marker === -1) throw new RunnerError("RUNNER_FAILED", "runner wait reply has no data section");
      const bytes = Buffer.from(stdout.slice(marker + "\n--data--\n".length).replace(/\s+/g, ""), "base64");
      const offset = intOrUndefined(kv.offset);
      if (offset === undefined || offset - from !== bytes.length) {
        // Output was cut or corrupted in transit (history of lost large outputs): ask again rather than trust it.
        throw new RunnerError("RUNNER_FAILED", `runner wait returned ${bytes.length} bytes but offsets say ${offset === undefined ? "?" : offset - from}`);
      }
      return { kv, bytes, offset };
    });
    const { kv, bytes, offset } = res;
    let dec = decoder;
    if (!dec) {
      const cached = decoders.get(id);
      dec = cached && cached.offset === from ? cached.decoder : new StreamDecoder();
    }
    let text = bytes.length > 0 ? dec.decode(bytes) : "";
    const size = intOrUndefined(kv.size);
    // `done` only for a normally finished run; `claimed` / `lost` / `missing` are not completions (caller inspects `state`).
    const done = kv.state === "exited" && offset >= size;
    if (done || ((kv.state === "lost") && offset >= size)) text += dec.decode();
    if (!decoder) {
      if (done) decoders.delete(id);
      else decoders.set(id, { offset, decoder: dec });
    }
    return { state: kv.state, exit: intOrUndefined(kv.exit), offset, size, bytes, text, done };
  }

  async function kill(id, { graceSeconds = 5 } = {}) {
    assertId(id);
    if (!Number.isInteger(graceSeconds) || graceSeconds < 0) throw new RangeError("graceSeconds must be a non-negative integer");
    const r = await exec(runner("kill", shellQuote([id]), "--grace", String(graceSeconds)), { timeoutMs: (graceSeconds + 30) * 1000, what: "kill" });
    const { kv } = parseReply(r, "kill");
    return { killed: kv.killed, reason: kv.reason, ...normalizeState(kv) };
  }

  return { install, prepare, start, wait, status, kill };
}
