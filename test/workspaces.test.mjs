// Offline tests for src/workspaces.mjs (M1-07). No network, no real Sprite, no real model.
//  - control store: a real file-backed sqlite in a temp dir (openControlStore({ path })); a "kill" = close it and open
//    the same file again with a brand-new service instance (the old instance is parked forever at a hook point and
//    never touches anything again, like a dead process).
//  - runner: an in-memory fake that really runs the commands on this machine (git against a local "remote"), keeps its
//    state across service instances (like a Sprite does) and honours the §4.4 contract (prepare = atomic claim,
//    start only from `claimed`).
//  - Pi Durable: a real Harness on file sqlite with fauxProvider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openControlStore } from "../src/control/store.mjs";
import { createSpritesProvider, APP_LABEL } from "../src/providers/sprites.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { ctx, openHarness } from "../src/harness.mjs";
import { createWorkspaceService, isUncertain, slugify, workspaceInstructions } from "../src/workspaces.mjs";

const REPEAT = 10;
const FAUX = { provider: "faux", modelId: "faux-1" };
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const hang = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- shared fixtures: local "remote" repositories and a git shim that counts invocations ------------------------------
const ROOT = mkdtempSync(join(tmpdir(), "m107-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const SHIM_DIR = join(ROOT, "bin");
mkdirSync(SHIM_DIR);
writeFileSync(join(SHIM_DIR, "git"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "$PCA_GIT_LOG"\nexec ${REAL_GIT} "$@"\n`);
chmodSync(join(SHIM_DIR, "git"), 0o755);

function makeRemote(name, file) {
  const dir = join(ROOT, "remotes", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, file), `${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return { path: dir, sha: git(dir, "rev-parse", "HEAD") };
}
const REMOTES = { "acme/app": makeRemote("app", "README.md"), "acme/other": makeRemote("other", "OTHER.md"), "acme/third": makeRemote("third", "THIRD.md") };

// ---- fake collaborators ----------------------------------------------------------------------------------------------
function fakeGithub(world) {
  return {
    async listRepos() {
      await world.fire("github.listRepos");
      return Object.keys(REMOTES).map((fullName) => ({ fullName, defaultBranch: "main", private: false }));
    },
    async listBranches(repo) {
      return REMOTES[repo] ? [{ name: "main", sha: REMOTES[repo].sha }] : [];
    },
    async getBranch(repo, name) {
      if (world.branchMissing) return null;
      return REMOTES[repo] && name === "main" ? { name, sha: REMOTES[repo].sha } : null;
    },
  };
}

function fakeProvider(world) {
  const p = {
    kind: "sprites",
    home: world.home,
    sprites: new Set(),
    creates: [],
    ensures: 0,
    inits: [],
    ensureError: null,
    runtimeName: (rid) => `pca-${sha256(rid).slice(0, 10)}`,
    async ensure({ requestId }) {
      p.ensures++;
      if (p.ensureError) throw p.ensureError;
      await world.fire("provider.beforeEnsure");
      const name = p.runtimeName(requestId);
      const created = !p.sprites.has(name);
      if (created) {
        p.sprites.add(name);
        p.creates.push(name);
      }
      await world.fire("provider.afterEnsure"); // Sprite exists, binding not written yet
      return { runtimeId: name, created };
    },
    async init(runtimeId) {
      p.inits.push(runtimeId);
    },
    bash() {
      throw new Error("provider.bash must not be used when runnerFor is injected");
    },
  };
  return p;
}

function fakeRunner(world) {
  const runs = new Map();
  const r = {
    runs,
    calls: [],
    installs: 0,
    async install() {
      r.installs++;
      await world.fire("runner.afterInstall");
    },
    async prepare({ id, cwd, command, env }) {
      assert.equal(env, undefined, "the workspace service must not pass env to the runner");
      r.calls.push(["prepare", id]);
      if (!runs.has(id)) runs.set(id, { cwd, command, state: "claimed", log: Buffer.alloc(0), exit: null });
      await world.fire("runner.afterPrepare");
      return { state: runs.get(id).state };
    },
    async start(id) {
      r.calls.push(["start", id]);
      await world.fire("runner.beforeStart");
      const run = runs.get(id);
      if (!run) throw new Error("start: unknown run");
      if (run.state !== "claimed") return { state: run.state };
      mkdirSync(run.cwd, { recursive: true });
      const child = spawn("sh", ["-c", run.command], {
        cwd: run.cwd,
        env: { ...GIT_ENV, PATH: `${SHIM_DIR}:${process.env.PATH}`, PCA_GIT_LOG: world.gitLog },
        stdio: ["ignore", "pipe", "pipe"],
      });
      run.state = "running";
      const add = (b) => {
        run.log = Buffer.concat([run.log, b]);
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      child.on("close", (code, sig) => {
        run.exit = code ?? (sig ? 128 : 1);
        run.state = "exited";
      });
      await world.fire("runner.afterStart");
      return { state: "running" };
    },
    async wait({ id, from, maxSeconds }) {
      const run = runs.get(id);
      if (!run) return { state: "missing", offset: from, data: "" };
      const deadline = Date.now() + maxSeconds * 1000;
      while (run.log.length <= from && run.state === "running" && Date.now() < deadline) await sleep(5);
      const chunk = run.log.subarray(from, from + 32768);
      const res = { state: run.state, exit: run.exit ?? undefined, offset: from + chunk.length, data: chunk.toString("utf8") };
      if (run.state === "exited") await world.fire("runner.afterWaitExited");
      return res;
    },
    async status(id) {
      const run = runs.get(id);
      return run ? { state: run.state, exit: run.exit ?? undefined } : { state: "missing" };
    },
    async kill() {
      return { killed: "not-found" };
    },
    started: () => r.calls.filter((c) => c[0] === "start" && runs.get(c[1])?.state !== "claimed").length,
  };
  return r;
}

function fauxModels(n = 6) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(Array.from({ length: n }, () => fauxAssistantMessage([fauxText("ok")])));
  return { f, models };
}

/** One isolated world: temp dir, control db file, Sprite home, runner, provider, github, harness + bots. */
async function makeWorld() {
  const dir = mkdtempSync(join(ROOT, "w-"));
  const world = {
    dir,
    home: join(dir, "home"),
    controlPath: join(dir, "control.sqlite"),
    botsPath: join(dir, "bots.json"),
    dbPath: join(dir, "alice.sqlite"),
    gitLog: join(dir, "git.log"),
    branchMissing: false,
    hooks: new Map(),
    harnesses: [],
  };
  mkdirSync(world.home, { recursive: true });
  writeFileSync(world.gitLog, "");

  world.arm = (name, { skip = 0 } = {}) => new Promise((resolve) => world.hooks.set(name, { skip, resolve }));
  world.fire = async (name) => {
    const h = world.hooks.get(name);
    if (!h) return;
    if (h.skip > 0) {
      h.skip--;
      return;
    }
    world.hooks.delete(name);
    h.resolve();
    await hang(); // the "process" is dead from here on
  };
  world.clones = () => readFileSync(world.gitLog, "utf8").split("\n").filter((l) => l === "clone").length;

  world.createBotCalls = [];
  world.reopenHarness = async () => {
    const old = world.harness;
    if (old) await old.close(ctx).catch(() => {});
    const { f, models } = fauxModels();
    const { harness } = await openHarness({ storage: await openNodeSqliteStorage(world.dbPath), models, resume: false });
    world.harness = harness;
    world.faux = f;
    const bots = new BotRegistry(harness, { path: world.botsPath });
    const createBot = bots.createBot.bind(bots);
    bots.createBot = async (spec) => {
      world.createBotCalls.push(spec);
      const bot = await createBot(spec);
      await world.fire("bots.afterCreate");
      return bot;
    };
    const conversation = bots.conversation.bind(bots);
    bots.conversation = async (id) => {
      const conv = await conversation(id);
      if (!conv) return conv;
      return new Proxy(conv, {
        get(target, key) {
          if (key === "submit") {
            return async (...args) => {
              const res = await target.submit(...args);
              await world.fire("conv.afterSubmit");
              return res;
            };
          }
          const v = target[key];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    };
    world.bots = bots;
  };
  await world.reopenHarness();

  world.github = fakeGithub(world);
  world.provider = fakeProvider(world);
  world.runner = fakeRunner(world);

  world.boot = (extra = {}) => {
    const store = openControlStore({ path: world.controlPath });
    const svc = createWorkspaceService({
      store,
      github: world.github,
      providers: { sprites: world.provider },
      bots: world.bots,
      ctx,
      runnerFor: () => world.runner,
      home: world.home,
      cloneUrl: (repo) => REMOTES[repo].path,
      defaultModel: () => FAUX,
      waitSeconds: 1,
      retryDelayMs: 1,
      ...extra,
    });
    return {
      store,
      svc,
      crash() {
        try {
          store.close();
        } catch {
          // already closed
        }
      },
    };
  };

  world.userMessages = async (conversationId) => {
    const conv = await world.harness.conversation(conversationId, ctx);
    const page = await conv.entries({}, 200, undefined, ctx);
    return page.items.filter((e) => e.model?.[0]?.role === "user").length;
  };
  world.runModel = async (conversationId) => {
    world.harness.resume();
    const conv = await world.harness.conversation(conversationId, ctx);
    await conv.waitForIdle(ctx);
  };
  world.dump = () => {
    const db = new DatabaseSync(world.controlPath, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
      return JSON.stringify(Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()])));
    } finally {
      db.close();
    }
  };
  world.dispose = async () => {
    await world.harness.close(ctx).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  };
  return world;
}

async function withWorld(fn) {
  const world = await makeWorld();
  try {
    await fn(world);
  } finally {
    await world.dispose();
  }
}

const input = (i, extra = {}) => ({ requestId: `req-${i}`, repo: "acme/app", task: "Fix the login bug", ...extra });

/** Everything a successful run must leave behind. */
function assertReady(world, store, id, { clones = 1 } = {}) {
  const ws = store.workspaces.get(id);
  assert.equal(ws.status, "ready", `status ${ws.status}: ${ws.error}`);
  assert.deepEqual(
    store.workspaces.steps(id).map((s) => s.state),
    ["done", "done", "done", "done", "done"],
  );
  assert.equal(store.bindings.history(id).length, 1, "exactly one binding");
  assert.equal(world.provider.creates.length, 1, "exactly one Sprite created");
  assert.equal(store.bindings.current(id).runtimeId, world.provider.creates[0]);
  assert.equal(store.links.conversationsOf(id).length, 1, "exactly one conversation");
  assert.equal(world.bots.list().length, 1, "exactly one Bot");
  assert.equal(world.clones(), clones, "clone count");
  assert.equal(git(ws.cwd, "rev-parse", "--abbrev-ref", "HEAD"), ws.branch);
  assert.equal(git(ws.cwd, "rev-parse", "HEAD"), REMOTES[ws.repo].sha);
  return ws;
}

// ---- pure helpers ----------------------------------------------------------------------------------------------------
test("slugify keeps [a-z0-9-] only and bounds the length", () => {
  assert.equal(slugify("Fix the Login Bug!!"), "fix-the-login-bug");
  assert.equal(slugify("  ---Hello___World---  "), "hello-world");
  assert.equal(slugify("修复登录"), "");
  assert.ok(slugify("a".repeat(100)).length <= 32);
  assert.ok(!slugify("x".repeat(31) + " y z").endsWith("-"));
});

test("isUncertain: 5xx / network errors are uncertain, 4xx and plain errors are not", () => {
  const sc = (statusCode) => Object.assign(new Error("x"), { statusCode });
  assert.equal(isUncertain(sc(503)), true);
  assert.equal(isUncertain(sc(500)), true);
  assert.equal(isUncertain(sc(401)), false);
  assert.equal(isUncertain(sc(404)), false);
  assert.equal(isUncertain(Object.assign(new Error("boom"), { code: "ECONNRESET" })), true);
  assert.equal(isUncertain(new Error("fetch failed")), true);
  assert.equal(isUncertain(new Error("Sprite exec connection ended without exit status; command may or may not have run")), true);
  assert.equal(isUncertain(new Error("命令退出码 1")), false);
});

test("workspaceInstructions: repo, cwd, branches, no re-clone, push only the work branch, no token", () => {
  const ws = { repo: "acme/app", cwd: "/home/sprite/workspace/app", branch: "tarsbot/fix-abc123", baseBranch: "main", baseCommit: "a".repeat(40) };
  const t = workspaceInstructions(ws);
  for (const s of ["acme/app", "/home/sprite/workspace/app", "tarsbot/fix-abc123", "main", "Do NOT clone", "do NOT create another branch", "gh pr list --head tarsbot/fix-abc123"]) {
    assert.ok(t.includes(s), `missing: ${s}`);
  }
  assert.ok(!/GH_TOKEN|ghp_|token/i.test(t));
});

// ---- create: validation, defaults, idempotence -----------------------------------------------------------------------
test("create validates input and fills defaults (branch, cwd, base branch, model)", async () => {
  await withWorld(async (w) => {
    const { store, svc } = w.boot();
    for (const bad of [
      null,
      { repo: "acme/app" },
      { requestId: "  ", repo: "acme/app" },
      { requestId: "r", repo: "acme" },
      { requestId: "r", repo: "acme/app/x" },
      { requestId: "r", repo: "acme/app", baseBranch: "bad branch" },
      { requestId: "r", repo: "acme/app", task: 5 },
      { requestId: "r", repo: "acme/app", modelId: "no spaces allowed" },
    ]) {
      await assert.rejects(() => svc.create(bad), (e) => e.code === "invalid", JSON.stringify(bad));
    }
    assert.equal(store.workspaces.list().length, 0);

    const ws = await svc.create({ requestId: "r1", repo: "acme/app", task: "Fix the Login Bug!!", modelId: "glm-5.3" });
    assert.match(ws.branch, /^tarsbot\/fix-the-login-bug-[0-9a-f]{6}$/);
    assert.equal(ws.cwd, `${w.home}/workspace/app`);
    assert.equal(ws.baseBranch, "main");
    assert.deepEqual(ws.model, { provider: "faux", modelId: "glm-5.3" });
    assert.equal(ws.status, "preparing");
    assert.deepEqual(store.workspaces.steps(ws.id).length, 5);

    const noTask = await svc.create({ requestId: "r2", repo: "acme/app" });
    assert.match(noTask.branch, /^tarsbot\/app-[0-9a-f]{6}$/);
    const cjk = await svc.create({ requestId: "r3", repo: "acme/app", task: "修复登录" });
    assert.match(cjk.branch, /^tarsbot\/app-[0-9a-f]{6}$/);
    assert.notEqual(noTask.branch, cjk.branch);
    await svc.idle();
    store.close();
  });
});

test("FT-M1-3: same requestId + same content x10 -> one workspace, one ensure; different content -> conflict", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const { store, svc } = w.boot();
      const first = await svc.create(input(i));
      const again = await Promise.all([svc.create(input(i)), svc.create(input(i)), svc.create(input(i))]);
      for (const a of again) assert.equal(a.id, first.id);
      await svc.idle();
      const later = await svc.create(input(i));
      assert.equal(later.id, first.id);
      await svc.idle();

      assert.equal(store.workspaces.list().length, 1);
      assert.equal(w.provider.ensures, 1, "one ensure call");
      assert.equal(w.provider.creates.length, 1);

      const before = JSON.stringify(store.workspaces.get(first.id));
      for (const changed of [{ task: "something else" }, { repo: "acme/other" }, { baseBranch: "dev" }, { modelId: "glm-5.3" }, { installCommand: "npm ci" }, { name: "x" }]) {
        await assert.rejects(
          () => svc.create({ ...input(i), ...changed }),
          (e) => e.code === "conflict" && /请求编号/.test(e.message),
          JSON.stringify(changed),
        );
      }
      await svc.idle();
      assert.equal(JSON.stringify(store.workspaces.get(first.id)), before, "original workspace unchanged");
      assert.equal(store.workspaces.list().length, 1);
      assert.equal(w.provider.ensures, 1);
      store.close();
    });
  }
});

