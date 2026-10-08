// Offline tests for src/space.mjs connection priority and retry logic (fake Spaces API, no SDK/container needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TARSBOT_NO_DOTENV = "1";
const { getSpaceConfig, connectSpace, directSpaceId, createSpaceManager } = await import("../src/space.mjs");

const tmp = () => mkdtempSync(join(tmpdir(), "tarsbot-space-test-"));
const withFile = (obj) => {
  const dir = tmp();
  if (obj !== undefined) writeFileSync(join(dir, "space.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
  return dir;
};

/** Fake `Spaces`: records calls; `registered` are entries returned by list(). */
function fakeApi(registered = []) {
  const calls = [];
  return {
    calls,
    async list() {
      calls.push(["list"]);
      return registered;
    },
    async add(url, token, name) {
      calls.push(["add", url, token, name]);
      const info = { id: directSpaceId(url), name, provider: "direct" };
      registered.push(info);
      return info;
    },
    async create(opts) {
      calls.push(["create", opts]);
      return { space: { id: "local:fake", name: "fake", provider: "local" } };
    },
    async space(id) {
      calls.push(["space", id]);
      return { id };
    },
  };
}
const fakeOptions = { create: (o) => ({ ...o, fake: true }) };

test("getSpaceConfig: CUA_SPACE_URL env wins over data/space.json", () => {
  const dir = withFile({ url: "http://127.0.0.1:3211", token: "file-token", container: "tarsbot-space" });
  try {
    const cfg = getSpaceConfig({ env: { CUA_SPACE_URL: "http://10.0.0.5:3211", CUA_ENV_TOKEN: "env-token" }, dataDir: dir });
    assert.equal(cfg.source, "env");
    assert.equal(cfg.url, "http://10.0.0.5:3211");
    assert.equal(cfg.token, "env-token");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("getSpaceConfig: data/space.json used when no env URL", () => {
  const dir = withFile({ url: "http://127.0.0.1:3211", token: "file-token", container: "tarsbot-space" });
  try {
    const cfg = getSpaceConfig({ env: {}, dataDir: dir });
    assert.deepEqual(cfg, { source: "file", url: "http://127.0.0.1:3211", token: "file-token", container: "tarsbot-space", name: "tarsbot-space" });
    assert.equal(getSpaceConfig({ env: { CUA_SPACE_NAME: "custom" }, dataDir: dir }).name, "custom");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("getSpaceConfig: falls back to SDK create when neither is present", () => {
  const dir = withFile(undefined);
  try {
    assert.deepEqual(getSpaceConfig({ env: {}, dataDir: dir }), { source: "sdk", name: "tarsbot-probe" });
    assert.equal(getSpaceConfig({ env: { CUA_SPACE_NAME: "x" }, dataDir: dir }).name, "x");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("getSpaceConfig: malformed space.json is an error, not a silent SDK fallback", () => {
  for (const bad of ["{not json", JSON.stringify({ token: "t" })]) {
    const dir = withFile(bad);
    try {
      assert.throws(() => getSpaceConfig({ env: {}, dataDir: dir }), /space\.json|url/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});

test("directSpaceId", () => {
  assert.equal(directSpaceId("http://127.0.0.1:3211"), "direct:127.0.0.1:3211");
  assert.equal(directSpaceId("http://127.0.0.1:3211/"), "direct:127.0.0.1:3211");
  assert.equal(directSpaceId("example.com:3211"), "direct:example.com:3211");
  assert.equal(directSpaceId("https://h.example"), "direct:h.example:443");
});

test("connectSpace: url config -> add() when not registered, then reuse from list()", async () => {
  const cfg = { source: "file", url: "http://127.0.0.1:3211", token: "tok", name: "tarsbot-space" };
  const api = fakeApi();
  const first = await connectSpace(cfg, { api, createOptions: fakeOptions });
  assert.deepEqual(api.calls.filter((c) => c[0] === "add"), [["add", "http://127.0.0.1:3211", "tok", "tarsbot-space"]]);
  assert.equal(first.space.id, "direct:127.0.0.1:3211");
  assert.ok(!api.calls.some((c) => c[0] === "create"));

  api.calls.length = 0;
  await connectSpace(cfg, { api, createOptions: fakeOptions });
  assert.ok(!api.calls.some((c) => c[0] === "add"), "registered entry must be reused");
});

test("connectSpace: reuses a registered entry matched by name", async () => {
  const api = fakeApi([{ id: "direct:other:1", name: "tarsbot-space", provider: "direct" }]);
  const r = await connectSpace({ source: "env", url: "http://127.0.0.1:3211", token: "t", name: "tarsbot-space" }, { api, createOptions: fakeOptions });
  assert.equal(r.space.id, "direct:other:1");
  assert.ok(!api.calls.some((c) => c[0] === "add"));
});

test("connectSpace: forceAdd re-runs add() even when registered", async () => {
  const cfg = { source: "env", url: "http://127.0.0.1:3211", token: "new", name: "tarsbot-space" };
  const api = fakeApi([{ id: "direct:127.0.0.1:3211", name: "tarsbot-space", provider: "direct" }]);
  await connectSpace(cfg, { api, createOptions: fakeOptions, forceAdd: true });
  assert.deepEqual(api.calls.filter((c) => c[0] === "add"), [["add", "http://127.0.0.1:3211", "new", "tarsbot-space"]]);
});

test("connectSpace: sdk source -> create({reuse:true, name}); never add()", async () => {
  const api = fakeApi();
  const r = await connectSpace({ source: "sdk", name: "tarsbot-probe" }, { api, createOptions: fakeOptions });
  const create = api.calls.find((c) => c[0] === "create");
  assert.ok(create);
  assert.equal(create[1].reuse, true);
  assert.equal(create[1].name, "tarsbot-probe");
  assert.ok(!api.calls.some((c) => c[0] === "add"));
  assert.equal(r.space.id, "local:fake");
});

test("createSpaceManager: caches the handle, failure -> reconnect with forceAdd -> fn runs twice", async () => {
  const connects = [];
  const m = createSpaceManager(async (forceAdd) => (connects.push(forceAdd), { gen: connects.length }), { sleepFn: async () => {} });
  const seen = [];
  const out = await m.withSpace(async (sp) => {
    seen.push(sp.gen);
    if (seen.length === 1) throw new Error("stale handle");
    return "ok";
  });
  assert.equal(out, "ok");
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(connects, [false, true]);
  // Healthy afterwards: cached handle, no new connect.
  await m.withSpace(async () => {});
  assert.equal(connects.length, 2);
});

test("createSpaceManager: waits (backoff) for a restarting Space, then succeeds", async () => {
  let attempts = 0;
  const sleeps = [];
  const m = createSpaceManager(
    async (forceAdd) => {
      attempts++;
      if (attempts === 1) return { gen: 1 };
      if (attempts < 5) throw new Error("ECONNREFUSED"); // Space still booting
      return { gen: attempts };
    },
    { budgetMs: 60_000, sleepFn: async (ms) => void sleeps.push(ms) },
  );
  let runs = 0;
  const out = await m.withSpace(async (sp) => {
    runs++;
    if (sp.gen === 1) throw new Error("connection reset");
    return sp.gen;
  });
  assert.equal(out, 5);
  assert.equal(runs, 2, "fn re-run only after a successful reconnect");
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test("createSpaceManager: gives up when the reconnect budget is exhausted; fn not re-run", async () => {
  let runs = 0;
  const m = createSpaceManager(
    async () => {
      if (runs === 0) return { gen: 1 };
      throw new Error("still down");
    },
    { budgetMs: 10, sleepFn: async () => {} },
  );
  await assert.rejects(
    m.withSpace(async () => {
      runs++;
      throw new Error("boom");
    }),
    /still down/,
  );
  assert.equal(runs, 1);
});

test("createSpaceManager: a failed first connect is not cached", async () => {
  let n = 0;
  const m = createSpaceManager(async () => {
    if (++n === 1) throw new Error("down");
    return { gen: n };
  });
  await assert.rejects(m.getSpace(), /down/);
  assert.equal((await m.getSpace()).gen, 2);
});
