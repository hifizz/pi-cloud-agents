// Offline tests for the REAL interactive PTY path: src/terminal-env.mjs attachPtyTerminal +
// src/routes/terminal.mjs + the provider's pty() guard. A real HTTP server (createApi) serves the
// WebSocket; the PTY handle is a scriptable fake of the SDK SpriteCommand wrapper (stdin/stdout/resize/
// signal/kill/exit). No network, no Sprite, no real shell — frames and close codes are what a browser
// sees. Every wait is on an explicit frame predicate or socket close, under a hard timeout.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { register as registerTerminal } from "../src/routes/terminal.mjs";
import { createSpritesProvider } from "../src/providers/sprites.mjs";

const MODEL = { provider: "faux", modelId: "faux-1" };
const ROOT = "/home/sprite/workspace/app";
const TIMEOUT_MS = 10_000;

/** Scriptable PTY fake: records stdin/resize/signal/kill, replays output + a deferred exit. */
function fakeShell({ out = [], exitCode = 0 } = {}) {
  const calls = { write: [], resize: [], signal: [], kill: 0, eof: 0 };
  const stdout = new PassThrough();
  const exitEmitter = new EventEmitter();
  let exited = false;
  return {
    calls,
    stdout,
    exit: new Promise((res) => exitEmitter.once("done", res)),
    write(b) {
      calls.write.push(Buffer.from(b));
    },
    eof() {
      calls.eof++;
    },
    resize(c, r) {
      calls.resize.push([c, r]);
    },
    signal(s) {
      calls.signal.push(s);
    },
    kill() {
      calls.kill++;
    },
    // test control
    emitOut(text) {
      stdout.write(text);
    },
    emitExit(code = exitCode) {
      if (exited) return;
      exited = true;
      stdout.end();
      exitEmitter.emit("done", { state: "exited", exit: code });
    },
    emitError(msg) {
      if (exited) return;
      exited = true;
      stdout.end();
      exitEmitter.emit("done", { state: "error", exit: null, message: msg });
    },
    _out: out,
  };
}

function fakeBot(over = {}) {
  return { id: "b1", name: "b1", conversationId: "conv-1", model: MODEL, createdAt: new Date().toISOString(), ...over };
}