test("kill between requests.begin and workspaces.create: the same request creates exactly one workspace", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const a = w.boot();
      const reached = w.arm("github.listRepos");
      a.svc.create(input(i)).catch(() => {});
      await reached;
      assert.equal(a.store.workspaces.list().length, 0);
      a.crash();

      const b = w.boot();
      const ws = await b.svc.create(input(i));
      await b.svc.idle();
      assert.equal(b.store.workspaces.list().length, 1);
      assertReady(w, b.store, ws.id);
      await assert.rejects(() => b.svc.create(input(i, { task: "different" })), (e) => e.code === "conflict");
      b.store.close();
    });
  }
});

// ---- full flow -------------------------------------------------------------------------------------------------------
test("full flow: ready, linked conversation, createBot gets cwd + instructions, first task submitted once", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const { store, svc } = w.boot();
      const created = await svc.create(input(i, { name: "login-fix" }));
      assert.equal(created.status, "preparing");
      await svc.idle();
      const ws = assertReady(w, store, created.id);

      assert.match(ws.branch, /^tarsbot\//);
      assert.equal(ws.baseCommit, REMOTES["acme/app"].sha);
      assert.equal(w.createBotCalls.length, 1);
      const spec = w.createBotCalls[0];
      assert.equal(spec.cwd, ws.cwd);
      assert.equal(spec.name, "login-fix");
      assert.deepEqual(spec.model, FAUX);
      assert.equal(spec.instructions, workspaceInstructions(ws));
      assert.equal(spec.extensions, undefined, "no per-bot extensions");
      assert.ok(spec.instructions.includes(ws.branch) && spec.instructions.includes(ws.cwd));

      const link = store.links.conversationsOf(ws.id)[0];
      assert.equal(link.botId, w.bots.list()[0].id);
      assert.equal(store.links.workspaceOf(link.conversationId).id, ws.id);
      assert.equal(store.intents.get(`ws:${ws.id}:task`).state, "confirmed");

      assert.deepEqual(w.runner.installs, 1);
      assert.deepEqual(w.provider.inits, [store.bindings.current(ws.id).runtimeId]);

      // resumePending / retry / run on a finished workspace do nothing more
      await svc.resumePending({ wait: true });
      assert.equal(svc.retry(ws.id).status, "ready");
      await svc.run(ws.id);
      await svc.idle();
      assert.equal(w.createBotCalls.length, 1);
      assert.equal(w.provider.ensures, 1);
      assert.equal(w.clones(), 1);

      await w.runModel(link.conversationId);
      assert.equal(await w.userMessages(link.conversationId), 1);
      assert.equal(w.faux.state.callCount, 1);
      store.close();
    });
  }
});

