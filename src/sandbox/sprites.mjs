// Sprites (Fly.io) shell primitive factory: `createSpritesBash({client, name, ...}) -> bash(command, {timeoutMs}) ->
// {stdout, stderr, exitCode, timedOut}`; SandboxEnv runs on top of it. Used by src/providers/sprites.mjs (one bash per
// workspace Sprite); there is no process-wide singleton. Behaviour is dictated by the measurements in docs/sprites-probe.md:
//  - Uses sprite.spawn(); execFile() rejects on non-zero exit and never closes stdin, exec() splits on spaces.
//  - The remote command is delayed by `sleep` (startDelaySec): a command that prints >64 KB immediately after start
//    randomly loses ALL output on the platform side (connection closes ~11 s later with no exit status).
//  - SDK error messages embed the exec URL, whose query carries argv and any options.env -> every error is redacted.
//  - Exit status -1 (connection ended without an exit frame) is an error, never a result: the command may have run.
//    Only failures BEFORE the WebSocket opens (SDK emits 'spawn' once start() succeeded) are retried, once.
//
// Secret transport (ENV-DEMO / GH_TOKEN): the SDK serializes options.env into the exec URL query (dist/exec.js
// buildWebSocketURL), so a value that must never appear in a URL CANNOT ride options.env. Instead it travels as a
// stdin bootstrap: the argv is a fixed POSIX script that reads ONE base64 line of `NAME=value` records off stdin
// (from /dev/tty when there is one, else stdin), exports them and then execs the user's command. The payload is the
// first bytes the client writes after the 'spawn' event — a WebSocket message, never the URL/argv/a file. When a
// call carries env values the transport therefore differs from a plain `sh -c <command>` only inside the runner's
// own env contract: prepare still stages names, start still delivers values, and a failed bootstrap exits 125 with
// an env-inject error so the caller sees a definite failure, never a command that ran half-configured.
// Does not import config.mjs (it reads process.env directly, and stays usable from tests without a .env).

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_RETRY_DELAY_MS = 1500;
const DEFAULT_CWD = "/home/sprite";
/** After 'exit', how long to wait for the stdout/stderr streams to deliver their remaining data. */
const DRAIN_GRACE_MS = 3000;
/** Exit code the stdin bootstrap uses when the payload could not be applied (definite failure, not a runner exit). */
const ENV_INJECT_EXIT = 125;

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

/** POSIX sh single-quote literal for one value (empty -> ''). */
const sq = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;

/** Serialize env entries as ONE base64 line of `export NAME='value'` statements (single-quoted). */
function envBootstrapPayload(env) {
  const parts = [];
  for (const [k, v] of Object.entries(env)) parts.push(`export ${k}=${sq(v)} || exit 125`);
  if (!parts.length) return undefined;
  return `${Buffer.from(`${parts.join("\n")}\n`, "utf8").toString("base64")}\n`;
}

/**
 * The sh script that turns the stdin payload into exports then execs the command. `read` from /dev/tty first
 * (non-tty execs still have one on Sprites; fall back to stdin). A line that is not valid base64, a payload that
 * fails to decode, or an eval failure all exit ENV_INJECT_EXIT so the caller sees a definite injection failure —
 * the command never runs half-configured. The command is an argv element (`exec /bin/sh -c "$1"`), never spliced.
 */
// /dev/tty fails when there is no controlling tty (plain exec); fall back to stdin in that case. A failed
// read (timeout / closed stdin) exits 124, a bad payload 125, an eval failure 125 — all definite failures,
// never a command that ran without its env.
const BOOTSTRAP_SH = `read -r _pca_env_b64 < /dev/tty 2>/dev/null || read -r _pca_env_b64 || exit 124; \
case "$_pca_env_b64" in *[!A-Za-z0-9+/=]* | "") echo "pca-env: invalid payload" >&2; exit ${ENV_INJECT_EXIT};; esac; \
printf %s "$_pca_env_b64" | grep -Eq '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' || exit 125; \
_pca_env_script=$(printf %s "$_pca_env_b64" | base64 -d 2>/dev/null) || exit 125; \
 eval "$_pca_env_script" 2>/dev/null || { echo "pca-env: inject failed" >&2; exit ${ENV_INJECT_EXIT}; }; \
unset _pca_env_b64 _pca_env_script; \
sleep DELAY; exec /bin/sh -c "$1"`;

