// Loop webhook tests (Issue14 Phase1): machine authentication inside the global auth guard.
// Real createApi + the real auth guard (TARSBOT_AUTH_DISABLED unset => sessions required) + the real loops route +
// in-memory control store. Bearer secret verification uses the stored scrypt hash; Standard Webhooks HMAC uses
// TARSBOT_LOOPS_WEBHOOK_HMAC_KEY (server env material). No session cookie is ever set: only the webhook entry may pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { createLoopStore } from "../src/loops/store.mjs";
import { createLoopQueue } from "../src/loops/queue.mjs";
import { register as registerAuth } from "../src/routes/auth.mjs";
import { register as registerLoops } from "../src/routes/loops.mjs";

const WS_MODEL = { provider: "faux", modelId: "faux-1" };
const HMAC_KEY = "dGhpcyBpcyBhIHRlc3QgaG1hYyBrZXkh"; // test-only HMAC material (base64)

async function makeEnv() {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "w1",
    projectId: project.id,
    name: "w",
    baseBranch: "main",
    branch: "b",
    cwd: "/x",
    model: WS_MODEL,
  });
  const loopStore = createLoopStore({ store });
  const calls = [];
  const runOne = (run) =>
    new Promise((res) => {
      calls.push(run.id);
      res(); // resolve immediately: runs end at once
    });
  const queue = createLoopQueue({ store, runOne, maxConcurrent: 3 });
  const api = createApi({
    harness: {},
    bots: { list: () => [], get: () => undefined, conversation: async () => undefined },
    routes: [
      (app) => registerAuth(app, { env: { TARSBOT_ALLOWED_EMAILS: "a@x.com", TARSBOT_HOST: "127.0.0.1" } }),
      (app) => {
        Object.assign(app.ctx, { control: store, loops: { store: loopStore, queue, scheduler: undefined } });
        registerLoops(app);
      },
    ],
  });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = (method, path, { body, raw, headers } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(headers ?? {}) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  return { store, ws: workspace, loopStore, queue, calls, call, close: async () => (await api.close(), store.close()) };
}

const sign = (id, ts, body, key = HMAC_KEY) =>
  `v1,${createHmac("sha256", Buffer.from(key, "base64")).update(`${id}.${ts}.`).update(body).digest("base64")}`;

test("Bearer: missing/wrong secret -> 401 and no run; correct -> 202 with runId", async () => {
  const env = await makeEnv();
  try {
    const { loop, webhookSecret } = await env.loopStore.create(env.ws.id, { name: "hook", instructions: "i", trigger: { kind: "webhook" } });
    // missing
    let res = await env.call("POST", `/api/loops/${loop.id}/webhook`, { raw: "{}", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 401);
    // wrong
    res = await env.call("POST", `/api/loops/${loop.id}/webhook`, { raw: "{}", headers: { authorization: "Bearer whsec_wrong" } });
    assert.equal(res.status, 401);
    assert.equal(env.store.loopRuns.listByLoop(loop.id).length, 0, "no run created on failure");
    // correct
    res = await env.call("POST", `/api/loops/${loop.id}/webhook`, {
      raw: JSON.stringify({ hello: "world" }),
      headers: { authorization: `Bearer ${webhookSecret}`, "webhook-id": "msg_1" },
    });
    assert.equal(res.status, 202);
    const j = await res.json();
    assert.ok(j.runId, "runId returned");
    const runs = env.store.loopRuns.listByLoop(loop.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].triggerKey, "webhook:msg_1");
    assert.equal(runs[0].triggerKind, "webhook");
  } finally {
    await env.close();
  }
});

test("dedup: same Webhook-Id returns 202 with the original runId, no second run", async () => {
  const env = await makeEnv();
  try {
    const { loop, webhookSecret } = await env.loopStore.create(env.ws.id, { name: "hook", instructions: "i", trigger: { kind: "webhook" } });
    const post = () =>
      env.call("POST", `/api/loops/${loop.id}/webhook`, {
        raw: JSON.stringify({ x: 1 }),
        headers: { authorization: `Bearer ${webhookSecret}`, "webhook-id": "msg_dup" },
      });
    const r1 = await post();
    const j1 = await r1.json();
    const r2 = await post();
    const j2 = await r2.json();
    assert.equal(r2.status, 202);
    assert.equal(j2.runId, j1.runId, "same run returned");
    assert.equal(j2.deduplicated, true);
    assert.equal(env.store.loopRuns.listByLoop(loop.id).length, 1);
  } finally {
    await env.close();
  }
});

