// Offline tests for src/providers/sprites.mjs (fake client; no network, no real Sprites).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";

const { createSpritesProvider, APP_LABEL } = await import("../src/providers/sprites.mjs");
const { DESIRED_RULES } = await import("../src/providers/sprites-init.mjs");

const TOKEN = "ghp_SECRETTOKEN1234567890";

function apiError(statusCode, msg = "boom") {
  const e = new Error(msg);
  e.statusCode = statusCode;
  e.errorCode = msg;
  return e;
}

/** Fake SpriteCommand: runs `handler(command, env)` -> {stdout?, stderr?, exitCode?}. */
class FakeCommand extends EventEmitter {
  constructor(command, env, handler, calls) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    calls.push({ command, env });
    setImmediate(() => {
      this.emit("spawn");
      const r = handler(command, env) ?? {};
      if (r.stdout) this.stdout.write(r.stdout);
      this.stdout.end();
      this.stderr.end(r.stderr ?? "");
      this.emit("exit", r.exitCode ?? 0);
    });
  }
  kill() {}
  close() {}
}

function makeClient({ sprites = new Map(), handler = () => ({}), policy = { rules: [] } } = {}) {
  const calls = { get: [], create: [], delete: [], list: [], exec: [], policyUpdates: [] };
  const state = { getError: null, createError: null, deleteError: null, policy };
  const client = {
    calls,
    state,
    sprites,
    async getSprite(name) {
      calls.get.push(name);
      if (state.getError) throw state.getError;
      const s = sprites.get(name);
      if (!s) throw apiError(404, "sprite not found");
      return s;
    },
    async createSprite(name, opts) {
      calls.create.push({ name, opts });
      if (state.createError) throw state.createError;
      if (sprites.has(name)) throw apiError(409, "already exists");
      const s = { name, status: "running", labels: opts.labels ?? [] };
      sprites.set(name, s);
      return s;
    },
    async deleteSprite(name) {
      calls.delete.push(name);
      if (state.deleteError) throw state.deleteError;
      if (!sprites.delete(name)) throw apiError(404, "sprite not found");
    },
    async listSprites(opts) {
      calls.list.push(opts);
      const all = [...sprites.values()].filter((s) => s.name.startsWith(opts?.prefix ?? ""));
      return { sprites: all, hasMore: false };
    },
    sprite(name) {
      return {
        spawn: (_cmd, argv, o) => new FakeCommand(argv[3], o?.env, (c, e) => handler(c, e, name), calls.exec),
        async getNetworkPolicy() {
          return state.policy;
        },
        async updateNetworkPolicy(p) {
          calls.policyUpdates.push(p);
          state.policy = p;
        },
      };
    },
  };
  return client;
}

const provider = (client, extra = {}) => createSpritesProvider({ client, ghToken: TOKEN, gitEmail: "bot@example.com", legacyNames: [], ...extra });
const hex10 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);

test("runtimeName is pca- + first 10 hex of sha256(requestId), pure", () => {
  const p = provider(makeClient());
  assert.equal(p.kind, "sprites");
  assert.equal(p.runtimeName("req-1"), `pca-${hex10("req-1")}`);
  assert.equal(p.runtimeName("req-1"), p.runtimeName("req-1"));
  assert.notEqual(p.runtimeName("req-1"), p.runtimeName("req-2"));
  assert.match(p.runtimeName("x"), /^pca-[0-9a-f]{10}$/);
});

test("isManaged: prefix and (when known) label; legacy shared Sprite is never managed", () => {
  const p = createSpritesProvider({ client: makeClient(), legacyNames: ["pca-legacy0000"] });
  assert.equal(p.isManaged("pca-abc"), true);
  assert.equal(p.isManaged("pca-abc", [APP_LABEL, "ws:1"]), true);
  assert.equal(p.isManaged("pca-abc", []), false);
  assert.equal(p.isManaged("pca-abc", ["ws:1"]), false);
  assert.equal(p.isManaged("pi-cloud-agents"), false);
  assert.equal(p.isManaged("pi-cloud-agents", [APP_LABEL]), false);
  assert.equal(p.isManaged("other"), false);
  assert.equal(p.isManaged("pca-legacy0000"), false); // TARSBOT_SPRITE_NAME-style override is never managed
  assert.equal(p.isManaged(undefined), false);
});