test("no task -> nothing is submitted", async () => {
  await withWorld(async (w) => {
    const { store, svc } = w.boot();
    const ws = await svc.create({ requestId: "nt", repo: "acme/app" });
    await svc.idle();
    assert.equal(store.workspaces.get(ws.id).status, "ready");
    const link = store.links.conversationsOf(ws.id)[0];
    await w.runModel(link.conversationId);
    assert.equal(await w.userMessages(link.conversationId), 0);
    assert.equal(w.faux.state.callCount, 0);
    store.close();
  });
});

// ---- runtime step ----------------------------------------------------------------------------------------------------
test("FT-M1-1: kill after ensure created the Sprite, before the binding: restart binds the same Sprite, no 2nd create", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const a = w.boot();
      const reached = w.arm("provider.afterEnsure");
      const created = await a.svc.create(input(i));
      await reached;
      assert.equal(w.provider.creates.length, 1);
      assert.equal(a.store.bindings.current(created.id), undefined, "binding not written yet");
      assert.equal(a.store.intents.get(`ws:${created.id}:sprites.create`).state, "sent");
      a.crash();

      const b = w.boot();
      await b.svc.resumePending({ wait: true });
      assert.equal(w.provider.creates.length, 1, "never a second create");
      assertReady(w, b.store, created.id);
      assert.equal(b.store.intents.get(`ws:${created.id}:sprites.create`).state, "confirmed");
      b.store.close();
    });
  }
});

