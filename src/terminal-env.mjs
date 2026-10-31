// Terminal backends for the Terminal panel.
//
// attachTerminal    — NON-interactive command console: each command is staged through the Sprite runner
//                     (prepare -> start -> wait -> kill), output streams back and survives server restarts.
//                     There is no PTY, no persistent shell state and no stdin. Dangerous commands are
//                     refused by the shared approval classifier before staging (it is a text command, so
//                     the classifier applies exactly).
// attachPtyTerminal — REAL interactive PTY: one persistent tty shell per socket via the provider's
//                     interactive factory (sprite.spawn {tty:true}; SDK transport stays inside the
//                     provider, app.ctx only sees the controlled per-workspace factory `ptySession`).
//                     Full stdin / resize / signals / close.
//
// The PTY shell is a FULL-ACCESS trust boundary: the authenticated user can run ANYTHING in the
// session's Sprite — no per-command approval is possible on a raw byte stream, and none is pretended
// (Agent tool calls still go through src/ext/approval.mjs; this is the USER's own shell). The UI gate
// (explicit "start shell" confirmation) is what makes that trust visible; the server still validates
// session -> ready workspace -> active binding and derives cwd server-side (sessionRootOf).
import { randomUUID } from "node:crypto";
import { FileError } from "@earendil-works/pi-durable/env";
import { createRunnerClient, RunnerError } from "./runner/client.mjs";
import { sessionRootOf } from "./files-env.mjs";
import { isDangerous } from "./ext/approval.mjs";

/** A console command may not exceed the runner's own limit; the client is told the same number. */
export const MAX_TERMINAL_COMMAND_CHARS = 120_000;
/** `wait` long-poll slice while a run is streaming. */
export const TERMINAL_WAIT_SECONDS = 5;
/** Grace before runner.kill escalates TERM -> KILL. */
export const TERMINAL_KILL_GRACE_SECONDS = 3;

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const bad = (message) => new FileError("invalid", message);

/**
 * Attach a runner-backed command console to a live WebSocket.
 *
 * Wire protocol (JSON frames, both directions):
 *   client -> {type:"run", id, command}   start a run; `id` is the client-chosen run id ([A-Za-z0-9_-]{1,64})
 *   client -> {type:"kill", id}           kill that run (TERM, then KILL after the grace)
 *   server -> {type:"ready", root}        sent once the session root is resolved
 *   server -> {type:"started", id}
 *   server -> {type:"out", id, data}      output text (runner merges stdout+stderr)
 *   server -> {type:"exit", id, state, exit}
 *   server -> {type:"error", id?, message}
 *   server -> {type:"denied", id, reason} command refused by the shared danger classifier
 *
 * Runs started by a socket are killed (best effort) when the socket closes or when a new `run` with the
 * same id arrives while the previous one is still running — the console keeps ONE live run per id.
 *
 * Safety: a command that the shared classifier (src/ext/approval.mjs, the SAME rules a Bot's bash tool
 * faces) flags as dangerous is refused outright — the console is a trusted user entry, but it must
 * never be a shortcut around the approval policy. Commands the regexes do not catch are not the
 * classifier's problem statement: this is reuse, not a sandbox.
 *
 * @param {any} app route app (app.ctx.bots / control / runtimeBash / homeDir?)
 * @param {import("ws").WebSocket} socket
 * @param {string} botId
 * @param {{ runner?: any }} [deps] test seam: a prebuilt runner client (install/prepare/start/wait/kill)
 */
