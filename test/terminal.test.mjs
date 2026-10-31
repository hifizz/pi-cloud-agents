// Offline tests for src/terminal-env.mjs + src/routes/terminal.mjs. A real HTTP server (createApi)
// serves the WebSocket; the runner client is a scriptable fake (runner.sh itself is covered by
// test/runner.test.mjs). Frames and close codes are the ones a browser sees. No network, no Sprite.
// Every session waits on an explicit frame predicate OR the socket's close — never a bare event —
// and each test carries a hard timeout so a protocol regression fails instead of hanging.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { register as registerTerminal } from "../src/routes/terminal.mjs";

const MODEL = { provider: "faux", modelId: "faux-1" };
const ROOT = "/home/sprite/workspace/app";
const TIMEOUT_MS = 10_000;

/** Scriptable runner fake: records calls, replays `waits` then exits with `exit`. */
function fakeRunner({ waits = [], exit = 0 } = {}) {
  const calls = { install: 0, prepare: [], start: [], wait: 0, kill: [] };
  let waitIndex = 0;
  return {
    calls,
    async install() {
      calls.install++;
      return { installed: true, version: 2 };
    },
    async prepare(args) {
      calls.prepare.push(args);
      return { prepared: "new", state: "claimed" };
    },
    async start(id) {
      calls.start.push(id);
      return { started: "new", state: "running" };
    },
    async wait() {
      calls.wait++;
      const next = waits[waitIndex] ?? { state: "exited", exit, text: "", offset: undefined };
      waitIndex++;
      return next;
    },
    async kill(id, opts) {
      calls.kill.push([id, opts]);
      return { killed: "confirmed", state: "exited", exit: 143 };
    },
  };
}

function fakeBot(over = {}) {
  return { id: "b1", name: "b1", conversationId: "conv-1", model: MODEL, createdAt: new Date().toISOString(), ...over };
}

