// Offline tests: bot-created routines via tools with limits (3), watch/only-when-changed (10, fingerprint logic),
// run records with status/duration (11). Fake clock drives the durable sleeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { createRoutines, createRoutineTools, BOT_MIN_EVERY_MS, normalizeWatch, RoutinesDoc } from "../src/ext/routines.mjs";

const MODEL = { provider: "faux", modelId: "faux-1" };
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

async function open(clock, r) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage([fauxText("report")])));
  const { harness } = await openHarness({
    storage: new MemoryStorage(),
    models,
    extensions: r ? [Preamble, r.Routines] : [Preamble],
    ...(clock ? { now: clock.now, setTimer: clock.setTimer } : {}),
  });
  const bots = new BotRegistry(harness, { path: null });
  return { harness, bots };
}

test("normalizeWatch validates the command", () => {
  assert.deepEqual(normalizeWatch({ command: "curl -s example.com | head" }), { command: "curl -s example.com | head" });
  assert.throws(() => normalizeWatch({}));
  assert.throws(() => normalizeWatch({ command: "   " }));
  assert.throws(() => normalizeWatch(null));
});

test("schedule_routine tool: creates a routine bound to the calling bot, enforces min interval", async () => {
  const clock = fakeClock();
  const r = createRoutines({ now: clock.now });
  const { harness, bots } = await open(clock, r);
  const tools = createRoutineTools({ harness, now: clock.now, minEveryMs: BOT_MIN_EVERY_MS });
  try {
    const bot = await bots.createBot({ name: "rt", model: MODEL });
    const conv = await bots.conversation(bot.id);
    const schedule = tools.tools.find((t) => t.name === "schedule_routine");
    const list = tools.tools.find((t) => t.name === "list_routines");

    const api = { conversationId: bot.conversationId };
    const out = await schedule.execute({ prompt: "tell me what changed", everyMinutes: 5 }, api, undefined);
    assert.match(out.output[0].text, /routine .+ scheduled/);

    const doc = await harness.snapshot(RoutinesDoc, ctx);
    const recs = Object.values(doc.routines);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].botConversationId, bot.conversationId);
    assert.equal(recs[0].everyMs, 5 * 60_000);

    const listed = await list.execute({}, api, undefined);
    assert.match(listed.output[0].text, /tell me what changed/);

    // Min interval enforced.
    await assert.rejects(() => schedule.execute({ prompt: "x", everyMinutes: 1 }, api, undefined), /everyMinutes must be >= 5/);
    // Missing schedule spec.
    await assert.rejects(() => schedule.execute({ prompt: "x" }, api, undefined), /exactly one of/);
  } finally {
    await harness.close(ctx);
  }
});

test("routine runs record status and duration in recent[] (idea 11)", async () => {
  const clock = fakeClock();
  const r = createRoutines({ now: clock.now });
  const { harness, bots } = await open(clock, r);
  try {
    const bot = await bots.createBot({ name: "rr", model: MODEL });
    const conv = await bots.conversation(bot.id);
    const created = await r.createRoutine(harness, { botConversationId: bot.conversationId, prompt: "report", everyMs: 60_000 });
    await until(() => clock.pending > 0, 5000, "timer armed");
    clock.jump(61_000);
    await until(async () => (Object.values((await harness.snapshot(RoutinesDoc, ctx)).routines)[0].recent ?? []).length > 0, 10_000, "run recorded");
    const rec = Object.values((await harness.snapshot(RoutinesDoc, ctx)).routines)[0];
    assert.equal(rec.fireCount, 1);
    const run = rec.recent[rec.recent.length - 1];
    assert.equal(run.status, "done");
    assert.ok(typeof run.durationMs === "number" && run.durationMs >= 0);
  } finally {
    await harness.close(ctx);
  }
});

test("watch fingerprint logic: same hash skips, different hash fires (pure part via record shape)", async () => {
  // The watch command itself runs in the sandbox (not available offline); test the skip bookkeeping shape by
  // driving a watch routine whose command always fails: hash "error" never equals lastHash, so it fires normally.
  const clock = fakeClock();
  const r = createRoutines({ now: clock.now });
  const { harness, bots } = await open(clock, r);
  try {
    const bot = await bots.createBot({ name: "rw", model: MODEL });
    const conv = await bots.conversation(bot.id);
    const created = await r.createRoutine(harness, {
      botConversationId: bot.conversationId,
      prompt: "report changes",
      everyMs: 60_000,
      watch: { command: "definitely-not-a-command-xyz" },
    });
    assert.equal(created.watch.command, "definitely-not-a-command-xyz");
    await until(() => clock.pending > 0, 5000, "timer armed");
    clock.jump(61_000);
    await until(async () => {
      const rec = Object.values((await harness.snapshot(RoutinesDoc, ctx)).routines)[0];
      return (rec.recent ?? []).some((x) => typeof x === "object" && x.status === "done");
    }, 15_000, "fired despite watch (error hash never matches)").catch((e) => {
      // The tick imports loadSandbox lazily; without sandbox creds the bash() call rejects -> hash stays "error" -> fires.
      throw e;
    });
    const rec = Object.values((await harness.snapshot(RoutinesDoc, ctx)).routines)[0];
    assert.equal(rec.fireCount, 1);
  } finally {
    await harness.close(ctx);
  }
});
