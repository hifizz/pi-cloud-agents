import { test } from "node:test";
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
    const gone = await j(t.base, "POST", "/api/bots", { name: "x" });
    assert.equal(gone.status, 405, "POST /api/bots no longer exists: bots are created through workspaces");
    const bot = await t.bots.createBot({ name: "errs", model: FAUX });
    const noText = await j(t.base, "POST", `/api/bots/${bot.id}/input`, {});
    assert.equal(noText.status, 400);
    const badBusy = await j(t.base, "POST", `/api/bots/${bot.id}/input`, { text: "x", whenBusy: "nope" });
    assert.equal(badBusy.status, 400);
    const badLimit = await j(t.base, "GET", `/api/bots/${bot.id}/entries?limit=abc`);
    assert.equal(badLimit.status, 400);
    const res = await fetch(`${t.base}/api/bots/${bot.id}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /JSON/);
  } finally {
    await t.close();
  }
});

test("list shows busy/queued", async () => {
  const t = await setup([]);
  try {
    await t.bots.createBot({ name: "alpha", model: FAUX });
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
