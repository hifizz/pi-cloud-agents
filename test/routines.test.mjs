import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { createApi } from "../src/api.mjs";
import { register as registerRoutes } from "../src/routes/routines.mjs";
import { Routines, createRoutine, listRoutines, createRoutines, computeNext, nextAtTime, normalizeAtTimes } from "../src/ext/routines.mjs";

const MODEL = { provider: "faux", modelId: "faux-1" };

function fauxModels() {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(Array.from({ length: 200 }, () => fauxAssistantMessage([fauxText("report")])));
  return models;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeoutMs = 10_000, what = "condition") {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

/** Text of every user message in a conversation, oldest first. */
async function userTexts(conv) {
  const page = await conv.entries({}, 500, undefined, ctx);
  const out = [];
  for (const e of [...page.items].reverse()) {
    const m = e.model?.[0];
    if (m?.role !== "user") continue;
    out.push(typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""));
  }
  return out;
}

const record = async (list, id) => (await list(id)).find((r) => r.id === id);

/**
 * Controllable clock for the Harness (`HarnessOptions.now` / `setTimer`): setTimer registers timers, jump() moves time and
 * runs every due timer. Background timers (idle-memory eviction) are declined so `pending` counts only timers that pace or
 * resume work, such as a sleeping routine's wakeup.
 */