test("kill before ensure is called / after the binding is written: restart converges on one Sprite", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const a = w.boot();
      const reached = w.arm("provider.beforeEnsure");
      const created = await a.svc.create(input(i));
      await reached;
      a.crash();
      const b = w.boot();
      await b.svc.resumePending({ wait: true });
      assertReady(w, b.store, created.id);
      b.store.close();
    });
    await withWorld(async (w) => {
      // binding written but the step still `running` (killed right after bind): construct that crash state
      const a = w.boot();
      const created = await a.svc.create(input(i));
      await a.svc.idle();
      a.store.workspaces.update(created.id, { status: "preparing" });
      a.store.workspaces.setStep(created.id, "runtime", { state: "running" });
      for (const s of ["init", "code", "deps", "agent"]) a.store.workspaces.setStep(created.id, s, { state: "pending" });
      const bots = w.bots.list().length;
      a.crash();
      const b = w.boot();
      await b.svc.resumePending({ wait: true });
      assert.equal(w.provider.creates.length, 1);
      assert.equal(b.store.bindings.history(created.id).length, 1, "existing active binding is kept");
      assert.equal(w.bots.list().length, bots, "agent step sees the existing link: no 2nd Bot");
      assert.equal(b.store.workspaces.get(created.id).status, "ready");
      b.store.close();
    });
  }
});