async function makeWorld({ spawn, ptySession } = {}) {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "req-1",
    projectId: project.id,
    name: "w1",
    baseBranch: "main",
    branch: "b1",
    cwd: ROOT,
    model: MODEL,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-aaaaaaaaaa" });
  const bots = {
    map: {},
    get(id) {
      return this.map[id];
    },
    list() {
      return Object.values(this.map);
    },
  };
  const spawnCalls = [];
  const spawnFactory =
    spawn ??
    (async (args) => {
      spawnCalls.push(args);
      const s = fakeShell();
      spawnFactory.shell = s;
      return s;
    });
  spawnFactory.calls = spawnCalls;
  let ptyCalls = 0;
  const ctxPty = ptySession ?? (async () => (ptyCalls++, spawnFactory));
  const api = createApi({
    harness: {},
    bots,
    routes: [
      (a) => Object.assign(a.ctx, { bots, control: store, ptySession: ctxPty }),
      (a) => registerTerminal(a, { spawn }),
    ],
  });
  const { port } = await api.listen(0);

  function connect(botId, path = "terminal/pty") {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/api/bots/${botId}/${path}`);
    const frames = [];
    const waiters = new Set();
    const state = { closeCode: undefined, closed: false };
    const settle = () => {
      for (const w of [...waiters]) if (w.check()) waiters.delete(w);
    };
    sock.addEventListener("message", (ev) => {
      const f = JSON.parse(String(ev.data));
      frames.push(f);
      settle();
    });
    sock.addEventListener("close", (ev) => {
      state.closed = true;
      state.closeCode = ev.code;
      settle();
    });
    sock.addEventListener("error", () => {});
    return {
      sock,
      frames,
      state,
      send: (msg) => sock.send(JSON.stringify(msg)),
      end: () => {
        try {
          sock.close();
        } catch {
          /* closed */
        }
      },
      waitFor(pred, what = "frame") {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(w);
            reject(new Error(`timed out waiting for ${what}; frames: ${JSON.stringify(frames)}`));
          }, TIMEOUT_MS);
          const w = {
            check: () => {
              const hit = frames.find(pred);
              if (hit !== undefined) {
                clearTimeout(timer);
                resolve(hit);
                return true;
              }
              if (state.closed) {
                clearTimeout(timer);
                reject(new Error(`socket closed (code ${state.closeCode}) before ${what}; frames: ${JSON.stringify(frames)}`));
                return true;
              }
              return false;
            },
          };
          waiters.add(w);
          settle();
        });
      },
      waitClose() {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(w);
            reject(new Error("timed out waiting for close"));
          }, TIMEOUT_MS);
          const w = {
            check: () => {
              if (state.closed) {
                clearTimeout(timer);
                resolve(state.closeCode);
                return true;
              }
              return false;
            },
          };
          waiters.add(w);
          settle();
        });
      },
    };
  }

  return {
    store,
    workspace,
    bots,
    api,
    connect,
    spawnCalls,
    get ptyCalls() {
      return ptyCalls;
    },
    seed(bot = fakeBot()) {
      bots.map[bot.id] = bot;
      store.links.link({ conversationId: String(bot.conversationId), workspaceId: workspace.id, botId: bot.id });
      return bot;
    },
    async close() {
      await api.close();
      store.close();
    },
  };
}

test("pty route is not registered without ptySession (warns; console unaffected)", { timeout: TIMEOUT_MS }, () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    registerTerminal({ ctx: { bots: {}, control: {} }, ws: () => {} });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 2); // console: no runtimeBash; pty: no ptySession
});

test("pty ws: session without a linked workspace -> error + 4409, factory never called", { timeout: TIMEOUT_MS }, async () => {
  const w = await makeWorld();
  try {
    w.bots.map.b1 = fakeBot(); // no link
    const c = w.connect("b1");
    const code = await c.waitClose();
    assert.equal(code, 4409);
    assert.match(c.frames.find((f) => f.type === "error")?.message ?? "", /no linked workspace/);
    assert.equal(w.ptyCalls, 0);
  } finally {
    await w.close();
  }
});

test("pty ws: ready carries session root; start spawns with server cwd + clamped dims; in/out round-trips bytes", {
  timeout: TIMEOUT_MS,
}, async () => {
  const shell = fakeShell();
  const spawn = async (args) => {
    spawn.args = args;
    return shell;
  };
  const w = await makeWorld({ spawn });
  try {
    const bot = fakeBot({ worktree: { baseBranch: "main", pinnedSha: "a".repeat(40), dir: "/home/sprite/sessions/x" } });
    w.seed(bot);
    const c = w.connect("b1");
    const ready = await c.waitFor((f) => f.type === "ready", "ready");
    assert.equal(ready.root, "/home/sprite/sessions/x");
    c.send({ type: "start", cols: 5000, rows: 1, env: { TERM: "xterm-256color", SECRET: "x" } });
    const started = await c.waitFor((f) => f.type === "started", "started");
    // dims are clamped to protocol limits (5000 -> 1000, 1 -> default 24)
    assert.deepEqual(spawn.args, { cwd: "/home/sprite/sessions/x", cols: 1000, rows: 24, env: { TERM: "xterm-256color", SECRET: "x" } });
    assert.equal(started.cols, 1000);
    // stdin bytes reach the shell verbatim
    c.send({ type: "in", data: Buffer.from("ls\n").toString("base64") });
    c.send({ type: "resize", cols: 120, rows: 40 });
    c.send({ type: "signal", signal: "SIGINT" });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(shell.calls.write.map((b) => b.toString()), ["ls\n"]);
    assert.deepEqual(shell.calls.resize, [[120, 40]]);
    assert.deepEqual(shell.calls.signal, ["SIGINT"]);
    // PTY output arrives as base64 (control bytes intact)
    shell.emitOut("$ \x1b[32mok\x1b[0m\n");
    const out = await c.waitFor((f) => f.type === "out", "out frame");
    assert.equal(Buffer.from(out.data, "base64").toString(), "$ \x1b[32mok\x1b[0m\n");
    // exit resolves with the code and closes the socket
    shell.emitExit(0);
    const exit = await c.waitFor((f) => f.type === "exit", "exit");
    assert.deepEqual(exit, { type: "exit", state: "exited", exit: 0 });
    assert.equal(await c.waitClose(), 1000);
  } finally {
    await w.close();
  }
});

test("pty ws: a second start is refused; input before start errors; non-base64 input errors", { timeout: TIMEOUT_MS }, async () => {
  const shell = fakeShell();
  let spawns = 0;
  const w = await makeWorld({ spawn: async () => (spawns++, shell) });
  try {
    w.seed();
    const c = w.connect("b1");
    await c.waitFor((f) => f.type === "ready", "ready");
    c.send({ type: "in", data: "eA==" });
    await c.waitFor((f) => f.type === "error" && /no shell/.test(f.message), "no-shell error");
    c.send({ type: "start", cols: 80, rows: 24 });
    await c.waitFor((f) => f.type === "started", "started");
    c.send({ type: "start", cols: 80, rows: 24 });
    await c.waitFor((f) => f.type === "error" && /already running/.test(f.message), "second-start error");
    assert.equal(spawns, 1);
    c.send({ type: "in", data: "not base64!!!" });
    await c.waitFor((f) => f.type === "error" && /base64/.test(f.message), "base64 error");
    c.send({ type: "signal", signal: "SIGUSR1" });
    await c.waitFor((f) => f.type === "error" && /not allowed/.test(f.message), "signal error");
    assert.equal(shell.calls.signal.length, 0);
    c.end();
  } finally {
    await w.close();
  }
});

test("pty ws: socket close kills the shell; close frame sends exit + 1000", { timeout: TIMEOUT_MS }, async () => {
  const shell = fakeShell();
  const w = await makeWorld({ spawn: async () => shell });
  try {
    w.seed();
    const c = w.connect("b1");
    await c.waitFor((f) => f.type === "ready", "ready");
    c.send({ type: "start", cols: 80, rows: 24 });
    await c.waitFor((f) => f.type === "started", "started");
    c.send({ type: "close" });
    const exit = await c.waitFor((f) => f.type === "exit", "close-exit");
    assert.equal(exit.state, "closed");
    assert.equal(await c.waitClose(), 1000);
    assert.equal(shell.calls.kill, 1, "shell was killed on close");
    // abrupt close also kills
    const shell2 = fakeShell();
    const w2 = await makeWorld({ spawn: async () => shell2 });
    try {
      w2.seed();
      const c2 = w2.connect("b1");
      await c2.waitFor((f) => f.type === "ready", "ready");
      c2.send({ type: "start", cols: 80, rows: 24 });
      await c2.waitFor((f) => f.type === "started", "started");
      c2.end();
      await c2.waitClose();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(shell2.calls.kill, 1, "shell killed on socket close");
    } finally {
      await w2.close();
    }
  } finally {
    await w.close();
  }
});

test("pty ws: spawn failure reports an error, socket stays usable; shell error reports message", { timeout: TIMEOUT_MS }, async () => {
  let n = 0;
  const shells = [null, fakeShell()];
  const w = await makeWorld({
    spawn: async () => {
      n++;
      if (n === 1) throw new Error("exec connection refused");
      return shells[1];
    },
  });
  try {
    w.seed();
    const c = w.connect("b1");
    await c.waitFor((f) => f.type === "ready", "ready");
    c.send({ type: "start", cols: 80, rows: 24 });
    const err = await c.waitFor((f) => f.type === "error" && /could not start/.test(f.message), "spawn error");
    assert.match(err.message, /exec connection refused/);
    // The shell handle itself reporting an error lands as an exit frame with the (redacted) message.
    const w2 = await makeWorld({ spawn: async () => shells[1] });
    try {
      w2.seed();
      const c2 = w2.connect("b1");
      await c2.waitFor((f) => f.type === "ready", "ready");
      c2.send({ type: "start", cols: 80, rows: 24 });
      await c2.waitFor((f) => f.type === "started", "started");
      shells[1].emitError("wss://sprites/exec?cmd=secret-argv dropped");
      const exit = await c2.waitFor((f) => f.type === "exit" && f.state === "error", "error exit");
      assert.match(exit.message, /dropped/);
      assert.equal(await c2.waitClose(), 1000);
    } finally {
      await w2.close();
    }
    c.end();
  } finally {
    await w.close();
  }
});

test("pty ws: the console path is a different endpoint (PTY world without runtimeBash -> no console socket)", { timeout: TIMEOUT_MS }, async () => {
  const w = await makeWorld();
  try {
    w.seed();
    // console route is not registered in this world (no runtimeBash in ctx) -> unknown ws path -> refused
    const sock = new WebSocket(`ws://127.0.0.1:${w.api.server.address().port}/api/bots/b1/terminal`);
    const outcome = await new Promise((res) => {
      sock.addEventListener("open", () => res("open"));
      sock.addEventListener("error", () => res("refused"));
      sock.addEventListener("close", (e) => res(`closed:${e.code}`));
    });
    assert.notEqual(outcome, "open", "an unregistered ws path must not upgrade");
  } finally {
    await w.close();
  }
});

