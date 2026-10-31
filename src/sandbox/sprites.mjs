// Sprites (Fly.io) shell primitive factory: `createSpritesBash({client, name, ...}) -> bash(command, {timeoutMs}) ->
// {stdout, stderr, exitCode, timedOut}`; SandboxEnv runs on top of it. Used by src/providers/sprites.mjs (one bash per
// workspace Sprite); there is no process-wide singleton. Behaviour is dictated by the measurements in docs/sprites-probe.md:
//  - Uses sprite.spawn(); execFile() rejects on non-zero exit and never closes stdin, exec() splits on spaces.
//  - The remote command is delayed by `sleep` (startDelaySec): a command that prints >64 KB immediately after start
//    randomly loses ALL output on the platform side (connection closes ~11 s later with no exit status).
//  - SDK error messages embed the exec URL, whose query carries env values and argv -> every error is redacted.
//  - Exit status -1 (connection ended without an exit frame) is an error, never a result: the command may have run.
//    Only failures BEFORE the WebSocket opens (SDK emits 'spawn' once start() succeeded) are retried, once.
// Does not import config.mjs (it reads process.env directly, and stays usable from tests without a .env).

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_RETRY_DELAY_MS = 1500;
const DEFAULT_CWD = "/home/sprite";
/** After 'exit', how long to wait for the stdout/stderr streams to deliver their remaining data. */
const DRAIN_GRACE_MS = 3000;

const CONN_ENDED_MSG = "Sprite exec connection ended without exit status; command may or may not have run";

/**
 * The SDK sends argv and env in the WebSocket URL's query string. Measured on tarsbot-dev (S1-bash smoke): a total URL
 * above ~65,5xx chars fails locally with "WebSocket error: TypeError" (64,000 'a' succeeds, 70,000 fails).
 * Fail early with a clear error below that, leaving margin for the host/path prefix.
 */
export const MAX_EXEC_QUERY_CHARS = 64_000;

function execQueryLength(args, env, cwd) {
  const pairs = [["cmd", "/bin/sh"], ...args.map((a) => ["cmd", a]), ["path", "/bin/sh"], ["stdin", "true"], ["dir", cwd]];
  for (const [k, v] of Object.entries(env ?? {})) pairs.push(["env", `${k}=${v}`]);
  return new URLSearchParams(pairs).toString().length;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Make an error message safe to throw/log: every secret value becomes `***` and every URL loses its query string
 * (the exec URL's query holds env values and the full argv, i.e. the command text).
 */
export function redactMessage(message, secrets = []) {
  let t = String(message ?? "");
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < 4) continue;
    t = t.split(s).join("***");
    t = t.split(encodeURIComponent(s)).join("***");
  }
  // Drop everything after '?' up to whitespace or a closing paren (the "(url: ...)" form used by the SDK).
  return t.replace(/\b((?:wss?|https?):\/\/[^\s)?]*)\?[^\s)]*/gi, "$1");
}

/**
 * @param {object} opts
 * @param {{sprite(name: string): any}} opts.client SpritesClient (or a fake with sprite(name).spawn(...))
 * @param {string} opts.name Sprite name
 * @param {Record<string,string>} [opts.env] extra env for every exec (e.g. {GH_TOKEN}); only ever sent as exec env
 * @param {number} [opts.defaultTimeoutMs] used when a call passes no timeoutMs (default 10 min)
 * @param {(entry: object) => void} [opts.log] receives {commandLength, ms, exitCode, retries, outcome}; never the command/output
 * @param {number} [opts.startDelaySec] delay before the command starts (platform large-output bug); default 0.1
 * @param {string[]} [opts.secrets] extra values to redact from errors (env values are always redacted)
 * @param {number} [opts.retryDelayMs] wait before the single pre-open retry (default 1500)
 */