test("ensure throwing an uncertain error (5xx / network): step `unknown`, createSprite never called, retry continues", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const sprites = new Map();
      const client = {
        calls: { get: 0, create: 0 },
        getError: null,
        async getSprite(name) {
          client.calls.get++;
          if (client.getError) throw client.getError;
          const s = sprites.get(name);
          if (!s) throw Object.assign(new Error("sprite not found"), { statusCode: 404 });
          return s;
        },
        async createSprite(name, opts) {
          client.calls.create++;
          const s = { name, status: "running", labels: opts.labels ?? [] };
          sprites.set(name, s);
          return s;
        },
      };
      const real = createSpritesProvider({ client, legacyNames: [] });
      const provider = { ...real, init: async () => {} }; // real ensure / runtimeName / isManaged, init stubbed
      client.getError =
        i % 2 === 0 ? Object.assign(new Error("upstream unavailable"), { statusCode: i % 4 === 0 ? 503 : 500 }) : Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });

      const { store, svc } = w.boot({ providers: { sprites: provider } });
      const created = await svc.create(input(i));
      await svc.idle();

      const steps = store.workspaces.steps(created.id);
      assert.equal(steps[0].state, "unknown");
      assert.match(steps[0].error, /结果待确认/);
      assert.equal(client.calls.create, 0, "createSprite must not be called");
      assert.equal(store.bindings.current(created.id), undefined);
      const ws = store.workspaces.get(created.id);
      assert.equal(ws.status, "preparing", "unknown keeps the workspace preparing");
      assert.equal(store.intents.get(`ws:${created.id}:sprites.create`).state, "unknown");

      // a restart does not "fix" unknown by itself either
      await svc.resumePending({ wait: true });
      assert.equal(client.calls.create, 0);
      assert.equal(store.workspaces.steps(created.id)[0].state, "unknown");

      client.getError = null;
      assert.equal(svc.retry(created.id).status, "preparing");
      await svc.idle();
      assert.equal(client.calls.create, 1);
      assert.equal(sprites.size, 1);
      const final = store.workspaces.get(created.id);
      assert.equal(final.status, "ready", final.error ?? "");
      assert.equal(store.bindings.current(created.id).runtimeId, [...sprites.keys()][0]);
      assert.ok(sprites.get(store.bindings.current(created.id).runtimeId).labels.includes(APP_LABEL));
      store.close();
    });
  }
});

test("a definite ensure failure fails the workspace; retry resets and continues", async () => {
  await withWorld(async (w) => {
    const { store, svc } = w.boot();
    w.provider.ensureError = Object.assign(new Error("unauthorized"), { statusCode: 401 });
    const created = await svc.create(input(1));
    await svc.idle();
    let ws = store.workspaces.get(created.id);
    assert.equal(ws.status, "failed");
    assert.equal(store.workspaces.steps(created.id)[0].state, "failed");
    assert.match(ws.error, /unauthorized/);
    assert.equal(store.intents.get(`ws:${created.id}:sprites.create`).state, "failed");
    await svc.resumePending({ wait: true });
    assert.equal(store.workspaces.get(created.id).status, "failed", "resumePending leaves failed workspaces alone");

    w.provider.ensureError = null;
    assert.equal(svc.retry(created.id).status, "preparing");
    await svc.idle();
    assertReady(w, store, created.id);
    store.close();
  });
});

// ---- init ------------------------------------------------------------------------------------------------------------
test("kill during init: the step re-runs (provider.init / runner.install are idempotent), one Sprite", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const a = w.boot();
      const reached = w.arm("runner.afterInstall");
      const created = await a.svc.create(input(i));
      await reached;
      assert.equal(a.store.workspaces.steps(created.id)[1].state, "running");
      a.crash();
      const b = w.boot();
      await b.svc.resumePending({ wait: true });
      assertReady(w, b.store, created.id);
      assert.equal(w.runner.installs, 2);
      b.store.close();
    });
  }
});

// ---- code step -------------------------------------------------------------------------------------------------------
test("FT-M1-4: kill in the code step (4 windows x10): no repeated clone, never overwrites, converges", async () => {
  const windows = [
    { hook: "runner.afterPrepare", unknownAfterResume: false },
    { hook: "runner.beforeStart", unknownAfterResume: true },
    { hook: "runner.afterStart", unknownAfterResume: false },
    { hook: "runner.afterWaitExited", unknownAfterResume: false },
  ];
  for (const win of windows) {
    for (let i = 0; i < REPEAT; i++) {
      await withWorld(async (w) => {
        const a = w.boot();
        const reached = w.arm(win.hook);
        const created = await a.svc.create(input(i));
        await reached;
        assert.equal(a.store.workspaces.steps(created.id)[2].state, "running");
        a.crash();

        const b = w.boot();
        await b.svc.resumePending({ wait: true });
        if (win.unknownAfterResume) {
          // prepare done, start outcome unknown: reported, never auto-started
          const ws = b.store.workspaces.get(created.id);
          assert.equal(ws.status, "preparing");
          assert.equal(b.store.workspaces.steps(created.id)[2].state, "unknown", win.hook);
          assert.equal(w.clones(), 0, "nothing was started");
          assert.equal(w.runner.started(), 0);
          b.svc.retry(created.id);
          await b.svc.idle();
        }
        assertReady(w, b.store, created.id, { clones: 1 });
        b.store.close();
      });
    }
  }
});

