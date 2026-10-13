import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { openHarness } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { createApi, HttpError } from "../src/api.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };

async function setup(responses, { routes } = {}) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble] });
  const bots = new BotRegistry(harness, { path: null });
  const api = createApi({ harness, bots, routes });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return {
    harness,
    bots,
    api,
    port,
    base,
    async close() {
      await api.close();
      await harness.close((await import("../src/harness.mjs")).ctx);
    },
  };
}

async function j(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function collectWs(url, until, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`ws timeout; frames: ${frames.map((f) => f.type + ":" + (f.events?.map((e) => e.type).join(",") ?? "")).join(" | ")}`));
    }, timeoutMs);
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      if (until(frame, frames)) {
        clearTimeout(timer);
        ws.close();
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      resolve(frames);
    });
    ws.on("error", reject);
  });
}

const hasRunEnd = (frame) => frame.type === "events" && frame.events.some((e) => e.type === "run_end");

test("health + error formats", async () => {
  const t = await setup([]);
  try {
    assert.deepEqual((await j(t.base, "GET", "/api/health")).body, { ok: true });
    const nf = await j(t.base, "GET", "/api/nope");
    assert.equal(nf.status, 404);
    assert.equal(typeof nf.body.error, "string");
    const nb = await j(t.base, "POST", "/api/bots/missing/input", { text: "hi" });
    assert.equal(nb.status, 404);
    assert.match(nb.body.error, /not found/);
    const wrongMethod = await j(t.base, "POST", "/api/health", {});
    assert.equal(wrongMethod.status, 405);
    const noName = await j(t.base, "POST", "/api/bots", {});
    assert.equal(noName.status, 400);
    const badName = await j(t.base, "POST", "/api/bots", { name: 42 });
    assert.equal(badName.status, 400);
    const bot = await t.bots.createBot({ name: "errs", model: FAUX });
    const noText = await j(t.base, "POST", `/api/bots/${bot.id}/input`, {});
    assert.equal(noText.status, 400);
    const badBusy = await j(t.base, "POST", `/api/bots/${bot.id}/input`, { text: "x", whenBusy: "nope" });
    assert.equal(badBusy.status, 400);
    const badLimit = await j(t.base, "GET", `/api/bots/${bot.id}/entries?limit=abc`);
    assert.equal(badLimit.status, 400);
    const res = await fetch(`${t.base}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /JSON/);
  } finally {
    await t.close();
  }
});

test("create bot via API; duplicate name is 409; list shows busy/queued", async () => {
  const t = await setup([]);
  try {
    const created = await j(t.base, "POST", "/api/bots", { name: "alpha", modelId: "glm-5.3", instructions: "Be brief." });
    assert.equal(created.status, 200);
    assert.equal(created.body.name, "alpha");
    assert.deepEqual(created.body.model, { provider: "tokenrouter", modelId: "glm-5.3" });
    assert.equal(created.body.instructions, "Be brief.");
    const dup = await j(t.base, "POST", "/api/bots", { name: "alpha" });
    assert.equal(dup.status, 409);
    const list = await j(t.base, "GET", "/api/bots");
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].busy, false);
    assert.equal(list.body[0].queued, 0);
  } finally {
    await t.close();
  }
});

test("input -> WS snapshot first, then events ending in run_end; requestId dedupe; usage; entries", async () => {
  const t = await setup([fauxAssistantMessage([fauxText("Paris")])]);
  try {
    const bot = await t.bots.createBot({ name: "geo", model: FAUX });
    const wsUrl = `ws://127.0.0.1:${t.port}/api/bots/${bot.id}/stream`;
    const framesP = collectWs(wsUrl, hasRunEnd);
    // Give the socket time to attach before submitting, so it covers the whole run.
    await new Promise((r) => setTimeout(r, 300));

    const body = { text: "Capital of France?", requestId: "req-1" };
    const r1 = await j(t.base, "POST", `/api/bots/${bot.id}/input`, body);
    assert.equal(r1.status, 200);
    assert.ok(r1.body.submissionId);
    const r2 = await j(t.base, "POST", `/api/bots/${bot.id}/input`, body);
    assert.equal(r2.body.submissionId, r1.body.submissionId);

    const frames = await framesP;
    assert.equal(frames[0].type, "snapshot");
    assert.ok(Array.isArray(frames[0].entries));
    assert.ok("usage" in frames[0]);
    const events = frames.filter((f) => f.type === "events").flatMap((f) => f.events);
    assert.ok(events.some((e) => e.type === "run_start"));
    assert.ok(events.some((e) => e.type === "message_end"));
    assert.ok(events.some((e) => e.type === "run_end"));

    // transcript is oldest -> newest and holds exactly one exchange (requestId dedupe)
    const entries = (await j(t.base, "GET", `/api/bots/${bot.id}/entries?limit=50`)).body;
    const roles = entries.map((e) => e.model?.[0]?.role).filter((r) => r === "user" || r === "assistant");
    assert.deepEqual(roles, ["user", "assistant"]);

    const usage = await j(t.base, "GET", "/api/usage");
    assert.equal(usage.status, 200);
    assert.ok(usage.body.total && typeof usage.body.total === "object");
    const entry = usage.body.bots.find((b) => b.id === bot.id);
    assert.ok(entry, "usage has an entry for the bot");
    assert.equal(entry.name, "geo");
    assert.ok(entry.usage.models["faux/faux-1"], `models: ${Object.keys(entry.usage.models)}`);

    const list = await j(t.base, "GET", "/api/bots");
    assert.equal(list.body[0].busy, false);
  } finally {
    await t.close();
  }
});

test("late-joining WS gets a snapshot containing the committed transcript", async () => {
  const t = await setup([fauxAssistantMessage([fauxText("Berlin")])]);
  try {
    const bot = await t.bots.createBot({ name: "late", model: FAUX });
    const conv = await t.bots.conversation(bot.id);
    const { ctx } = await import("../src/harness.mjs");
    await (await conv.submit({ type: "input", content: "Capital of Germany?" }, ctx)).wait(ctx);
    const frames = await collectWs(`ws://127.0.0.1:${t.port}/api/bots/${bot.id}/stream`, (f) => f.type === "snapshot");
    assert.equal(frames[0].type, "snapshot");
    const roles = frames[0].entries.map((e) => e.model?.[0]?.role).filter(Boolean);
    assert.ok(roles.includes("user") && roles.includes("assistant"), `roles: ${roles}`);
  } finally {
    await t.close();
  }
});

test("WS for unknown bot closes with 4404; unknown ws path is refused", async () => {
  const t = await setup([]);
  try {
    const code = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${t.port}/api/bots/nobody/stream`);
      ws.on("close", (c) => resolve(c));
      ws.on("error", reject);
    });
    assert.equal(code, 4404);
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${t.port}/nothing`);
        ws.on("open", resolve);
        ws.on("error", reject);
      }),
    );
  } finally {
    await t.close();
  }
});