function fakeClock(start = 1_000_000) {
  let t = start;
  const timers = new Set();
  return {
    now: () => t,
    setTimer(fn, ms, options) {
      if (options?.background) return undefined;
      const entry = { at: t + ms, fn };
      timers.add(entry);
      return () => timers.delete(entry);
    },
    jump(ms) {
      t += ms;
      for (const e of [...timers]) {
        if (e.at <= t && timers.delete(e)) e.fn();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

async function open({ storage = new MemoryStorage(), extensions, botsPath = null, clock } = {}) {
  const { harness } = await openHarness({
    storage,
    models: fauxModels(),
    extensions: extensions ?? [Preamble, Routines],
    ...(clock ? { now: clock.now, setTimer: clock.setTimer } : {}),
  });
  const bots = new BotRegistry(harness, { path: botsPath });
  return { harness, bots };
}

// ---------- pure time math ----------

test("computeNext: everyMs stays on the grid and skips missed slots", () => {
  assert.equal(computeNext({ everyMs: 1000 }, 5000, 5001), 6000);
  assert.equal(computeNext({ everyMs: 1000 }, 5000, 5000), 6000);
  assert.equal(computeNext({ everyMs: 1000 }, 5000, 9500), 10000); // woke late: one firing, next slot after now
  assert.equal(computeNext({ everyMs: 1000 }, 5000, 9000), 10000); // exact slot boundary is "already past"
  assert.equal(computeNext({ everyMs: 1000 }, 5000, 100), 6000); // clock went backwards: never earlier than scheduled+every
});

test("nextAtTime: local HH:MM slots", () => {
  const at = (d, h, m) => new Date(2026, 9, d, h, m, 0, 0).getTime();
  assert.equal(nextAtTime(["09:00", "18:30"], at(7, 8, 0)), at(7, 9, 0));
  assert.equal(nextAtTime(["09:00", "18:30"], at(7, 9, 0)), at(7, 18, 30)); // strictly after
  assert.equal(nextAtTime(["09:00", "18:30"], at(7, 19, 0)), at(8, 9, 0)); // rolls to tomorrow
  assert.deepEqual(normalizeAtTimes(["18:30", "09:00", "09:00"]), ["09:00", "18:30"]);
  assert.throws(() => normalizeAtTimes(["9:00"]));
  assert.throws(() => normalizeAtTimes([]));
  assert.equal(computeNext({ atTimes: ["09:00"] }, at(7, 9, 0), at(7, 9, 1)), at(8, 9, 0));
});

// ---------- fake clock ----------

test("fake clock: fires on schedule, then catches up with a single firing", async () => {
  const clock = fakeClock();
  const r = createRoutines({ now: clock.now });
  const { harness, bots } = await open({ extensions: [Preamble, r.Routines], clock });
  try {
    const bot = await bots.createBot({ name: "clk", model: MODEL });
    const conv = await bots.conversation(bot.id);
    const routine = await r.createRoutine(harness, { botConversationId: bot.conversationId, prompt: "report uptime", everyMs: 60_000 });
    assert.equal(routine.nextAt, 1_000_000 + 60_000);

    await until(() => clock.pending > 0, 5000, "timer armed");
    assert.deepEqual(await userTexts(conv), []); // nothing before the time

    clock.jump(59_999);
    await sleep(50);
    assert.deepEqual(await userTexts(conv), []);

    clock.jump(1); // 60_000 reached
    await until(async () => (await record(() => r.listRoutines(harness), routine.id)).fireCount === 1, 5000, "first fire");
    await until(async () => (await userTexts(conv)).length === 1, 5000, "first user input");
    await until(() => clock.pending > 0, 5000, "re-armed");
    assert.equal((await record(() => r.listRoutines(harness), routine.id)).nextAt, 1_000_000 + 120_000);

    // Sleep through five slots at once (process was "down"): exactly one more firing.
    clock.jump(5 * 60_000 + 1234);
    await until(async () => (await record(() => r.listRoutines(harness), routine.id)).fireCount === 2, 5000, "catch-up fire");
    await sleep(100);
    const rec = await record(() => r.listRoutines(harness), routine.id);
    assert.equal(rec.fireCount, 2);
    assert.ok(rec.nextAt > clock.now(), "next slot is in the future");
    assert.equal(rec.nextAt, 1_000_000 + 7 * 60_000, "stays on the original grid");
    await until(async () => (await userTexts(conv)).length === 2, 5000, "second user input");
    assert.deepEqual(await userTexts(conv), ["report uptime", "report uptime"]);
  } finally {
    await harness.close(ctx);
  }
});

test("cancelRoutine stops firing and marks the routine disabled", async () => {
  const clock = fakeClock();
  const r = createRoutines({ now: clock.now });
  const { harness, bots } = await open({ extensions: [Preamble, r.Routines], clock });
  try {
    const bot = await bots.createBot({ name: "cancel", model: MODEL });
    const conv = await bots.conversation(bot.id);
    const routine = await r.createRoutine(harness, { botConversationId: bot.conversationId, prompt: "x", everyMs: 1000 });
    await until(() => clock.pending > 0);
    assert.equal(await r.cancelRoutine(harness, routine.id), true);
    assert.equal(await r.cancelRoutine(harness, "nope"), false);
    const rec = await record(() => r.listRoutines(harness), routine.id);
    assert.equal(rec.enabled, false);
    assert.equal(rec.status, "terminal:aborted");
    clock.jump(10_000);
    await sleep(100);
    assert.deepEqual(await userTexts(conv), []);
  } finally {
    await harness.close(ctx);
  }
});

test("createRoutine validates input", async () => {
  const { harness, bots } = await open();
  try {
    const bot = await bots.createBot({ name: "val", model: MODEL });
    const base = { botConversationId: bot.conversationId, prompt: "p" };
    await assert.rejects(createRoutine(harness, { ...base }), /exactly one/);
    await assert.rejects(createRoutine(harness, { ...base, everyMs: 10, atTimes: ["09:00"] }), /exactly one/);
    await assert.rejects(createRoutine(harness, { ...base, everyMs: 0 }), /positive/);
    await assert.rejects(createRoutine(harness, { ...base, prompt: " ", everyMs: 10 }), /prompt/);
    await assert.rejects(createRoutine(harness, { ...base, botConversationId: 99999, everyMs: 10 }), /not found/);
    const ok = await createRoutine(harness, { ...base, atTimes: ["03:00"] });
    assert.deepEqual(ok.atTimes, ["03:00"]);
    assert.ok(ok.nextAt > Date.now());
  } finally {
    await harness.close(ctx);
  }
});

// ---------- real clock ----------

test("TEST-F06-1: routine survives harness close/reopen (SQLite) without duplicate requestIds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tars-routine-"));
  const db = join(dir, "r.sqlite");
  const botsPath = join(dir, "bots.json");
  try {
    let { harness, bots } = await open({ storage: await openNodeSqliteStorage(db), botsPath });
    const bot = await bots.createBot({ name: "persist", model: MODEL });
    let conv = await bots.conversation(bot.id);
    const routine = await createRoutine(harness, { botConversationId: bot.conversationId, prompt: "report uptime", everyMs: 150 });

    await until(async () => (await record(listRoutines.bind(null, harness), routine.id)).fireCount >= 1, 5000, "first fire");

    // Same requestId as an already-fired slot returns the original submission (REQ-F06-2 no duplicates).
    const before = await record(listRoutines.bind(null, harness), routine.id);
    const again = await conv.submit(
      { type: "input", content: "report uptime", whenBusy: "followUp", requestId: `routine:${routine.id}:${before.lastFiredAt}` },
      ctx,
    );
    // lastSubmissionId may have advanced if another slot fired meanwhile; look the matching slot up instead of assuming.
    const sameSlot = await record(listRoutines.bind(null, harness), routine.id);
    if (sameSlot.lastFiredAt === before.lastFiredAt) assert.equal(again.id, sameSlot.lastSubmissionId);

    await harness.close(ctx);
    const firedBeforeClose = (await (async () => {
      // read with a non-resuming harness
      const { harness: reader } = await openHarness({ storage: await openNodeSqliteStorage(db), models: fauxModels(), extensions: [Preamble, Routines], resume: false });
      try {
        return (await record(listRoutines.bind(null, reader), routine.id)).fireCount;
      } finally {
        await reader.close(ctx);
      }
    })());

    // Reopen: nothing re-created by hand.
    ({ harness, bots } = await open({ storage: await openNodeSqliteStorage(db), botsPath }));
    conv = await bots.conversation("persist");
    assert.ok(conv, "bot restored");
    await until(async () => (await record(listRoutines.bind(null, harness), routine.id)).fireCount >= firedBeforeClose + 2, 8000, "fires after reopen");

    const rec = await record(listRoutines.bind(null, harness), routine.id);
    assert.equal(new Set(rec.recent).size, rec.recent.length, "every slot (requestId) fired once");
    const texts = await until(async () => {
      const t = await userTexts(conv);
      return t.length >= firedBeforeClose + 2 ? t : null;
    }, 5000, "user inputs after reopen");
    assert.ok(texts.every((t) => t === "report uptime"));
    assert.ok(texts.length <= rec.fireCount + 1, `no duplicate inputs: ${texts.length} inputs vs ${rec.fireCount} fires`);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TEST-F06-2: conv.abort(ctx) does not stop the routine; abort({background:true}) does", async () => {
  const { harness, bots } = await open();
  try {
    const bot = await bots.createBot({ name: "abort", model: MODEL });
    const conv = await bots.conversation(bot.id);
    const routine = await createRoutine(harness, { botConversationId: bot.conversationId, prompt: "tick", everyMs: 150 });
    const fires = async () => (await record(listRoutines.bind(null, harness), routine.id)).fireCount;

    await until(async () => (await fires()) >= 1, 5000, "first fire");
    await conv.abort(ctx); // the user's Esc
    const afterEsc = await fires();
    await until(async () => (await fires()) >= afterEsc + 2, 5000, "fires after Esc");
    const rec = await record(listRoutines.bind(null, harness), routine.id);
    assert.equal(rec.enabled, true);
    assert.ok(["pending", "running", "sleeping"].includes(rec.status), `status ${rec.status}`);

    await conv.abort(ctx, { background: true });
    const stopped = await record(listRoutines.bind(null, harness), routine.id);
    assert.equal(stopped.status, "terminal:aborted");
    const n = await fires();
    await sleep(400);
    assert.equal(await fires(), n, "no more fires after background abort");
  } finally {
    await harness.close(ctx);
  }
});

// ---------- HTTP routes ----------

test("routes: create / list / cancel", async () => {
  const { harness, bots } = await open();
  const api = createApi({ harness, bots, routes: [registerRoutes] });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const j = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const bot = await bots.createBot({ name: "apibot", model: MODEL });
    assert.equal((await j("POST", "/api/routines", { bot: "nobody", prompt: "x", everyMs: 60000 })).status, 404);
    assert.equal((await j("POST", "/api/routines", { bot: "apibot", prompt: "x" })).status, 400);
    assert.equal((await j("POST", "/api/routines", { bot: "apibot", prompt: "x", everyMs: 5 })).status, 400);
    assert.equal((await j("POST", "/api/routines", { bot: "apibot", prompt: "", everyMs: 60000 })).status, 400);
    assert.equal((await j("POST", "/api/routines", { bot: "apibot", prompt: "x", atTimes: ["25:99"] })).status, 400);

    const created = await j("POST", "/api/routines", { bot: bot.id, prompt: "report uptime", everyMs: 60000 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.bot, "apibot");
    assert.equal(created.body.everyMs, 60000);

    const list = await j("GET", "/api/routines");
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, created.body.id);
    assert.equal(list.body[0].enabled, true);
    assert.equal(list.body[0].bot, "apibot");

    assert.equal((await j("POST", "/api/routines/missing/cancel")).status, 404);
    assert.equal((await j("POST", `/api/routines/${created.body.id}/cancel`)).status, 200);
    const after = await j("GET", "/api/routines");
    assert.equal(after.body[0].enabled, false);
    assert.equal(after.body[0].status, "terminal:aborted");
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});
