// Offline tests for src/files-env.mjs + src/routes/files.mjs. The "sandbox" is a local mkdtemp tree:
// the bash primitive runs `/bin/sh -c` against it, so realpath/stat/base64 semantics are the real
// POSIX ones a Sprite provides. A real HTTP server (createApi) serves the route so status codes are
// the ones a browser sees. No network, no Sprite, no .env.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { register as registerFiles } from "../src/routes/files.mjs";
import { createFilesEnv } from "../src/files-env.mjs";

const MODEL = { provider: "faux", modelId: "faux-1" };

/** GNU coreutils dir (Sprites are Linux): stat -c / base64 -w0 / realpath -e are GNU-only flags. */
const GNU_BIN = ["/opt/homebrew/opt/coreutils/libexec/gnubin", "/usr/local/opt/coreutils/libexec/gnubin"].find((d) => existsSync(join(d, "stat")));
const SKIP = GNU_BIN ? false : "needs GNU coreutils (Sprites run GNU stat/base64; macOS default is BSD)";

/** Local stand-in for the Sprite bash primitive, executing in `root` (a real dir) with the GNU toolchain. */
function localBash(root) {
  const calls = [];
  const fn = (command, { timeoutMs = 30_000 } = {}) =>
    new Promise((resolve, reject) => {
      calls.push(command);
      const env = { ...process.env, HOME: root, PATH: GNU_BIN ? `${GNU_BIN}:${process.env.PATH}` : process.env.PATH };
      const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"] });
      const out = [];
      const err = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), exitCode: code ?? -1, timedOut });
      });
    });
  fn.calls = calls;
  return fn;
}

function fakeBot(over = {}) {
  return {
    id: "b1",
    name: "b1",
    conversationId: "conv-1",
    model: MODEL,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** Seed a ready workspace + binding + link for `bot`. Returns the workspace. */
function seed(store, ws, bot) {
  store.workspaces.update(ws.id, { status: "ready" });
  store.bindings.bind(ws.id, { provider: "sprites", runtimeId: "rt-1" });
  store.links.link({ conversationId: String(bot.conversationId), workspaceId: ws.id, botId: bot.id });
  return ws;
}

async function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), "pca-files-test-"));
  const repoDir = join(root, "repo");
  const sessionDir = join(root, "sessions", "s1");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "hello repo\n");
  writeFileSync(join(sessionDir, "note.txt"), "session note\n");
  mkdirSync(join(sessionDir, "sub"));
  writeFileSync(join(sessionDir, "sub", "inner.txt"), "inner\n");
  writeFileSync(join(sessionDir, ".env"), "SECRET=topsecret\n");
  mkdirSync(join(sessionDir, ".git"));
  writeFileSync(join(sessionDir, ".git", "config"), "[core]\n");
  symlinkSync(join(repoDir, "README.md"), join(sessionDir, "outside-link"));
  symlinkSync("sub", join(sessionDir, "inside-link"));

  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "req-1",
    projectId: project.id,
    name: "w1",
    baseBranch: "main",
    branch: "b1",
    cwd: repoDir,
    model: MODEL,
  });

  const bash = localBash(root);
  const bots = {
    map: {},
    get(id) {
      return this.map[id];
    },
    list() {
      return Object.values(this.map);
    },
  };
  const app = {
    ctx: {
      bots,
      control: store,
      runtimeBash: async (wsId) => (wsId === workspace.id ? bash : null),
      homeDir: () => root,
    },
  };
  const inject = (a) => Object.assign(a.ctx, { bots, control: store, runtimeBash: app.ctx.runtimeBash, homeDir: app.ctx.homeDir });
  const api = createApi({ harness: {}, bots, routes: [inject, registerFiles] });
  const { port } = await api.listen(0);
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    assert.ok(!text.includes("topsecret"), `response leaks a secret: ${text.slice(0, 200)}`);
    return { status: res.status, json, text };
  };
  return {
    root,
    repoDir,
    sessionDir,
    store,
    workspace,
    bots,
    bash,
    app,
    call,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    async close() {
      await api.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function withWorld(fn) {
  const w = await makeWorld();
  try {
    await fn(w);
  } finally {
    await w.close();
  }
}

test("route is not registered without ctx (one warning)", () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    for (const ctxObj of [{}, { bots: {} }, { bots: {}, control: {} }, { control: {}, runtimeBash: () => {} }]) {
      const routes = [];
      registerFiles({ ctx: ctxObj, get: (p) => routes.push(p), post: (p) => routes.push(p) });
      assert.deepEqual(routes, []);
    }
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 4);
});

test("session root: bot's own session dir wins over workspace cwd", () =>
  withWorld(async (w) => {
    const bot = fakeBot({ worktree: { baseBranch: "main", pinnedSha: "a".repeat(40), dir: w.sessionDir } });
    w.bots.map.b1 = bot;
    seed(w.store, w.workspace, bot);
    const env = await createFilesEnv(w.app, "b1");
    assert.equal(env.root, realpathSync(w.sessionDir), "the bot's own session dir wins (canonicalized)");
    const wsOnly = fakeBot({ id: "b-ws" });
    w.bots.map["b-ws"] = wsOnly;
    seed(w.store, w.workspace, wsOnly);
    const env2 = await createFilesEnv(w.app, "b-ws");
    assert.equal(env2.root, realpathSync(w.repoDir), "no session dir -> workspace cwd");
  }));