test("ensure creates with labels/config and is idempotent (one createSprite for two calls)", async () => {
  const c = makeClient();
  const p = provider(c);
  const a = await p.ensure({ requestId: "r1", workspaceId: "w1" });
  const b = await p.ensure({ requestId: "r1", workspaceId: "w1" });
  assert.equal(a.runtimeId, p.runtimeName("r1"));
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.runtimeId, a.runtimeId);
  assert.equal(c.calls.create.length, 1);
  assert.deepEqual(c.calls.create[0].opts, { config: { cpus: 4, ramMB: 4096 }, labels: [APP_LABEL, "ws:w1"], waitForCapacity: true });
});

test("ensure does not create when getSprite fails with network error or 5xx, and keeps statusCode", async () => {
  for (const err of [Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }), apiError(500), apiError(503), apiError(401), apiError(429)]) {
    const c = makeClient();
    c.state.getError = err;
    const p = provider(c);
    await assert.rejects(
      () => p.ensure({ requestId: "r", workspaceId: "w" }),
      (e) => e.statusCode === err.statusCode && e.code === err.code,
    );
    assert.equal(c.calls.create.length, 0);
  }
});

test("ensure treats create 409 as success after confirming labels", async () => {
  const c = makeClient();
  const p = provider(c);
  const name = p.runtimeName("r");
  // First getSprite: 404; createSprite: 409 (someone else created it meanwhile); second getSprite finds it.
  let n = 0;
  const realGet = c.getSprite.bind(c);
  c.getSprite = async (nm) => {
    if (n++ === 0) {
      c.calls.get.push(nm);
      throw apiError(404);
    }
    return realGet(nm);
  };
  c.sprites.set(name, { name, labels: [APP_LABEL, "ws:w"] });
  const r = await p.ensure({ requestId: "r", workspaceId: "w" });
  assert.deepEqual(r, { runtimeId: name, created: false });
  assert.equal(c.calls.create.length, 1);
});

test("ensure throws when a same-named Sprite lacks the app label (409 path and existing path)", async () => {
  const c = makeClient();
  const p = provider(c);
  const name = p.runtimeName("r");
  c.sprites.set(name, { name, labels: ["somebody-else"] });
  await assert.rejects(() => p.ensure({ requestId: "r", workspaceId: "w" }), /not labelled/);
  assert.equal(c.calls.create.length, 0);

  // 409 path: first get says 404, create says 409, second get returns an unlabelled sprite.
  const c2 = makeClient();
  const p2 = provider(c2);
  const name2 = p2.runtimeName("r2");
  let n = 0;
  c2.getSprite = async () => {
    if (n++ === 0) throw apiError(404);
    return { name: name2, labels: [] };
  };
  c2.createSprite = async () => {
    throw apiError(409);
  };
  await assert.rejects(() => p2.ensure({ requestId: "r2", workspaceId: "w" }), /not labelled/);
});

test("ensure rethrows non-409 create errors with statusCode", async () => {
  const c = makeClient();
  c.state.createError = apiError(429, "rate limited");
  await assert.rejects(
    () => provider(c).ensure({ requestId: "r", workspaceId: "w" }),
    (e) => e.statusCode === 429,
  );
});

test("status: available / missing (404) / unknown (5xx, network) is never missing", async () => {
  const c = makeClient();
  const p = provider(c);
  const { runtimeId } = await p.ensure({ requestId: "r", workspaceId: "w" });
  assert.equal((await p.status(runtimeId)).state, "available");
  assert.equal((await p.status("pca-0000000000")).state, "missing");
  c.state.getError = apiError(500);
  assert.equal((await p.status(runtimeId)).state, "unknown");
  c.state.getError = new Error("socket hang up");
  assert.equal((await p.status(runtimeId)).state, "unknown");
});