test("Standard Webhooks: valid signature -> 202; stale timestamp -> 401; missing key -> 503", async () => {
  const env = await makeEnv();
  const prev = process.env.TARSBOT_LOOPS_WEBHOOK_HMAC_KEY;
  process.env.TARSBOT_LOOPS_WEBHOOK_HMAC_KEY = HMAC_KEY;
  try {
    const { loop } = await env.loopStore.create(env.ws.id, { name: "hook", instructions: "i", trigger: { kind: "webhook" } });
    const body = JSON.stringify({ event: "x" });
    const ts = Math.floor(Date.now() / 1000);
    // valid
    let res = await env.call("POST", `/api/loops/${loop.id}/webhook`, {
      raw: body,
      headers: { "webhook-id": "msg_sw1", "webhook-timestamp": String(ts), "webhook-signature": sign("msg_sw1", ts, body) },
    });
    assert.equal(res.status, 202);
    // stale timestamp (>5min)
    const stale = ts - 400;
    res = await env.call("POST", `/api/loops/${loop.id}/webhook`, {
      raw: body,
      headers: { "webhook-id": "msg_sw2", "webhook-timestamp": String(stale), "webhook-signature": sign("msg_sw2", stale, body) },
    });
    assert.equal(res.status, 401);
    // bad signature
    res = await env.call("POST", `/api/loops/${loop.id}/webhook`, {
      raw: body,
      headers: { "webhook-id": "msg_sw3", "webhook-timestamp": String(ts), "webhook-signature": sign("msg_sw3", ts, "tampered") },
    });
    assert.equal(res.status, 401);
  } finally {
    await env.close();
  }
  // missing HMAC key -> the signed path is 503, not a fake pass
  delete process.env.TARSBOT_LOOPS_WEBHOOK_HMAC_KEY;
  const env2 = await makeEnv();
  try {
    const { loop } = await env2.loopStore.create(env2.ws.id, { name: "hook", instructions: "i", trigger: { kind: "webhook" } });
    const body = "{}";
    const ts = Math.floor(Date.now() / 1000);
    const res = await env2.call("POST", `/api/loops/${loop.id}/webhook`, {
      raw: body,
      headers: { "webhook-id": "m", "webhook-timestamp": String(ts), "webhook-signature": sign("m", ts, body) },
    });
    assert.equal(res.status, 503);
  } finally {
    await env2.close();
    if (prev !== undefined) process.env.TARSBOT_LOOPS_WEBHOOK_HMAC_KEY = prev;
  }
});

test("rotate: old secret stops working immediately, new one works", async () => {
  const env = await makeEnv();
  try {
    const { loop, webhookSecret } = await env.loopStore.create(env.ws.id, { name: "hook", instructions: "i", trigger: { kind: "webhook" } });
    // rotate needs session auth: a POST without a valid Origin is refused at the Origin check (403);
    // with an allowed Origin but no session it is 401. Either way the route is never reached.
    let res = await env.call("POST", `/api/loops/${loop.id}/webhook/rotate`, { body: {}, headers: { origin: "http://evil.example" } });
    assert.equal(res.status, 403, "bad origin: refused before session check");
    res = await env.call("POST", `/api/loops/${loop.id}/webhook/rotate`, { body: {}, headers: { origin: "http://127.0.0.1:8090" } });
    assert.equal(res.status, 401, "good origin but no session: 401");
    // rotate via the store (the route's session guard is separate; here we test the secret swap semantics)
    const { webhookSecret: second } = await env.loopStore.rotateSecret(loop.id);
    res = await env.call("POST", `/api/loops/${loop.id}/webhook`, {
      raw: "{}",
      headers: { authorization: `Bearer ${webhookSecret}`, "webhook-id": "old" },
    });
    assert.equal(res.status, 401, "old secret is dead");
    res = await env.call("POST", `/api/loops/${loop.id}/webhook`, {
      raw: "{}",
      headers: { authorization: `Bearer ${second}`, "webhook-id": "new" },
    });
    assert.equal(res.status, 202, "new secret works");
  } finally {
    await env.close();
  }
});

test("webhook entry is exact-path only: /api/loops/* elsewhere still requires a session", async () => {
  const env = await makeEnv();
  try {
    const { loop } = await env.loopStore.create(env.ws.id, { name: "hook", instructions: "i", trigger: { kind: "webhook" } });
    let res = await env.call("GET", `/api/loops/${loop.id}`);
    assert.equal(res.status, 401, "loop detail requires a session");
    res = await env.call("GET", `/api/loops/queue`);
    assert.equal(res.status, 401);
    res = await env.call("POST", `/api/loops/${loop.id}/webhook/extra`, { raw: "{}", headers: { origin: "http://127.0.0.1:8090" } });
    assert.equal(res.status, 401, "no path-prefix exemption beyond the exact webhook path");
    res = await env.call("GET", "/api/workspaces");
    assert.equal(res.status, 401);
  } finally {
    await env.close();
  }
});

test("body size cap: over-limit payload is 413 before any run", async () => {
  const env = await makeEnv();
  try {
    const { loop, webhookSecret } = await env.loopStore.create(env.ws.id, { name: "hook", instructions: "i", trigger: { kind: "webhook" } });
    const big = "x".repeat(70 * 1024);
    const res = await env.call("POST", `/api/loops/${loop.id}/webhook`, {
      raw: big,
      headers: { authorization: `Bearer ${webhookSecret}`, "webhook-id": "big" },
    });
    assert.equal(res.status, 413);
    assert.equal(env.store.loopRuns.listByLoop(loop.id).length, 0);
  } finally {
    await env.close();
  }
});