test("list / read / write round trip inside the session dir", () =>
  withWorld(async (w) => {
    const bot = fakeBot({ worktree: { baseBranch: "main", pinnedSha: "a".repeat(40), dir: w.sessionDir } });
    w.bots.map.b1 = bot;
    seed(w.store, w.workspace, bot);
    const list = await w.get("/api/bots/b1/files/list?path=.");
    assert.equal(list.status, 200, list.text);
    const names = list.json.entries.map((e) => e.name);
    assert.ok(names.includes("note.txt"));
    assert.ok(names.includes("sub"));
    const read = await w.get(`/api/bots/b1/files/read?path=${encodeURIComponent("note.txt")}`);
    assert.equal(read.status, 200);
    assert.equal(Buffer.from(read.json.base64, "base64").toString("utf8"), "session note\n");

    const write = await w.post("/api/bots/b1/files/write", { path: "sub/new.txt", base64: Buffer.from("fresh\n").toString("base64") });
    assert.equal(write.status, 200, write.text);
    const reread = await w.get(`/api/bots/b1/files/read?path=${encodeURIComponent("sub/new.txt")}`);
    assert.equal(Buffer.from(reread.json.base64, "base64").toString("utf8"), "fresh\n");
  }));

test("confined to the session root: .., absolute and symlink escapes refused", () =>
  withWorld(async (w) => {
    const bot = fakeBot({ worktree: { baseBranch: "main", pinnedSha: "a".repeat(40), dir: w.sessionDir } });
    w.bots.map.b1 = bot;
    seed(w.store, w.workspace, bot);
    for (const p of ["../repo/README.md", "..", "/etc/passwd", "outside-link", `${w.repoDir}/README.md`]) {
      const r = await w.get(`/api/bots/b1/files/read?path=${encodeURIComponent(p)}`);
      assert.equal(r.status, 403, `${p}: ${r.status} ${r.text}`);
    }
    // a symlink that resolves INSIDE the root still resolves and reads fine
    const inside = await w.get(`/api/bots/b1/files/read?path=${encodeURIComponent("inside-link/inner.txt")}`);
    assert.equal(inside.status, 200, inside.text);
    assert.equal(Buffer.from(inside.json.base64, "base64").toString("utf8"), "inner\n");
  }));

test(".env and .git are protected from read and write", () =>
  withWorld(async (w) => {
    const bot = fakeBot({ worktree: { baseBranch: "main", pinnedSha: "a".repeat(40), dir: w.sessionDir } });
    w.bots.map.b1 = bot;
    seed(w.store, w.workspace, bot);
    for (const p of [".env", ".env.local", ".env.production", ".git/config", ".git"]) {
      const r = await w.get(`/api/bots/b1/files/read?path=${encodeURIComponent(p)}`);
      assert.equal(r.status, 403, `${p}: ${r.status} ${r.text}`);
    }
    const wr = await w.post("/api/bots/b1/files/write", { path: ".env.production", base64: Buffer.from("x").toString("base64") });
    assert.equal(wr.status, 403, wr.text);
  }));

test("existing file needs overwrite:true; a fresh write reports the path back", () =>
  withWorld(async (w) => {
    const bot = fakeBot({ worktree: { baseBranch: "main", pinnedSha: "a".repeat(40), dir: w.sessionDir } });
    w.bots.map.b1 = bot;
    seed(w.store, w.workspace, bot);
    const first = await w.post("/api/bots/b1/files/write", { path: "note.txt", base64: Buffer.from("changed").toString("base64") });
    assert.equal(first.status, 409, first.text);
    const second = await w.post("/api/bots/b1/files/write", { path: "note.txt", base64: Buffer.from("changed").toString("base64"), overwrite: true });
    assert.equal(second.status, 200, second.text);
    const read = await w.get(`/api/bots/b1/files/read?path=${encodeURIComponent("note.txt")}`);
    assert.equal(Buffer.from(read.json.base64, "base64").toString("utf8"), "changed");
    const missing = await w.post("/api/bots/b1/files/write", { path: "no/such/dir/x", base64: Buffer.from("x").toString("base64") });
    assert.equal(missing.status, 404, missing.text);
  }));

test("bot without a linked workspace / not ready -> 409, no runtimeBash call", () =>
  withWorld(async (w) => {
    const bot = fakeBot();
    w.bots.map.b1 = bot;
    let calls = 0;
    const orig = w.app.ctx.runtimeBash;
    w.app.ctx.runtimeBash = async (...a) => {
      calls++;
      return orig(...a);
    };
    const r1 = await w.get("/api/bots/b1/files/list?path=.");
    assert.equal(r1.status, 409, r1.text);
    seed(w.store, w.workspace, bot);
    w.store.workspaces.update(w.workspace.id, { status: "preparing" });
    const r2 = await w.get("/api/bots/b1/files/list?path=.");
    assert.equal(r2.status, 409, r2.text);
    assert.equal(calls, 0, "runtimeBash is not consulted before the session is proven ready");
    assert.equal((await w.get("/api/bots/nope/files/list?path=.")).status, 404);
    w.app.ctx.runtimeBash = orig;
  }));