export function createSpritesBash({
  client,
  name,
  env = {},
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
  startDelaySec = 0.1,
  secrets = [],
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  cwd = DEFAULT_CWD,
} = {}) {
  if (!client || typeof client.sprite !== "function") throw new TypeError("createSpritesBash requires a client with sprite(name)");
  if (typeof name !== "string" || !name) throw new TypeError("createSpritesBash requires a Sprite name");
  if (!Number.isFinite(startDelaySec) || startDelaySec < 0) throw new TypeError("startDelaySec must be a non-negative number");

  const redactList = [...Object.values(env), ...secrets].filter((v) => typeof v === "string");
  const redact = (m) => redactMessage(m, redactList);
  const fail = (code, message) => codedError(code, redact(message));
  const msgOf = (e) => String(e?.message ?? e);
  const execEnv = Object.keys(env).length ? { ...env } : undefined;

  // Why `sh -c 'sleep D; exec /bin/sh -c "$1"' sh <command>` and not `sh -c "sleep D; <command>"`:
  // the user's command is passed as a separate argv element, so it is never spliced into other shell text. Splicing
  // changes semantics: a command with an unterminated quote or a trailing `# comment` would swallow/alter our prefix,
  // and the parse/syntax-error behaviour would differ from a plain `/bin/sh -c <command>`. With `exec` the inner shell
  // replaces the outer one, so the process tree (and exit status / signals) is exactly that of `sh -c <command>`.
  const script = startDelaySec > 0 ? `sleep ${startDelaySec}; exec /bin/sh -c "$1"` : `exec /bin/sh -c "$1"`;
  const argv = (command) => ["-c", script, "sh", command];

  let sprite;

  /** Per-call environment: merged over the constructor's base env ({} values strip an injected key).
   * `attempt` reads it via the outer `callEnv` captured before spawn — retries inherit the same override. */
  let callEnv;

  /** One exec attempt. Resolves {kind: "done"|"timeout"|"early-error"|"late-error", ...}; never rejects. */
  function attempt(command, timeoutMs) {
    return new Promise((resolve) => {
      const out = [];
      const errChunks = [];
      let settled = false;
      let spawned = false;
      let exited = false;
      let exitCode;
      let ended = 0;
      let timer;
      let graceTimer;
      let cmd;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        resolve({ ...result, stdout: Buffer.concat(out), stderr: Buffer.concat(errChunks) });
      };
      const closeQuietly = () => {
        try {
          cmd?.close();
        } catch {
          // already closed
        }
      };
      const maybeDone = () => {
        if (exited && ended >= 2) finish({ kind: "done", exitCode });
      };

      try {
        sprite ??= client.sprite(name);
        cmd = sprite.spawn("/bin/sh", argv(command), { env: callEnv ?? execEnv, cwd });
      } catch (e) {
        finish({ kind: "early-error", error: e });
        return;
      }

      // Never removed: the SDK may emit further 'error' events after we settled (it reports one failure twice).
      cmd.on("error", (e) => {
        if (settled) return;
        finish({ kind: spawned ? "late-error" : "early-error", error: e });
        closeQuietly();
      });
      cmd.on("spawn", () => {
        spawned = true;
        // Only now: the SDK drops the stdin EOF frame while the WebSocket is still connecting.
        cmd.stdin.end();
      });
      cmd.stdout.on("data", (b) => out.push(Buffer.from(b)));
      cmd.stderr.on("data", (b) => errChunks.push(Buffer.from(b)));
      cmd.stdout.on("end", () => {
        ended++;
        maybeDone();
      });
      cmd.stderr.on("end", () => {
        ended++;
        maybeDone();
      });
      cmd.on("exit", (code) => {
        exited = true;
        exitCode = code;
        maybeDone();
        // Streams normally end right after 'exit'; do not hang forever if they do not.
        if (!settled) graceTimer = setTimeout(() => finish({ kind: "done", exitCode }), DRAIN_GRACE_MS);
        graceTimer?.unref?.();
      });

      timer = setTimeout(() => {
        if (settled) return;
        // Kill first: closing the socket alone leaves the remote process alive for ~10 s (probe P1).
        try {
          cmd.kill("SIGKILL");
        } catch {
          // best effort
        }
        finish({ kind: "timeout" });
        closeQuietly();
      }, Math.max(0, timeoutMs));
    });
  }

  const spritesBashRun = async function spritesBashRun(command, { timeoutMs, env: perCallEnv } = {}) {
    if (typeof command !== "string") throw new TypeError("command must be a string");
    // Per-call env overrides the constructor env key-by-key — an empty string value strips the injected key
    // (loop sessions strip GH_TOKEN this way). Values are redacted from error text like the base env's.
    const baseEnv = execEnv ?? {};
    callEnv = undefined;
    if (perCallEnv && typeof perCallEnv === "object") {
      for (const [k, v] of Object.entries(perCallEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new TypeError(`invalid env name: ${k}`);
        if (typeof v !== "string") throw new TypeError(`env ${k} must be a string`);
      }
      const merged = { ...baseEnv, ...perCallEnv };
      callEnv = Object.keys(merged).length ? merged : undefined;
      for (const v of Object.values(perCallEnv)) if (v) redactList.push(v);
    }
    const effectiveEnv = callEnv ?? execEnv;
    const queryChars = execQueryLength(argv(command), effectiveEnv, cwd);
    if (queryChars > MAX_EXEC_QUERY_CHARS) {
      throw codedError(
        "SPRITES_COMMAND_TOO_LARGE",
        `Command is too large for a Sprite exec (${queryChars} URL-encoded chars > ${MAX_EXEC_QUERY_CHARS}); the exec URL carries argv. Send large data in smaller pieces.`,
      );
    }
    const started = Date.now();
    const budget = timeoutMs ?? defaultTimeoutMs;
    const deadline = started + budget;
    let retries = 0;
    const note = (outcome, exitCode) => {
      try {
        log({ commandLength: command.length, ms: Date.now() - started, exitCode, retries, outcome });
      } catch {
        // logging must never break a call
      }
    };

    let r = await attempt(command, budget);
    if (r.kind === "early-error") {
      // Failed before the WebSocket opened -> the command was never started; safe to retry exactly once.
      retries = 1;
      await sleep(retryDelayMs);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        note("timeout");
        return { stdout: "", stderr: "", timedOut: true };
      }
      r = await attempt(command, remaining);
    }

    const stdout = r.stdout.toString("utf8");
    const stderr = r.stderr.toString("utf8");
    switch (r.kind) {
      case "timeout":
        note("timeout");
        return { stdout, stderr, timedOut: true };
      case "early-error":
        note("error");
        throw fail("SPRITES_CONNECT_FAILED", `Sprite exec could not connect after 1 retry: ${msgOf(r.error)}`);
      case "late-error":
        note("error");
        throw fail("SPRITES_CONNECTION_ENDED", `Sprite exec connection error after start; command may or may not have run: ${msgOf(r.error)}`);
      default: {
        if (!Number.isInteger(r.exitCode) || r.exitCode < 0) {
          note("error", r.exitCode);
          throw fail("SPRITES_CONNECTION_ENDED", CONN_ENDED_MSG);
        }
        note("ok", r.exitCode);
        return { stdout, stderr, exitCode: r.exitCode, timedOut: false };
      }
    }
  };
  spritesBashRun.supportsEnv = true; // per-call env override (runner client stages env via prepare/start)
  return spritesBashRun;
}