test("code step never overwrites: existing repo + local work survive a repeated execution; non-git directory is refused", async () => {
  await withWorld(async (w) => {
    const { store, svc } = w.boot();
    const created = await svc.create(input(1));
    await svc.idle();
    const ws = assertReady(w, store, created.id);

    // local work: one commit on the work branch and an untracked file
    writeFileSync(join(ws.cwd, "mine.txt"), "mine\n");
    git(ws.cwd, "add", "mine.txt");
    git(ws.cwd, "commit", "-q", "-m", "local work");
    writeFileSync(join(ws.cwd, "untracked.txt"), "keep\n");
    const head = git(ws.cwd, "rev-parse", "HEAD");

    // force the script to execute again: settle its intent back and reset the step
    for (const it of store.intents.list({ kind: "workspace.code" })) store.intents.settle(it.requestId, { state: "unknown" });
    store.workspaces.setStep(ws.id, "code", { state: "pending" });
    store.workspaces.update(ws.id, { status: "preparing" });
    await svc.run(ws.id);
    const after = store.workspaces.get(ws.id);
    assert.equal(after.status, "ready", after.error ?? "");
    assert.equal(git(ws.cwd, "rev-parse", "HEAD"), head, "local commit untouched");
    assert.equal(readFileSync(join(ws.cwd, "untracked.txt"), "utf8"), "keep\n");
    assert.equal(git(ws.cwd, "rev-parse", "--abbrev-ref", "HEAD"), ws.branch);
    assert.equal(w.clones(), 1, "still one clone");

    // somebody checked out another branch meanwhile: the work branch is checked out again, commits intact
    git(ws.cwd, "checkout", "-q", "-b", "other-branch", REMOTES["acme/app"].sha);
    for (const it of store.intents.list({ kind: "workspace.code" })) store.intents.settle(it.requestId, { state: "unknown" });
    store.workspaces.setStep(ws.id, "code", { state: "pending" });
    store.workspaces.update(ws.id, { status: "preparing" });
    await svc.run(ws.id);
    assert.equal(git(ws.cwd, "rev-parse", "--abbrev-ref", "HEAD"), ws.branch);
    assert.equal(git(ws.cwd, "rev-parse", "HEAD"), head);
    assert.equal(w.clones(), 1);
    store.close();
  });
  await withWorld(async (w) => {
    // a non-empty directory that is not a git repository is never touched
    const { store, svc } = w.boot();
    mkdirSync(join(w.home, "workspace", "app"), { recursive: true });
    writeFileSync(join(w.home, "workspace", "app", "precious.txt"), "do not delete\n");
    const created = await svc.create(input(2));
    await svc.idle();
    const ws = store.workspaces.get(created.id);
    assert.equal(ws.status, "failed");
    assert.equal(store.workspaces.steps(ws.id)[2].state, "failed");
    assert.match(ws.error, /退出码 3/);
    assert.equal(readFileSync(join(w.home, "workspace", "app", "precious.txt"), "utf8"), "do not delete\n");
    assert.equal(w.clones(), 0);
    store.close();
  });
});

test("code step: missing base branch is a definite failure; retry after it appears continues", async () => {
  await withWorld(async (w) => {
    const { store, svc } = w.boot();
    w.branchMissing = true;
    const created = await svc.create(input(1));
    await svc.idle();
    assert.equal(store.workspaces.get(created.id).status, "failed");
    assert.match(store.workspaces.get(created.id).error, /基准分支 main/);
    assert.equal(w.runner.started(), 0);
    w.branchMissing = false;
    svc.retry(created.id);
    await svc.idle();
    assertReady(w, store, created.id);
    store.close();
  });
});

// ---- deps ------------------------------------------------------------------------------------------------------------
test("deps: no install command -> done (未配置), nothing run; with one: runs once even with kills", async () => {
  await withWorld(async (w) => {
    const { store, svc } = w.boot();
    const created = await svc.create({ requestId: "nodeps", repo: "acme/other" });
    await svc.idle();
    assert.equal(store.workspaces.get(created.id).status, "ready");
    const deps = store.workspaces.steps(created.id)[3];
    assert.equal(deps.state, "done");
    assert.match(deps.error, /未配置/);
    assert.equal(store.intents.list({ kind: "workspace.deps" }).length, 0);
    store.close();
  });
  for (const hook of ["runner.afterPrepare", "runner.afterStart", "runner.afterWaitExited"]) {
    for (let i = 0; i < REPEAT; i++) {
      await withWorld(async (w) => {
        const depsLog = join(w.dir, "deps.log");
        const a = w.boot();
        const reached = w.arm(hook, { skip: 1 }); // skip the code command, hit the deps command
        const created = await a.svc.create(input(i, { installCommand: `echo ran >> '${depsLog}'` }));
        await reached;
        assert.equal(a.store.workspaces.steps(created.id)[3].state, "running");
        a.crash();
        const b = w.boot();
        await b.svc.resumePending({ wait: true });
        assertReady(w, b.store, created.id);
        assert.equal(readFileSync(depsLog, "utf8"), "ran\n", `${hook}: install ran exactly once`);
        b.store.close();
      });
    }
  }
});