test("list returns only managed, labelled Sprites and asks for the pca- prefix", async () => {
  const c = makeClient();
  c.sprites.set("pca-aaaaaaaaaa", { name: "pca-aaaaaaaaaa", labels: [APP_LABEL, "ws:1"] });
  c.sprites.set("pca-bbbbbbbbbb", { name: "pca-bbbbbbbbbb", labels: ["other"] });
  c.sprites.set("pca-cccccccccc", { name: "pca-cccccccccc", labels: [] });
  c.sprites.set("pi-cloud-agents", { name: "pi-cloud-agents", labels: [APP_LABEL] });
  const r = await provider(c).list();
  assert.deepEqual(r, [{ runtimeId: "pca-aaaaaaaaaa", labels: [APP_LABEL, "ws:1"] }]);
  assert.equal(c.calls.list[0].prefix, "pca-");
});

test("release: refuses the legacy shared Sprite, unprefixed names and unlabelled pca- names; never deletes them", async () => {
  const c = makeClient();
  c.sprites.set("pi-cloud-agents", { name: "pi-cloud-agents", labels: [APP_LABEL] });
  c.sprites.set("other-sprite", { name: "other-sprite", labels: [APP_LABEL] });
  c.sprites.set("pca-nolabel000", { name: "pca-nolabel000", labels: [] });
  c.sprites.set("pca-foreign000", { name: "pca-foreign000", labels: ["owner:someone"] });
  const p = provider(c);
  for (const name of ["pi-cloud-agents", "other-sprite", "pca-nolabel000", "pca-foreign000", "", undefined]) {
    await assert.rejects(() => p.release(name), /refusing to release/);
  }
  assert.equal(c.calls.delete.length, 0);
  assert.equal(c.sprites.size, 4);
});

test("release: TARSBOT_SPRITE_NAME-style override stays unmanaged even if it looks pca-", async () => {
  const c = makeClient();
  c.sprites.set("pca-legacy0000", { name: "pca-legacy0000", labels: [APP_LABEL] });
  const p = createSpritesProvider({ client: c, legacyNames: ["pca-legacy0000"] });
  await assert.rejects(() => p.release("pca-legacy0000"), /refusing to release/);
  assert.equal(c.calls.delete.length, 0);
});

test("release deletes a managed Sprite; 404 (before or during delete) counts as already gone", async () => {
  const c = makeClient();
  const p = provider(c);
  const { runtimeId } = await p.ensure({ requestId: "r", workspaceId: "w" });
  assert.deepEqual(await p.release(runtimeId), { released: true });
  assert.deepEqual(c.calls.delete, [runtimeId]);
  assert.deepEqual(await p.release(runtimeId), { released: false }); // getSprite 404

  // delete itself reports 404 (race)
  c.sprites.set("pca-racerace00", { name: "pca-racerace00", labels: [APP_LABEL] });
  c.state.deleteError = apiError(404);
  assert.deepEqual(await p.release("pca-racerace00"), { released: false });
  c.state.deleteError = apiError(500);
  await assert.rejects(() => p.release("pca-racerace00"), (e) => e.statusCode === 500);
});

test("release does not delete when the label read fails with a non-404 error", async () => {
  const c = makeClient();
  c.sprites.set("pca-aaaaaaaaaa", { name: "pca-aaaaaaaaaa", labels: [APP_LABEL] });
  c.state.getError = apiError(503);
  await assert.rejects(() => provider(c).release("pca-aaaaaaaaaa"), (e) => e.statusCode === 503);
  assert.equal(c.calls.delete.length, 0);
});

// ---- init ---------------------------------------------------------------------------------------------------
function initHandler({ hasGh = true, gitState = {} } = {}) {
  const log = { ghInstalls: 0, gitSets: [] };
  const h = (command) => {
    if (command.includes("command -v gh")) return { exitCode: hasGh || log.ghInstalls ? 0 : 1 };
    if (command.includes("releases/latest")) {
      log.ghInstalls++;
      return { stdout: "gh version 2.0.0\n" };
    }
    let m = /^git config --global --get-all '([^']+)'$/.exec(command);
    if (m) return gitState[m[1]] !== undefined ? { stdout: gitState[m[1]] + "\n" } : { exitCode: 1 };
    m = /--unset-all '([^']+)'; git config --global '[^']+' '((?:[^']|'\\'')*)'$/.exec(command);
    if (m) {
      gitState[m[1]] = m[2].replace(/'\\''/g, "'");
      log.gitSets.push(m[1]);
      return {};
    }
    return { exitCode: 127, stderr: "unexpected command" };
  };
  return { h, log, gitState };
}