export async function attachTerminal(app, socket, botId, deps = {}) {
  const send = (frame) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 8 * 1024 * 1024) {
      socket.close(1013, "client too slow");
      return;
    }
    socket.send(JSON.stringify(frame));
  };
  const fail = (id, message) => send({ type: "error", ...(id ? { id } : {}), message: String(message).slice(0, 500) });

  const target = app.ctx.bots?.get(botId);
  if (target?.readOnly || target?.loopRun?.runId) {
    fail(undefined, "Manual shells are disabled for restricted Sessions; use a separate normal Session.");
    socket.close(4403, "restricted session");
    return;
  }
  let root;
  let workspace;
  try {
    ({ workspace, root } = sessionRootOf(app, botId));
  } catch (e) {
    send({ type: "error", message: String(e?.message ?? e).slice(0, 500) });
    socket.close(4409, "session not ready");
    return;
  }
  if (typeof app.ctx.runtimeBash !== "function") {
    send({ type: "error", message: "runtime bash is not available" });
    socket.close(1011, "runtime unavailable");
    return;
  }
  let bash;
  try {
    bash = await app.ctx.runtimeBash(workspace.id);
  } catch (e) {
    send({ type: "error", message: `runtime unavailable: ${String(e?.message ?? e).slice(0, 200)}` });
    socket.close(4409, "runtime unavailable");
    return;
  }
  // `runnerSource` defaults to the runner.sh next to client.mjs; install() is idempotent. `deps.runner`
  // is the test seam; production always builds the client over the workspace's own bash primitive.
  const runner = deps.runner ?? createRunnerClient({ bash });
  const installed = { done: false };
  const ensureRunner = async () => {
    if (!installed.done) {
      await runner.install();
      installed.done = true;
    }
  };
  const newRunId = (clientId) => `term-${String(clientId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)}-${randomUUID().slice(0, 8)}`;

  /** @type {Map<string, {runId: string, cancel: () => void}>} live runs by client id */
  const live = new Map();
  let closed = false;

  socket.on("close", () => {
    closed = true;
    for (const r of live.values()) r.cancel();
  });
  socket.on("error", () => {
    closed = true;
    for (const r of live.values()) r.cancel();
  });

  send({ type: "ready", root });

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return fail(undefined, "invalid frame (expected JSON)");
    }
    if (msg?.type === "run") void run(msg).catch((e) => fail(msg?.id, e instanceof RunnerError ? e.message : (e?.message ?? e)));
    else if (msg?.type === "kill") void kill(msg).catch((e) => fail(msg?.id, e?.message ?? e));
    else fail(msg?.id, `unknown message type: ${String(msg?.type)}`);
  });

  async function run(msg) {
    const id = String(msg.id ?? "");
    const command = typeof msg.command === "string" ? msg.command : "";
    if (!RUN_ID_RE.test(id)) return fail(id, "id must match [A-Za-z0-9_-]{1,64}");
    if (!command.trim()) return fail(id, "command is required");
    if (command.length > MAX_TERMINAL_COMMAND_CHARS) return fail(id, `command is too long (max ${MAX_TERMINAL_COMMAND_CHARS} chars)`);
    // The SAME danger rules a Bot's bash tool faces; flagged commands are refused, never run.
    const reason = isDangerous({ name: "bash", arguments: { command } });
    if (reason !== undefined) return send({ type: "denied", id, reason });
    // One live run per client id: a second `run` with the same id kills the previous one first.
    const prior = live.get(id);
    if (prior) {
      await killRun(prior);
      live.delete(id);
    }
    const runId = newRunId(id);
    let cancelled = false;
    const entry = {
      runId,
      killResult: null, // runner.kill reply once confirmed (used for the final frame when polling gives up)
      cancel: () => {
        cancelled = true;
        void runner
          .kill(runId, { graceSeconds: TERMINAL_KILL_GRACE_SECONDS })
          .then((r) => {
            entry.killResult = r;
          })
          .catch(() => {
            entry.killResult = { state: "lost", exit: null };
          });
      },
    };
    live.set(id, entry);
    // A kill is a progress event, never the end state: the run loop keeps following the runner until it
    // reports a terminal state, so the client ALWAYS receives a final `exit` frame (confirmed cancel),
    // never sits at "[killing…]" forever with the console stuck.
    const finish = (state, exit) => send({ type: "exit", id, state, exit: exit ?? null });
    try {
      await ensureRunner();
      await runner.prepare({ id: runId, cwd: root, command });
      if (closed) return;
      if (cancelled) {
        finish(entry.killResult?.state ?? "killed", entry.killResult?.exit ?? null);
        return;
      }
      const started = await runner.start(runId);
      if (started.started !== "new" && started.started !== "already") {
        fail(id, `command did not start (runner: ${started.reason ?? started.state ?? "unknown"})`);
        return;
      }
      send({ type: "started", id, runId });
      // Follow the runner log from offset 0 until the run ends. `cancelled` does NOT stop the loop: the
      // kill lands asynchronously and the runner then reports the terminal state, which is what the
      // client needs to clear its "running" state. If the runner keeps reporting `running` well past
      // the kill grace, fall back to the confirmed kill result so the client still unblocks.
      let from = 0;
      let postKill = 0;
      for (;;) {
        if (closed) return;
        let r;
        try {
          r = await runner.wait({ id: runId, from, maxSeconds: TERMINAL_WAIT_SECONDS });
        } catch (e) {
          if (cancelled) finish(entry.killResult?.state ?? "lost", entry.killResult?.exit ?? null);
          else fail(id, e instanceof RunnerError ? e.message : (e?.message ?? e));
          return;
        }
        from = typeof r.offset === "number" ? r.offset : from;
        if (r.text) send({ type: "out", id, data: r.text });
        if (r.state !== "running") {
          finish(r.state, r.exit ?? null);
          return;
        }
        if (cancelled && entry.killResult && ++postKill > 6) {
          finish(entry.killResult.state ?? "killed", entry.killResult.exit ?? null);
          return;
        }
      }
    } finally {
      if (live.get(id) === entry) live.delete(id);
    }
  }

  async function killRun(entry) {
    try {
      await runner.kill(entry.runId, { graceSeconds: TERMINAL_KILL_GRACE_SECONDS });
    } catch {
      // best effort: a run that already ended or is unreachable is fine
    }
  }

  async function kill(msg) {
    const id = String(msg.id ?? "");
    const entry = live.get(id);
    if (!entry) return send({ type: "exit", id, state: "missing", exit: null });
    entry.cancel();
    send({ type: "killing", id });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Interactive PTY (AMP13-PTY)
// ---------------------------------------------------------------------------------------------------------------------

/** Single input frame cannot exceed this (paste-friendly; also bounded by wss maxPayload). */
export const PTY_MAX_INPUT_BYTES = 64 * 1024;
/** One output frame. */
export const PTY_MAX_OUT_CHARS = 128 * 1024;
/** Largest PTY dimensions accepted. */
export const PTY_MAX_COLS = 1000;
export const PTY_MAX_ROWS = 500;
/** Signals the client may send to the PTY's foreground process group. */
const PTY_SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGTSTP", "SIGQUIT", "SIGWINCH"]);

const ptyClamped = (v, dflt, max) => (Number.isInteger(v) && v >= 2 ? Math.min(v, max) : dflt);

function readB64(msg, what = "data") {
  if (typeof msg?.data !== "string" || msg.data.length > Math.ceil(PTY_MAX_INPUT_BYTES / 3) * 4 + 8) {
    return { error: `${what} must be a base64 string <= ${PTY_MAX_INPUT_BYTES} decoded bytes` };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(msg.data)) return { error: `${what} is not base64` };
  const bytes = Buffer.from(msg.data, "base64");
  if (bytes.length > PTY_MAX_INPUT_BYTES) return { error: `${what} is larger than ${PTY_MAX_INPUT_BYTES} bytes` };
  return { bytes };
}

/**
 * Attach ONE interactive PTY shell to a live WebSocket (one shell per socket; a second `start` is refused).
 *
 * Wire protocol (JSON frames):
 *   client -> {type:"start", cols, rows, env?}    env values are display-only (TERM/COLORTERM/LANG…), filtered
 *   client -> {type:"in", data:"<base64>"}        raw input bytes (keys, paste)
 *   client -> {type:"resize", cols, rows}
 *   client -> {type:"signal", signal:"SIGINT"}    whitelisted set only
 *   client -> {type:"eof"}                         stdin EOF (Ctrl-D)
 *   client -> {type:"close"}                       kill the shell (SIGKILL) and close the socket
 *   server -> {type:"ready", root}                 sent first (session resolved); the shell is NOT started yet
 *   server -> {type:"started"}
 *   server -> {type:"out", data:"<base64>"}        merged PTY byte stream (tty: no separate stderr)
 *   server -> {type:"exit", state, exit, message?}
 *   server -> {type:"error", message}
 *
 * Lifecycle: the shell is killed (SIGKILL + socket close) when the client closes/errors, and the socket
 * closes after the shell exits. Errors are redacted at the provider edge; messages forwarded here are
 * truncated, never secrets.
 *
 * @param {any} app route app (app.ctx.bots / control / ptySession / runtimeBash-fallback?)
 * @param {import("ws").WebSocket} socket
 * @param {string} botId
 * @param {{ spawn?: (args: {cwd: string, cols: number, rows: number, env: object}) => Promise<any> }} [deps]
 *   test seam: a prebuilt spawn factory; production resolves `app.ctx.ptySession(workspace.id)`.
 */
export async function attachPtyTerminal(app, socket, botId, deps = {}) {
  const send = (frame) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 8 * 1024 * 1024) {
      socket.close(1013, "client too slow");
      return;
    }
    socket.send(JSON.stringify(frame));
  };
  const fail = (message) => send({ type: "error", message: String(message).slice(0, 500) });

  // The session is fully validated BEFORE any client frame is read: bot -> linked workspace (ready) ->
  // active binding -> per-workspace spawn factory (app.ctx.ptySession mirrors ctx.runtimeBash).
  // Issue14: a PTY is an unmediated FULL shell — no per-command approval is possible on a raw byte stream, so it
  // must never attach to a capability-restricted loop-run session. Only a normal session (no loopRun) may open one.
  const botRec = app.ctx.bots.get(botId);
  if (botRec?.readOnly || botRec?.loopRun?.runId) {
    fail("interactive PTY is disabled for restricted Sessions; use a separate normal Session");
    socket.close(4403, "pty not allowed for loop-run sessions");
    return;
  }
  let workspace;
  let root;
  try {
    ({ workspace, root } = sessionRootOf(app, botId));
  } catch (e) {
    fail(e?.message ?? e);
    socket.close(4409, "session not ready");
    return;
  }
  let spawnPty = deps.spawn;
  if (!spawnPty) {
    if (typeof app.ctx.ptySession !== "function") {
      fail("interactive sessions are not available (app.ctx.ptySession is not wired)");
      socket.close(1011, "pty unavailable");
      return;
    }
    try {
      spawnPty = await app.ctx.ptySession(workspace.id);
    } catch (e) {
      fail(`runtime unavailable: ${String(e?.message ?? e).slice(0, 200)}`);
      socket.close(4409, "runtime unavailable");
      return;
    }
  }

  send({ type: "ready", root });

  let shell = null; // the live PTY handle (provider-owned SpriteCommand wrapper)
  let closed = false;
  const killShell = () => {
    const s = shell;
    shell = null;
    try {
      s?.kill();
    } catch {
      // best effort
    }
  };
  socket.on("close", () => {
    closed = true;
    killShell();
  });
  socket.on("error", () => {
    closed = true;
    killShell();
  });

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return fail("invalid frame (expected JSON)");
    }
    switch (msg?.type) {
      case "start":
        void start(msg).catch((e) => fail(e?.message ?? e));
        break;
      case "in": {
        const r = readB64(msg);
        if (r.error) return fail(r.error);
        if (!shell) return fail("no shell is running");
        shell.write(r.bytes);
        return;
      }
      case "resize": {
        if (!shell) return fail("no shell is running");
        shell.resize(msg.cols, msg.rows);
        return;
      }
      case "signal": {
        if (!shell) return fail("no shell is running");
        const sig = String(msg.signal ?? "");
        if (!PTY_SIGNALS.has(sig)) return fail(`signal not allowed: ${sig || "(empty)"}`);
        shell.signal(sig);
        return;
      }
      case "eof": {
        if (!shell) return fail("no shell is running");
        shell.eof();
        return;
      }
      case "close": {
        killShell();
        send({ type: "exit", state: "closed", exit: null });
        socket.close(1000, "client closed");
        return;
      }
      default:
        return fail(`unknown message type: ${String(msg?.type)}`);
    }
  });

  async function start(msg) {
    if (shell) return fail("a shell is already running on this socket");
    const cols = ptyClamped(msg.cols, 80, PTY_MAX_COLS);
    const rows = ptyClamped(msg.rows, 24, PTY_MAX_ROWS);
    const env = msg.env && typeof msg.env === "object" && !Array.isArray(msg.env) ? msg.env : {};
    let s;
    try {
      s = await spawnPty({ cwd: root, cols, rows, env });
    } catch (e) {
      return fail(`could not start the shell: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    if (closed) {
      // The socket died while the exec was connecting; do not leave a live shell behind.
      try {
        s?.kill();
      } catch {
        // best effort
      }
      return;
    }
    shell = s;
    send({ type: "started", cols, rows });
    s.stdout?.on?.("data", (b) => {
      if (closed) return;
      // PTY output is raw bytes; base64 keeps control sequences intact across the JSON frame.
      send({ type: "out", data: Buffer.from(b).subarray(0, PTY_MAX_OUT_CHARS).toString("base64") });
    });
    try {
      const r = await s.exit;
      if (shell === s) shell = null;
      if (closed) return;
      send({ type: "exit", state: r?.state ?? "exited", exit: r?.exit ?? null, ...(r?.message ? { message: String(r.message).slice(0, 300) } : {}) });
      socket.close(1000, "shell exited");
    } catch (e) {
      if (shell === s) shell = null;
      if (!closed) {
        fail(`shell ended with an error: ${String(e?.message ?? e).slice(0, 300)}`);
        socket.close(1011, "shell error");
      }
    }
  }
}