test("abort / compact / reset endpoints respond", async () => {
  const t = await setup([fauxAssistantMessage([fauxText("ok")])]);
  try {
    const bot = await t.bots.createBot({ name: "ctl", model: FAUX });
    const conv = await t.bots.conversation(bot.id);
    const { ctx } = await import("../src/harness.mjs");
    await (await conv.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
    const abort = await j(t.base, "POST", `/api/bots/${bot.id}/abort`, {});
    assert.equal(abort.status, 200);
    const reset = await j(t.base, "POST", `/api/bots/${bot.id}/reset`, { note: "fresh start" });
    assert.equal(reset.status, 200);
    const compact = await j(t.base, "POST", `/api/bots/${bot.id}/compact`, { instructions: "short" });
    assert.equal(compact.status, 200);
    assert.ok("taskId" in compact.body);
    assert.equal((await j(t.base, "POST", "/api/bots/zzz/abort", {})).status, 404);
    assert.equal((await j(t.base, "POST", "/api/bots/zzz/compact", {})).status, 404);
    assert.equal((await j(t.base, "POST", "/api/bots/zzz/reset", {})).status, 404);
  } finally {
    await t.close();
  }
});

test("route plugins, HttpError, params and query", async () => {
  const plugin = (app) => {
    app.get("/api/echo/:id", (_req, _res, { params, query }) => ({ id: params.id, query, bots: app.ctx.bots.list().length }));
    app.post("/api/fail", () => {
      throw new HttpError(418, "teapot");
    });
    app.get("/api/boom", () => {
      throw new Error("kaboom");
    });
  };
  const t = await setup([], { routes: [plugin] });
  try {
    const echo = await j(t.base, "GET", "/api/echo/a%20b?x=1");
    assert.deepEqual(echo.body, { id: "a b", query: { x: "1" }, bots: 0 });
    const fail = await j(t.base, "POST", "/api/fail", {});
    assert.equal(fail.status, 418);
    assert.deepEqual(fail.body, { error: "teapot" });
    const boom = await j(t.base, "GET", "/api/boom");
    assert.equal(boom.status, 500);
    assert.equal(boom.body.error, "kaboom");
  } finally {
    await t.close();
  }
});

// ── /api/space and the sandbox mode (S2-runtime-ui) ──────────────────────────────────────────────────────────────
const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("GET /api/space in sprites mode returns { sandbox, name } and never touches the Cua stack", async () => {
  const { register } = await import("../src/routes/space.mjs");
  const prev = process.env.TARSBOT_SPRITE_NAME;
  process.env.TARSBOT_SPRITE_NAME = "tars-test";
  const loadCua = () => assert.fail("Cua stack must not be loaded in sprites mode");
  const t = await setup([], { routes: [(app) => register(app, { sandbox: "sprites", loadCua })] });
  try {
    const r = await j(t.base, "GET", "/api/space");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sandbox: "sprites", name: "tars-test" });
  } finally {
    if (prev === undefined) delete process.env.TARSBOT_SPRITE_NAME;
    else process.env.TARSBOT_SPRITE_NAME = prev;
    await t.close();
  }
});