test("init: skips gh download when gh exists, sets git config + policy; second run does nothing", async () => {
  const { h, log } = initHandler({ hasGh: true });
  const c = makeClient({ handler: h });
  const p = provider(c);
  const first = await p.init("pca-aaaaaaaaaa");
  assert.equal(log.ghInstalls, 0);
  assert.deepEqual(first.steps.map((s) => [s.step, s.state]), [["gh", "skipped"], ["git", "done"], ["network", "done"]]);
  assert.deepEqual(log.gitSets.sort(), ["credential.https://github.com.helper", "user.email", "user.name"]);
  assert.deepEqual(c.calls.policyUpdates, [{ rules: DESIRED_RULES }]);

  const setsBefore = log.gitSets.length;
  const second = await p.init("pca-aaaaaaaaaa");
  assert.deepEqual(second.steps.map((s) => s.state), ["skipped", "skipped", "skipped"]);
  assert.equal(log.gitSets.length, setsBefore);
  assert.equal(c.calls.policyUpdates.length, 1);
});

test("init: installs gh only when missing, and not again on the second run", async () => {
  const { h, log } = initHandler({ hasGh: false });
  const p = provider(makeClient({ handler: h }));
  await p.init("pca-aaaaaaaaaa");
  assert.equal(log.ghInstalls, 1);
  await p.init("pca-aaaaaaaaaa");
  assert.equal(log.ghInstalls, 1);
});

test("init: token only travels in exec env, never in a command or git config value", async () => {
  const { h, gitState } = initHandler();
  const c = makeClient({ handler: h });
  await provider(c).init("pca-aaaaaaaaaa");
  assert.ok(c.calls.exec.length > 0);
  for (const e of c.calls.exec) {
    assert.ok(!e.command.includes(TOKEN), "token must not appear in command text");
    assert.equal(e.env?.GH_TOKEN, TOKEN);
  }
  for (const v of Object.values(gitState)) assert.ok(!v.includes(TOKEN));
});

test("init failure message is redacted and does not leak the token", async () => {
  const c = makeClient({ handler: (cmd) => (cmd.includes("command -v gh") ? { exitCode: 0 } : { exitCode: 1, stderr: `fatal: bad credential ${TOKEN}` }) });
  c.state.policy = { rules: [] };
  await assert.rejects(
    () => provider(c).init("pca-aaaaaaaaaa"),
    (e) => /git config/.test(e.message) && !e.message.includes(TOKEN),
  );
});

test("errors from the SDK are redacted but keep statusCode", async () => {
  const c = makeClient();
  c.state.getError = apiError(500, `upstream said ${TOKEN} wss://x/exec?env=GH_TOKEN%3D${TOKEN}`);
  await assert.rejects(
    () => provider(c).ensure({ requestId: "r", workspaceId: "w" }),
    (e) => e.statusCode === 500 && !e.message.includes(TOKEN) && !e.errorCode.includes(TOKEN) && !e.message.includes("?env"),
  );
});

test("logs never contain commands or the token", async () => {
  const entries = [];
  const { h } = initHandler();
  const c = makeClient({ handler: h });
  const p = provider(c, { log: (e) => entries.push(e) });
  await p.ensure({ requestId: "r", workspaceId: "w" });
  await p.init("pca-aaaaaaaaaa");
  assert.ok(entries.length > 0);
  const s = JSON.stringify(entries);
  assert.ok(!s.includes(TOKEN));
  assert.ok(!s.includes("git config"));
});

test("bash(runtimeId) is cached per name and carries GH_TOKEN in exec env", async () => {
  const c = makeClient({ handler: () => ({ stdout: "hi\n" }) });
  const p = provider(c);
  const b = p.bash("pca-aaaaaaaaaa");
  assert.equal(p.bash("pca-aaaaaaaaaa"), b);
  assert.notEqual(p.bash("pca-bbbbbbbbbb"), b);
  const r = await b("echo hi");
  assert.equal(r.stdout, "hi\n");
  assert.equal(r.exitCode, 0);
  assert.equal(c.calls.exec[0].env.GH_TOKEN, TOKEN);
});