// ---- provider.pty factory (guard + handle contract over a fake SDK) -----------------------------------------

test("provider.pty: refuses unmanaged names; returns a per-workspace factory that spawns tty without GH_TOKEN", {
  timeout: TIMEOUT_MS,
}, async () => {
  const TOKEN = "ghp_SECRETTOKEN1234567890";
  const spawnCalls = [];
  const client = {
    async getSprite() {
      return { name: "pca-aaaaaaaaaa", labels: [] };
    },
    sprite(name) {
      return {
        spawn: (cmd, args, o) => {
          spawnCalls.push({ name, cmd, args, o });
          const cmd_ = new EventEmitter();
          cmd_.stdin = new PassThrough();
          cmd_.stdout = new PassThrough();
          cmd_.stderr = new PassThrough();
          cmd_.resize = (c, r) => (cmd_.resized = [c, r]);
          cmd_.signal = (s) => (cmd_.signalled = s);
          cmd_.kill = (s) => (cmd_.killed = s);
          cmd_.close = () => (cmd_.closed = true);
          setImmediate(() => cmd_.emit("spawn"));
          spawnCalls.at(-1).handle = cmd_;
          return cmd_;
        },
      };
    },
  };
  const p = createSpritesProvider({ client, ghToken: TOKEN, gitEmail: "b@x", legacyNames: [] });
  for (const name of ["pi-cloud-agents", "other", "", undefined]) {
    assert.throws(() => p.pty(name), /refusing interactive session/);
  }
  assert.equal(spawnCalls.length, 0);
  const factory = p.pty("pca-aaaaaaaaaa"); // name-rule only (no platform labels in the fake)
  const shell = await factory({ cwd: "/home/sprite/x", cols: 132, rows: 43, env: { TERM: "xterm", GH_TOKEN: "nope", HOME: "/h" } });
  const call = spawnCalls[0];
  assert.equal(call.name, "pca-aaaaaaaaaa");
  assert.equal(call.o.tty, true);
  assert.equal(call.o.cwd, "/home/sprite/x");
  assert.equal(call.o.cols, 132);
  assert.equal(call.o.rows, 43);
  assert.deepEqual(call.o.env, { TERM: "xterm" }, "env is filtered to the display allowlist — no GH_TOKEN, no arbitrary vars");
  assert.equal(call.cmd, "/bin/sh");
  assert.match(call.args.join(" "), /SHELL:-\/bin\/bash/);
  // handle contract
  shell.write("pwd\n");
  shell.resize(200, 50);
  shell.signal("SIGINT");
  assert.deepEqual(call.handle.resized, [200, 50]);
  assert.equal(call.handle.signalled, "SIGINT");
  assert.equal(call.handle.stdin.read()?.toString(), "pwd\n");
  shell.kill();
  assert.equal(call.handle.killed, "SIGKILL");
  assert.equal(call.handle.closed, true);
  // cwd must be absolute
  await assert.rejects(() => factory({ cwd: "relative/dir" }), /absolute cwd/);
});