test("GET /api/space in cua mode keeps its shape and adds sandbox: \"cua\"", async () => {
  const { register } = await import("../src/routes/space.mjs");
  const closed = [];
  const stack = {
    getSpace: async () => ({}),
    getSpaceConfig: () => ({ name: "fake-space", url: "http://10.0.0.5:3211/", token: "tok" }),
    getSpaceInfo: () => ({ id: "s1" }),
    embedded: () => ({
      sandboxes: () => ({ connectUrl: async () => ({ viewerUrl: async () => ({ url: "http://10.0.0.5:3211/viewer/#ticket=abc", expiresAtUnix: Math.floor(Date.now() / 1000) + 86400 }) }) }),
    }),
    ViewerOptions: { create: () => ({}) },
    startViewerProxy: async ({ target }) => ({ url: "http://127.0.0.1:3309", server: { close: () => closed.push(target) } }),
  };
  const t = await setup([], { routes: [(app) => register(app, { sandbox: "cua", loadCua: async () => stack })] });
  try {
    const r = await j(t.base, "GET", "/api/space");
    assert.equal(r.status, 200);
    assert.equal(r.body.sandbox, "cua");
    assert.equal(r.body.name, "fake-space");
    assert.equal(r.body.directViewerUrl, "http://10.0.0.5:3211/viewer/");
    assert.equal(r.body.viewerUrl, "http://127.0.0.1:3309/viewer/#ticket=abc");
    assert.deepEqual(r.body.info, { id: "s1" });
  } finally {
    await t.close();
  }
});

/** Run `code` in a child with a resolve hook that records every module URL, so we can prove what was (not) loaded. */
function childLoaded(code, vars) {
  const hooks = `import { registerHooks } from "node:module"; globalThis.__resolved = [];
    registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); globalThis.__resolved.push(r.url); return r; } });`;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TARSBOT_")));
  const out = execFileSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(hooks)}`, "--input-type=module", "-e", code],
    { cwd: ROOT, env: { ...base, TARSBOT_NO_DOTENV: "1", ...vars }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out);
}

const CUA_URL = /@trycua|\/src\/space\.mjs$|\/src\/viewer-proxy\.mjs$|\/src\/ext\/desktop\.mjs$/;
const LOAD_CODE = `
  const { productionExtensions } = await import("./src/runtime.mjs");
  const { loadRoutes } = await import("./src/server.mjs");
  const exts = await productionExtensions();
  const routes = [];
  for (const register of await loadRoutes()) register({ get: (p, h) => routes.push([p, h]), post() {}, ws() {}, ctx: {} });
  const space = routes.find(([p]) => p === "/api/space");
  const body = space ? await space[1]() : null;
  console.log(JSON.stringify({ exts: exts.map((e) => e?.name ?? null), body, loaded: [...new Set(globalThis.__resolved)].filter((u) => ${CUA_URL}.test(u)) }));`;

test("sprites mode: no Desktop extension and nothing Cua-related is loaded (runtime + all route plugins)", () => {
  const out = childLoaded(LOAD_CODE, { TARSBOT_SANDBOX: "sprites", TARSBOT_SPRITE_NAME: "tars-test" });
  assert.deepEqual(out.loaded, []);
  assert.deepEqual(out.body, { sandbox: "sprites", name: "tars-test" });
  assert.deepEqual(out.exts, ["tarsbot.preamble", "coding-tools", "tarsbot.search", "tarsbot.history", "tarsbot.routines", "tarsbot.approval"]);
});

test("cua mode: Desktop extension is installed (loaded lazily from runtime.mjs)", () => {
  const out = childLoaded(LOAD_CODE.replace(/const space = [\s\S]*?const body = [^\n]*\n/, "const body = null;\n"), { TARSBOT_SANDBOX: "cua" });
  assert.deepEqual(out.exts.slice(0, 4), ["tarsbot.preamble", "coding-tools", "tarsbot.desktop", "tarsbot.search"]);
  assert.ok(out.loaded.some((u) => /ext\/desktop\.mjs$/.test(u)));
});