test("failed install: error is redacted everywhere, workspace failed, retry re-runs only the failed step", async () => {
  await withWorld(async (w) => {
    const flag = join(w.dir, "flag");
    const leak = "ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456";
    const custom = "custom-secret-value-xyz";
    const { store, svc } = w.boot({ secrets: [custom] });
    const created = await svc.create(
      // the secrets only exist in the command OUTPUT (assembled from fragments), never in the stored command text
      input(1, { installCommand: `[ -f '${flag}' ] && echo installed || { A=ghp_ABCDEFGHIJKL; B=MNOPQRSTUVWX123456; C=custom-secret; D=-value-xyz; E=abcdefgh; F=ijklmnop; U=user; P=pw; Q=token; echo "token $A$B and $C$D Bearer $E$F https://$U:$P@example.com/x?$Q=q"; exit 1; }` }),
    );
    await svc.idle();
    const ws = store.workspaces.get(created.id);
    assert.equal(ws.status, "failed");
    assert.equal(store.workspaces.steps(created.id)[3].state, "failed");
    assert.match(ws.error, /退出码 1/);
    const blob = w.dump();
    for (const s of [leak, custom, "abcdefghijklmnop", "user:pw", "token=q"]) {
      assert.ok(!blob.includes(s), `database contains ${s}`);
      assert.ok(!JSON.stringify(ws).includes(s));
    }
    assert.ok(ws.error.includes("***"));

    writeFileSync(flag, "");
    const clones = w.clones();
    svc.retry(created.id);
    await svc.idle();
    assertReady(w, store, created.id);
    assert.equal(w.clones(), clones, "retry did not redo the finished steps");
    assert.equal(store.intents.list({ kind: "workspace.deps" }).map((i) => i.state).join(), "failed,confirmed");
    store.close();
  });
});

// ---- agent step + first task -----------------------------------------------------------------------------------------
test("kill after createBot, before the link: restart adopts the orphan Bot (no second Bot)", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const a = w.boot();
      const reached = w.arm("bots.afterCreate");
      const created = await a.svc.create(input(i));
      await reached;
      assert.equal(a.store.links.conversationsOf(created.id).length, 0);
      assert.equal(w.bots.list().length, 1);
      a.crash();
      const b = w.boot();
      await b.svc.resumePending({ wait: true });
      assertReady(w, b.store, created.id);
      assert.equal(w.createBotCalls.length, 1, "createBot called once in total");
      b.store.close();
    });
  }
});

test("orphan Bot lookup uses the workspace marker, not instruction text: an unlinked look-alike Bot is never adopted", async () => {
  await withWorld(async (w) => {
    const a = w.boot();
    const reached = w.arm("bots.afterCreate");
    const created = await a.svc.create(input(1));
    await reached; // the service's Bot exists, but is not linked yet
    const own = w.bots.list().find((b) => b.workspaceId === created.id);
    assert.ok(own, "the Bot made by the service carries the workspace id");
    // an unrelated, unlinked Bot with exactly the same instruction text and no marker (a fork copies instructions)
    const lookalike = await w.bots.createBot({ name: "lookalike", model: FAUX, instructions: own.instructions });
    assert.ok(!lookalike.workspaceId);
    a.crash();
    const b = w.boot();
    await b.svc.resumePending({ wait: true });
    assert.equal(b.store.workspaces.get(created.id).status, "ready");
    assert.equal(b.store.links.conversationsOf(created.id).length, 1, "exactly one conversation");
    const link = b.store.links.conversationsOf(created.id)[0];
    assert.equal(link.botId, own.id, "adopted its own Bot");
    assert.equal(b.store.links.workspaceOf(String(lookalike.conversationId)), undefined, "the look-alike stays unlinked");
    assert.equal(w.createBotCalls.length, 2, "service createBot once + the look-alike made by the test; no third");
    b.store.close();
  });
});

test("agent step: linked conversation = done (no inference from messages); duplicate Bot name gets a suffix", async () => {
  await withWorld(async (w) => {
    await w.bots.createBot({ name: "same", model: FAUX });
    const { store, svc } = w.boot();
    const x = await svc.create(input(1, { name: "same" }));
    await svc.idle();
    assert.equal(store.workspaces.get(x.id).status, "ready");
    const bot = w.bots.get(store.links.conversationsOf(x.id)[0].botId);
    assert.match(bot.name, /^same-[0-9a-f]{6}$/);

    // linked but step not recorded as done (crash state): resume must not create anything
    store.workspaces.update(x.id, { status: "preparing" });
    store.workspaces.setStep(x.id, "agent", { state: "running" });
    const bots = w.bots.list().length;
    await svc.resumePending({ wait: true });
    assert.equal(w.bots.list().length, bots);
    assert.equal(store.workspaces.get(x.id).status, "ready");
    store.close();
  });
});

