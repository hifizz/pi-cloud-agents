// Loop schedule on a REAL harness with a controllable clock (Issue14 Phase1): the durable Tick task wakes on its
// slot, calls enqueueScheduled through the full createLoops wiring, and the UNIQUE(loop_id,trigger_key) index makes
// it exactly-once — a "down" stretch of missed slots produces ONE run for the next slot, not a replay burst.
// MemoryStorage + faux provider + real openHarness(now,setTimer) + real createLoops. Fully offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { createLoops, loopSched } from "../src/loops/index.mjs";

const REPO = "hifizz/tars-sandbox-playground";
const MAIN_SHA = "3157db095cb9344e5b9cf0669657bf613d036b46";
const MODEL = { provider: "faux", modelId: "faux-1" };
const HOUR = 3_600_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeoutMs = 15_000, what = "condition") {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

/** Controllable clock — same pattern as routines.test.mjs. */
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

function fauxModels() {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(Array.from({ length: 200 }, () => fauxAssistantMessage([fauxText("report")])));
  return models;
}

function fakeGithub() {
  return {
    getRepo: async () => ({ fullName: REPO, defaultBranch: "main" }),
    listBranches: async () => [{ name: "main", sha: MAIN_SHA }],
    getBranch: async (_r, n) => (n === "main" ? { name: "main", sha: MAIN_SHA } : undefined),
    getIssue: async () => undefined,
    listIssueComments: async () => [],
    getPull: async () => undefined,
  };
}

async function makeEnv({ clock } = {}) {
  const harness = (
    await openHarness({
      storage: new MemoryStorage(),
      models: fauxModels(),
      extensions: [Preamble, loopSched.Extension],
      ...(clock ? { now: clock.now, setTimer: clock.setTimer } : {}),
    })
  ).harness;
  const bots = new BotRegistry(harness, { path: null });
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: REPO, defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "w1",
    projectId: project.id,
    name: "loops ws",
    baseBranch: "main",
    branch: "tarsbot/ws",
    cwd: "/home/sprite/workspace/repo",
    model: MODEL,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-abc123" });
  const runtimeBash = async () => async (command) => ({ stdout: "", stderr: "", exitCode: 0 });
  const loops = createLoops({
    store,
    bots,
    github: fakeGithub(),
    runtimeBash,
    harness,
    maxConcurrent: 3,
    homeDir: () => "/home/sprite",
    now: () => clock?.now() ?? Date.now(),
  });
  return { harness, bots, store, ws: workspace, loops, close: async () => { await harness.close(ctx); store.close(); } };
}

test("fake clock + full createLoops: schedule loop fires exactly once per slot; missed slots collapse to one run", async () => {
  const clock = fakeClock(1_000_000); // t0: a whole-hour grid point for the hourly loop
  const env = await makeEnv({ clock });
  try {
    const { loop } = await env.loops.store.create(env.ws.id, {
      name: "hourly-scan",
      instructions: "report",
      trigger: { kind: "schedule", freq: "hourly", interval: 1, tz: "UTC", startAt: 1_000_000 },
      capabilities: { code: "none" },
    });
    await env.loops.restore(); // scheduler.sync registers the Tick task for the enabled schedule loop
    await until(() => clock.pending > 0, 10_000, "durable sleep armed");
    assert.equal(env.store.loopRuns.listByLoop(loop.id).length, 0, "nothing fires before the slot");

    clock.jump(HOUR - 1); // 1ms before the slot
    await sleep(30);
    assert.equal(env.store.loopRuns.listByLoop(loop.id).length, 0);

    clock.jump(1); // slot t0+1h reached
    await until(() => env.store.loopRuns.listByLoop(loop.id).length === 1, 10_000, "first scheduled run enqueued");
    const first = env.store.loopRuns.listByLoop(loop.id)[0];
    assert.equal(first.triggerKind, "schedule");
    assert.equal(first.triggerKey, `schedule:${1_000_000 + HOUR}`, "fired exactly for the grid slot");

    // Wait for the next arm, then "go down" for 5 missed slots.
    await until(() => clock.pending > 0, 10_000, "re-armed for the next slot");
    clock.jump(5 * HOUR + 1234);
    await until(() => env.store.loopRuns.listByLoop(loop.id).length === 2, 10_000, "one catch-up run after the gap");
    await sleep(120); // no burst: strictly one new run even though 5 slots passed
    const runs = env.store.loopRuns.listByLoop(loop.id);
    assert.equal(runs.length, 2, "missed slots are not replayed in a burst");
    const second = runs.find((r) => r.id !== first.id);
    // The catch-up run fires for the slot it was armed for (the 2h grid point), then re-arms strictly after now
    // on the same grid — same semantics as routines' durable sleep.
    assert.equal(second.triggerKey, `schedule:${1_000_000 + 2 * HOUR}`, "single catch-up run for the armed slot");
    // The schedule keeps going on the grid: the next arm lands on the slot after now (t0 + 7h).
    // now = t0 + 6h + 1234ms; the armed slot is t0 + 7h — jump the full hour to cross it.
    await until(() => clock.pending > 0, 10_000, "re-armed after catch-up");
    clock.jump(HOUR); // now = t0 + 7h + 1234ms: crosses the 7h grid slot
    await until(() => env.store.loopRuns.listByLoop(loop.id).length === 3, 10_000, "grid resumes after now");
    const third = env.store.loopRuns.listByLoop(loop.id).find((r) => r.id !== first.id && r.id !== second.id);
    assert.equal(third.triggerKey, `schedule:${1_000_000 + 7 * HOUR}`, "next armed slot is the first grid point after now");
  } finally {
    await env.close();
  }
});

test("enqueueScheduled wiring: repeated enqueue for the same slot dedups to one run; disabled/manual loops ignored", async () => {
  const clock = fakeClock(1_000_000);
  const env = await makeEnv({ clock });
  try {
    const { loop } = await env.loops.store.create(env.ws.id, {
      name: "sched",
      instructions: "i",
      trigger: { kind: "schedule", freq: "hourly", interval: 1, tz: "UTC", startAt: 1_000_000 },
      capabilities: { code: "none" },
    });
    // Direct enqueueScheduled path (what the Tick calls): same slot twice -> one run.
    env.loops.enqueueScheduled(loop.id, 1_000_000 + HOUR);
    env.loops.enqueueScheduled(loop.id, 1_000_000 + HOUR);
    env.loops.enqueueScheduled(loop.id, 1_000_000 + HOUR);
    assert.equal(env.store.loopRuns.listByLoop(loop.id).length, 1);
    // Disabled loop: a tick that still lands (race with disable) enqueues nothing.
    await env.loops.store.setEnabled(loop.id, false);
    env.loops.enqueueScheduled(loop.id, 1_000_000 + 2 * HOUR);
    assert.equal(env.store.loopRuns.listByLoop(loop.id).length, 1, "disabled loop does not enqueue");
    // Manual-trigger loop: schedule ticks never apply.
    const { loop: manual } = await env.loops.store.create(env.ws.id, {
      name: "m",
      instructions: "i",
      trigger: { kind: "manual" },
      capabilities: { code: "none" },
    });
    env.loops.enqueueScheduled(manual.id, 1_000_000 + 3 * HOUR);
    assert.equal(env.store.loopRuns.listByLoop(manual.id).length, 0);
    await env.loops.queue.idle();
  } finally {
    await env.close();
  }
});