const bootstrapScript = (delaySec) => (delaySec > 0 ? BOOTSTRAP_SH.replace("DELAY", String(delaySec)) : BOOTSTRAP_SH.replace("sleep DELAY; ", ""));

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
  const msgOf = (e) => String(e?.message ?? e);
  const execEnv = Object.keys(env).length ? { ...env } : undefined;
  const plainScript = startDelaySec > 0 ? `sleep ${startDelaySec}; exec /bin/sh -c "$1"` : `exec /bin/sh -c "$1"`;
  const injectScript = bootstrapScript(startDelaySec);

  /** Build argv for one call. `payload` (secret stdin payload) decides which argv the spawn uses. */
  const argv = (command, payload) => (payload ? ["-c", injectScript, "sh", command] : ["-c", plainScript, "sh", command]);

  let sprite;

  /** One exec attempt. Resolves {kind: "done"|"timeout"|"early-error"|"late-error", ...}; never rejects.
   * @param {string} command
   * @param {number} timeoutMs
   * @param {{env?: Record<string,string>, payload?: string}} opts transport decisions are FROZEN into this
   *   snapshot by the caller — two concurrent calls can never swap each other's env/payload mid-flight. */
  function attempt(command, timeoutMs, { env, payload } = {}) {
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
        // options.env is the SDK's URL-query channel — used ONLY for non-secret keys (TERM etc.). Secret values
        // ride `payload` on stdin and never appear in options.env or argv.
        cmd = sprite.spawn("/bin/sh", argv(command, payload), { env, cwd });
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
        // Secret payload first (the remote `read` unblocks on it), then EOF so the stdin contract stays
        // identical to the no-env path.
        if (payload) {
          try {
            cmd.stdin.write(payload);
          } catch {
            // a dead stream is reported by 'exit' / 'error'
          }
        }
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
    //
    // Transport split: entries whose value must never appear in the exec URL (any non-empty value, plus
    // capability strips like GH_TOKEN="" that must not smuggle a parent value in via argv) are REMOVED from
    // options.env and serialized into the stdin bootstrap payload instead. The runner's unset contract is
    // preserved: the bootstrap script evals `export NAME='…'` for every name, and names the caller asked to
    // unset arrive with the empty string, which the runner wrapper then unsets on the Sprite side.
    const baseEnv = execEnv ?? {};
    const urlEnv = {}; // safe for the URL (kept empty today: every user/system value is secret-grade)
    const stdinEnv = {}; // goes on stdin, never the URL
    if (perCallEnv && typeof perCallEnv === "object") {
      for (const [k, v] of Object.entries(perCallEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new TypeError(`invalid env name: ${k}`);
        if (typeof v !== "string") throw new TypeError(`env ${k} must be a string`);
      }
    }
    const merged = { ...baseEnv, ...(perCallEnv ?? {}) };
    const fail = (code, message) => codedError(code, redactMessage(message, [...redactList, ...Object.values(merged)]));
    for (const [k, v] of Object.entries(merged)) {
      // EVERY value is secret-grade for this transport: GH_TOKEN, user vars and capability strips all ride
      // stdin. Nothing is sent on the URL. (The PTY path keeps its own display-only allowlist separately.)
      stdinEnv[k] = v;
    }
    const payload = Object.keys(stdinEnv).length ? envBootstrapPayload(stdinEnv) : undefined;
    const effectiveEnv = Object.keys(urlEnv).length ? urlEnv : undefined;

    // Freeze this call's transport decisions; the attempt gets an immutable snapshot and a retry reuses it.
    const snapshot = { env: effectiveEnv, payload };
    const queryChars = execQueryLength(argv(command, payload), effectiveEnv, cwd);
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

    let r = await attempt(command, budget, snapshot);
    if (r.kind === "early-error") {
      // Failed before the WebSocket opened -> the command was never started; safe to retry exactly once.
      retries = 1;
      await sleep(retryDelayMs);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        note("timeout");
        return { stdout: "", stderr: "", timedOut: true };
      }
      r = await attempt(command, remaining, snapshot);
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
  // supportsEnv means "this primitive accepts per-call env" — the transport is the safe stdin bootstrap,
  // never a promise that values stay out of the URL.
  spritesBashRun.supportsEnv = true;
  return spritesBashRun;
}