test("first task: kill after submit, before the intent is confirmed -> still exactly one user message (harness restarted too)", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const a = w.boot();
      const reached = w.arm("conv.afterSubmit");
      const created = await a.svc.create(input(i));
      await reached;
      assert.equal(a.store.workspaces.get(created.id).status, "ready");
      assert.equal(a.store.intents.get(`ws:${created.id}:task`).state, "sent");
      const conversationId = a.store.links.conversationsOf(created.id)[0].conversationId;
      a.crash();

      await w.reopenHarness(); // Pi Durable restarts as well, but is NOT resumed yet
      const b = w.boot();
      await b.svc.resumePending({ wait: true }); // PLAN §3.6: before harness.resume()
      assert.equal(b.store.intents.get(`ws:${created.id}:task`).state, "confirmed");
      await w.runModel(conversationId);
      assert.equal(await w.userMessages(conversationId), 1);
      assert.equal(w.faux.state.callCount, 1, "the model ran once");
      assert.equal(w.createBotCalls.length, 1);
      assertReady(w, b.store, created.id);
      b.store.close();
    });
  }
});

test("first task: kill before the submit (workspace ready, task intent planned) -> submitted once after restart", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const a = w.boot();
      const reached = w.arm("bots.afterCreate");
      const created = await a.svc.create(input(i));
      await reached;
      a.crash();
      // the Bot exists, nothing submitted; now let the restart finish everything
      await w.reopenHarness();
      const b = w.boot();
      await b.svc.resumePending({ wait: true });
      const conversationId = b.store.links.conversationsOf(created.id)[0].conversationId;
      await w.runModel(conversationId);
      assert.equal(await w.userMessages(conversationId), 1);
      assert.equal(w.faux.state.callCount, 1);
      b.store.close();
    });
  }
});

test("resumePending before harness.resume(): task queued, model does not run until resume", async () => {
  await withWorld(async (w) => {
    const { store, svc } = w.boot();
    const created = await svc.create(input(1));
    await svc.resumePending({ wait: true });
    await svc.idle();
    const conversationId = store.links.conversationsOf(created.id)[0].conversationId;
    assert.equal(w.faux.state.callCount, 0, "harness not resumed yet");
    await w.runModel(conversationId);
    assert.equal(w.faux.state.callCount, 1);
    assert.equal(await w.userMessages(conversationId), 1);
    store.close();
  });
});

// ---- retry / resume semantics ----------------------------------------------------------------------------------------
test("retry is a no-op for ready workspaces and unknown ids throw not_found; resumePending(wait:false) only queues", async () => {
  await withWorld(async (w) => {
    const { store, svc } = w.boot();
    assert.throws(() => svc.retry("ws_nope"), (e) => e.code === "not_found");
    await assert.rejects(() => svc.run("ws_nope"), (e) => e.code === "not_found");
    const created = await svc.create(input(1));
    await svc.idle();
    const before = JSON.stringify([store.workspaces.get(created.id), store.workspaces.steps(created.id)]);
    svc.retry(created.id);
    await svc.idle();
    assert.equal(JSON.stringify([store.workspaces.get(created.id), store.workspaces.steps(created.id)]).length, before.length);

    // preparing workspace left over from a dead process: resumePending queues it without waiting
    const a = w.boot();
    const reached = w.arm("runner.beforeStart");
    const other = await a.svc.create({ requestId: "r-other", repo: "acme/other" });
    await reached;
    a.crash();
    const b = w.boot();
    const t0 = Date.now();
    await b.svc.resumePending();
    assert.ok(Date.now() - t0 < 1000);
    await b.svc.idle();
    assert.equal(b.store.workspaces.steps(other.id)[2].state, "unknown");
    b.store.close();
    store.close();
  });
});

// ---- parallelism -----------------------------------------------------------------------------------------------------
test("two workspaces run in parallel without affecting each other (one fails, one succeeds)", async () => {
  for (let i = 0; i < REPEAT; i++) {
    await withWorld(async (w) => {
      const { store, svc } = w.boot();
      const [a, b, c] = await Promise.all([
        svc.create({ requestId: `pa-${i}`, repo: "acme/app", task: "task a" }),
        svc.create({ requestId: `pb-${i}`, repo: "acme/other", task: "task b", installCommand: "exit 1" }),
        svc.create({ requestId: `pc-${i}`, repo: "acme/third", task: "task c" }),
      ]);
      await svc.idle();
      const [wa, wb, wc] = [a, b, c].map((x) => store.workspaces.get(x.id));
      assert.equal(wa.status, "ready", wa.error ?? "");
      assert.equal(wc.status, "ready", wc.error ?? "");
      assert.equal(wb.status, "failed");
      assert.equal(new Set([wa, wb, wc].map((x) => store.bindings.current(x.id).runtimeId)).size, 3, "own Sprite each");
      assert.equal(new Set([wa.branch, wb.branch, wc.branch]).size, 3);
      assert.equal(w.provider.creates.length, 3);
      assert.equal(w.provider.ensures, 3);
      // (the fake runner shares one filesystem, so the three workspaces use three different repositories)
      assert.equal(w.clones(), 3);
      assert.equal(git(wa.cwd, "rev-parse", "--abbrev-ref", "HEAD"), wa.branch);
      assert.equal(git(wc.cwd, "rev-parse", "--abbrev-ref", "HEAD"), wc.branch);
      assert.equal(store.links.conversationsOf(wa.id).length, 1);
      assert.equal(store.links.conversationsOf(wc.id).length, 1);
      assert.equal(store.links.conversationsOf(wb.id).length, 0, "failed workspace has no Bot");
      store.close();
    });
  }
});