async function makeWorld({ runner } = {}) {
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
  store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "rt-1" });
  const bots = {
    map: {},
    get(id) {
      return this.map[id];
    },
    list() {
      return Object.values(this.map);
    },
  };
  let bashCalls = 0;
  const runtimeBash = async () => {
    bashCalls++;
    return async () => ({ stdout: "", stderr: "", exitCode: 0 });
  };
  const api = createApi({
    harness: {},
    bots,
    routes: [
      (a) => Object.assign(a.ctx, { bots, control: store, runtimeBash }),
      (a) => registerTerminal(a, { runner }),
    ],
  });
  const { port } = await api.listen(0);

  /** Open a socket and collect frames. `waitFor(pred)` resolves on the first matching frame OR rejects
   * on close/error/timeout — a test never awaits a frame that may never come. Call `end()` to close. */
  function connect(botId) {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/api/bots/${botId}/terminal`);
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
      /** Resolves with the close code once the socket has closed (or rejects on timeout). */
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
    get bashCalls() {
      return bashCalls;
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

test("route is not registered without ctx (one warning per missing route)", { timeout: TIMEOUT_MS }, () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    registerTerminal({ ctx: {}, ws: () => {} });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 2); // console (no runtimeBash) + pty (no ptySession)
});

test("ws: ready carries the session root; a run streams out + exit with the real code", { timeout: TIMEOUT_MS }, async () => {
  const runner = fakeRunner({
    waits: [
      { state: "running", text: "hello\n", offset: 6 },
      { state: "exited", exit: 3, text: "bye\n", offset: 10 },
    ],
  });
  const w = await makeWorld({ runner });
  try {
    const bot = fakeBot({ worktree: { baseBranch: "main", pinnedSha: "a".repeat(40), dir: "/home/sprite/sessions/x" } });
    w.seed(bot);
    const c = w.connect("b1");
    const ready = await c.waitFor((f) => f.type === "ready", "ready");
    assert.equal(ready.root, "/home/sprite/sessions/x");
    c.send({ type: "run", id: "r1", command: "echo hello; exit 3" });
    const exit = await c.waitFor((f) => f.type === "exit" && f.id === "r1", "exit");
    c.end();
    assert.equal(c.frames.find((f) => f.type === "started")?.id, "r1");
    assert.deepEqual(
      c.frames.filter((f) => f.type === "out").map((f) => f.data),
      ["hello\n", "bye\n"],
    );
    assert.deepEqual(exit, { type: "exit", id: "r1", state: "exited", exit: 3 });
    // the runner ran the command in the session dir, not the workspace cwd
    assert.equal(runner.calls.prepare[0].cwd, "/home/sprite/sessions/x");
    assert.equal(runner.calls.prepare[0].command, "echo hello; exit 3");
  } finally {
    await w.close();
  }
});

test("ws: kill forwards to runner.kill (sent after started, resolved on killing)", { timeout: TIMEOUT_MS }, async () => {
  // The fake wait long-polls for ~50 ms each call so the run is still alive when the kill arrives.
  const runner = {
    calls: { install: 0, prepare: [], start: [], wait: 0, kill: [] },
    async install() {
      this.calls.install++;
      return { installed: true, version: 2 };
    },
    async prepare(args) {
      this.calls.prepare.push(args);
      return { prepared: "new", state: "claimed" };
    },
    async start(id) {
      this.calls.start.push(id);
      return { started: "new", state: "running" };
    },
    async wait() {
      this.calls.wait++;
      await new Promise((r) => setTimeout(r, 50));
      return { state: "running", text: "", offset: 0 };
    },
    async kill(id, opts) {
      this.calls.kill.push([id, opts]);
      return { killed: "confirmed", state: "exited", exit: 143 };
    },
  };
  const w = await makeWorld({ runner });
  try {
    w.seed();
    const c = w.connect("b1");
    await c.waitFor((f) => f.type === "ready", "ready");
    c.send({ type: "run", id: "r1", command: "sleep 99" });
    await c.waitFor((f) => f.type === "started" && f.id === "r1", "started");
    c.send({ type: "kill", id: "r1" });
    await c.waitFor((f) => f.type === "killing" && f.id === "r1", "killing");
    c.end();
    assert.equal(runner.calls.kill.length, 1, "runner.kill was called for the live run");
  } finally {
    await w.close();
  }
});

test("ws: a dangerous command is denied by the shared classifier, never prepared", { timeout: TIMEOUT_MS }, async () => {
  const runner = fakeRunner();
  const w = await makeWorld({ runner });
  try {
    w.seed();
    const c = w.connect("b1");
    await c.waitFor((f) => f.type === "ready", "ready");
    c.send({ type: "run", id: "r1", command: "rm -rf /" });
    const denied = await c.waitFor((f) => f.type === "denied" && f.id === "r1", "denied");
    assert.match(denied.reason, /rm -rf|recursive force delete/);
    c.end();
    assert.equal(runner.calls.prepare.length, 0, "nothing was staged");
  } finally {
    await w.close();
  }
});

test("ws: a killed run ends with a confirmed exit frame; the next command can run (regression: kill left the console stuck at [killing…])", { timeout: TIMEOUT_MS }, async () => {
  // runner.wait returns `running` until kill() is observed, then a terminal exited state — like runner.sh.
  const runner = {
    calls: { kill: [] },
    killed: false,
    killedId: undefined,
    async install() {
      return { installed: true, version: 2 };
    },
    async prepare() {
      return { prepared: "new", state: "claimed" };
    },
    async start() {
      return { started: "new", state: "running" };
    },
    async wait({ id }) {
      await new Promise((r) => setTimeout(r, 20));
      if (this.killed && id === this.killedId) return { state: "exited", exit: 143, text: "", offset: 0 };
      return { state: "running", text: "", offset: 0 };
    },
    async kill(id, opts) {
      this.calls.kill.push([id, opts]);
      this.killed = true;
      this.killedId = id;
      return { killed: "confirmed", state: "exited", exit: 143 };
    },
  };
  const w = await makeWorld({ runner });
  try {
    w.seed();
    const c = w.connect("b1");
    await c.waitFor((f) => f.type === "ready", "ready");
    c.send({ type: "run", id: "r1", command: "sleep 30" });
    await c.waitFor((f) => f.type === "started" && f.id === "r1", "started");
    c.send({ type: "kill", id: "r1" });
    await c.waitFor((f) => f.type === "killing" && f.id === "r1", "killing");
    // The loop keeps polling after cancel: the runner reports the terminal state and the client gets
    // a final exit frame (previously the socket just went silent and the UI stayed "running").
    const exit = await c.waitFor((f) => f.type === "exit" && f.id === "r1", "exit after kill");
    assert.equal(exit.state, "exited");
    assert.equal(exit.exit, 143);
    // A new command on the same socket runs normally afterwards.
    c.send({ type: "run", id: "r2", command: "echo next" });
    await c.waitFor((f) => f.type === "started" && f.id === "r2", "started r2");
    c.send({ type: "kill", id: "r2" });
    await c.waitFor((f) => f.type === "exit" && f.id === "r2", "exit r2");
    c.end();
  } finally {
    await w.close();
  }
});

test("ws: session without a linked workspace -> error frame then 4409 close, no runtimeBash", { timeout: TIMEOUT_MS }, async () => {
  const w = await makeWorld({ runner: fakeRunner() });
  try {
    w.bots.map.b1 = fakeBot(); // no link seeded
    const c = w.connect("b1");
    const code = await c.waitClose();
    assert.equal(code, 4409);
    assert.match(c.frames.find((f) => f.type === "error")?.message ?? "", /no linked workspace/);
    assert.equal(w.bashCalls, 0);
    // an unknown bot behaves the same (not found message, still no bash)
    const again = w.connect("nope");
    const code2 = await again.waitClose();
    assert.equal(code2, 4409);
    assert.match(again.frames.find((f) => f.type === "error")?.message ?? "", /bot not found/);
    assert.equal(w.bashCalls, 0);
  } finally {
    await w.close();
  }
});
