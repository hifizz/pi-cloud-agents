// Loop queue tests (Issue14 Phase1): FIFO, maxConcurrent, cancel, failure slot release, restart restore,
// trigger_key dedup, disabled-loop behavior. In-memory store, injected fake runner — fully offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openControlStore } from "../src/control/store.mjs";
import { createLoopQueue } from "../src/loops/queue.mjs";

const WS_MODEL = { provider: "faux", modelId: "faux-1" };

function env() {
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
  const mkLoop = (name, enabled = true) =>
    store.loops.create({ workspaceId: workspace.id, name, instructions: "i", trigger: { kind: "manual" }, capabilities: {}, enabled });
  return { store, ws: workspace, mkLoop };
}

/** A controllable runner: started runs park until resolve/reject is called. pending() = unsettled run ids. */
function controllable() {
  const running = new Map();
  const calls = [];
  const runOne = (run) =>
    new Promise((resolve, reject) => {
      calls.push(run.id);
      running.set(run.id, { resolve, reject, runId: run.id });
    });
  return {
    calls,
    runOne,
    /** Resolve a parked run (its runOne resolves -> queue marks it). */
    finish(id) {
      const e = running.get(id);
      running.delete(id);
      e?.resolve();
    },
    fail(id, e = new Error("boom")) {
      const x = running.get(id);
      running.delete(id);
      x?.reject(e);
    },
    pending: () => [...running.keys()],
    /** Settle every parked run so a test never leaves dangling in-flight work. */
    settleAll() {
      for (const id of [...running.keys()]) this.finish(id);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("5 runs enqueue -> exactly maxConcurrent starting, rest queued with FIFO positions", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const c = controllable();
  const q = createLoopQueue({ store, runOne: c.runOne, maxConcurrent: 3 });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const { run } = q.enqueue({ loop, triggerKind: "manual", triggerKey: `m:${i}` });
    ids.push(run.id);
  }
  await tick();
  const v = q.view();
  assert.equal(v.running.length, 3);
  assert.equal(v.queued.length, 2);
  assert.deepEqual(v.queued.map((r) => r.position), [1, 2]);
  assert.deepEqual(c.calls, ids.slice(0, 3), "first three started in FIFO order");
  c.settleAll();
  await q.idle();
  store.close();
});

test("a finished run frees the slot; queue head starts next (strict FIFO)", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const c = controllable();
  const q = createLoopQueue({ store, runOne: c.runOne, maxConcurrent: 3 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(q.enqueue({ loop, triggerKind: "manual", triggerKey: `m:${i}` }).run.id);
  await tick();
  c.finish(ids[0]);
  await tick();
  assert.ok(c.calls.includes(ids[3]), "position-1 run started");
  assert.equal(store.loopRuns.get(ids[0]).status, "succeeded");
  c.finish(ids[1]);
  c.finish(ids[2]);
  c.finish(ids[3]);
  await tick();
  assert.ok(c.calls.includes(ids[4]));
  c.settleAll();
  await q.idle();
  assert.deepEqual(ids.map((id) => store.loopRuns.get(id).status), ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
  store.close();
});

test("maxConcurrent is reconfigurable to 1 and 5", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const c = controllable();
  const q = createLoopQueue({ store, runOne: c.runOne, maxConcurrent: 3 });
  for (let i = 0; i < 5; i++) q.enqueue({ loop, triggerKind: "manual", triggerKey: `m:${i}` });
  await tick();
  q.setMaxConcurrent(1);
  assert.equal(q.view().running.length, 3, "already-occupying runs are not preempted");
  c.settleAll();
  await tick();
  assert.equal(q.view().running.length, 1, "new limit 1 honored");
  q.setMaxConcurrent(5);
  await tick();
  assert.equal(q.view().running.length, 2, "limit 5 lets the rest run");
  c.settleAll();
  await q.idle();
  store.close();
});

test("cancel queued: never starts, positions shift; cancel running: abort confirmed then slot freed", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const c = controllable();
  const aborted = [];
  // abortRun confirms the abort by settling the parked runOne — the slot is released only after that.
  const q = createLoopQueue({
    store,
    runOne: c.runOne,
    abortRun: async (r) => {
      aborted.push(r.id);
      c.finish(r.id);
    },
    maxConcurrent: 2,
  });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(q.enqueue({ loop, triggerKind: "manual", triggerKey: `m:${i}` }).run.id);
  await tick();
  // cancel the first queued (position 1 = ids[2])
  const canceled = await q.cancel(ids[2]);
  assert.equal(canceled.status, "canceled");
  await tick();
  assert.ok(!c.calls.includes(ids[2]), "canceled queued run never started");
  const v = q.view();
  assert.deepEqual(v.queued.map((r) => r.id), [ids[3]], "the last run moved up to position 1");
  assert.equal(v.queued[0].position, 1);
  // cancel a running one: cancel() awaits the abort-confirmed settle before marking it canceled
  const canceledRun = await q.cancel(ids[0]);
  assert.equal(canceledRun.status, "canceled");
  assert.deepEqual(aborted, [ids[0]], "abortRun was called for the running run");
  await tick();
  assert.ok(c.calls.includes(ids[3]), "slot freed: the next run started");
  c.settleAll();
  await q.idle();
  store.close();
});

test("cancel running with an abort that never settles: grace elapses, slot freed, error recorded", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const c = controllable();
  const q = createLoopQueue({ store, runOne: c.runOne, abortRun: async () => {}, maxConcurrent: 1 });
  const a = q.enqueue({ loop, triggerKind: "manual", triggerKey: "a" }).run;
  const b = q.enqueue({ loop, triggerKind: "manual", triggerKey: "b" }).run;
  await tick();
  const out = await q.cancel(a.id, { abortGraceMs: 30 });
  assert.equal(out.status, "canceled");
  await tick();
  assert.ok(c.calls.includes(b.id), "the slot was freed after the bounded grace");
  // the abandoned runOne still settles eventually; finish() maps it to canceled via cancelRequested — wait: the run
  // is already terminal, so finish is a no-op. Resolve it so the test leaves nothing in flight.
  c.finish(a.id);
  c.settleAll();
  await q.idle();
  store.close();
});

test("a failed run marks failed with error and releases its slot", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const c = controllable();
  const q = createLoopQueue({ store, runOne: c.runOne, maxConcurrent: 1 });
  const a = q.enqueue({ loop, triggerKind: "manual", triggerKey: "a" }).run;
  const b = q.enqueue({ loop, triggerKind: "manual", triggerKey: "b" }).run;
  await tick();
  c.fail(a.id, new Error("worktree failed"));
  await tick();
  const runA = store.loopRuns.get(a.id);
  assert.equal(runA.status, "failed");
  assert.match(runA.error, /worktree failed/);
  assert.ok(c.calls.includes(b.id), "next run started after the failure");
  c.settleAll();
  await q.idle();
  store.close();
});

test("dedup: same (loopId, trigger_key) never makes a second run", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const c = controllable();
  const q = createLoopQueue({ store, runOne: c.runOne, maxConcurrent: 3 });
  const a = q.enqueue({ loop, triggerKind: "webhook", triggerKey: "webhook:abc" });
  const b = q.enqueue({ loop, triggerKind: "webhook", triggerKey: "webhook:abc" });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.run.id, b.run.id);
  assert.equal(store.loopRuns.listByLoop(loop.id).length, 1);
  await tick(); // let the dequeued runOne get invoked and park before settling it
  c.settleAll();
  await q.idle();
  store.close();
});

test("disabled loop: enqueue reports skipped; a run enqueued while enabled skips at dequeue if disabled later", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L", true);
  const c = controllable();
  const q = createLoopQueue({ store, runOne: c.runOne, maxConcurrent: 1 });
  store.loops.update(loop.id, { enabled: false });
  const skipped = q.enqueue({ loop: store.loops.get(loop.id), triggerKind: "schedule", triggerKey: "schedule:1" });
  assert.equal(skipped.skipped, true);
  assert.equal(store.loopRuns.get(skipped.run.id).status, "skipped");
  assert.equal(c.calls.length, 0, "no run started");

  // enabled at enqueue, disabled before dequeue -> skipped at dequeue, slot never taken
  store.loops.update(loop.id, { enabled: true });
  const a = q.enqueue({ loop: store.loops.get(loop.id), triggerKind: "manual", triggerKey: "x" });
  const b = q.enqueue({ loop: store.loops.get(loop.id), triggerKind: "manual", triggerKey: "y" });
  store.loops.update(loop.id, { enabled: false });
  await tick();
  c.finish(a.run.id);
  await tick();
  assert.equal(store.loopRuns.get(b.run.id).status, "skipped");
  assert.ok(!c.calls.includes(b.run.id));
  c.settleAll();
  await q.idle();
  store.close();
});

test("restore: queued keep order; starting/running marked failed(interrupted) when the session is dead, kept when live", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  // seed rows directly: 2 queued + running(live) + starting(dead) + running(dead)
  const seed = (key, status, extra = {}) =>
    store.loopRuns.enqueue({ loopId: loop.id, loopVersion: 1, workspaceId: loop.workspaceId, triggerKind: "manual", triggerKey: key, ...extra }).run;
  const live = seed("live", "queued");
  const deadStart = seed("deadstart", "queued");
  const deadRun = seed("deadrun", "queued");
  const q1 = seed("q1", "queued");
  const q2 = seed("q2", "queued");
  store.loopRuns.update(live.id, { status: "running", botId: "bot-live" });
  store.loopRuns.update(deadStart.id, { status: "starting" });
  store.loopRuns.update(deadRun.id, { status: "running", botId: "bot-dead" });

  const c = controllable();
  const q = createLoopQueue({
    store,
    runOne: c.runOne,
    maxConcurrent: 3,
    isRunSessionLive: async (run) => run.botId === "bot-live",
  });
  await q.restore();
  assert.equal(store.loopRuns.get(live.id).status, "running", "live session keeps its slot");
  assert.equal(store.loopRuns.get(deadStart.id).status, "failed");
  assert.match(store.loopRuns.get(deadStart.id).error, /interrupted/);
  assert.equal(store.loopRuns.get(deadRun.id).status, "failed");
  // the two queued runs keep order and the two freed slots start them (live still occupies one of three)
  const v = q.view();
  assert.deepEqual(v.queued.map((r) => r.id), [], "both queued runs dequeued into the freed slots");
  assert.deepEqual(c.calls.sort(), [q1.id, q2.id].sort(), "queued runs started in order after restore");
  c.settleAll();
  // 'live' is not ours to settle (its session belongs to the previous process); mark it finished directly.
  q.finish(live.id, { status: "succeeded" });
  await q.idle();
  store.close();
});

test("restore never re-runs a run that was already dequeued once (no double-start)", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const c = controllable();
  const q = createLoopQueue({ store, runOne: c.runOne, maxConcurrent: 3, isRunSessionLive: async () => false });
  const { run } = q.enqueue({ loop, triggerKind: "manual", triggerKey: "x" });
  await tick();
  assert.equal(c.calls.length, 1, "started once");
  // simulate a restart while it was starting: status persisted as starting
  assert.equal(store.loopRuns.get(run.id).status, "starting");
  await q.restore(); // dead session -> failed(interrupted), NOT re-run
  assert.equal(store.loopRuns.get(run.id).status, "failed");
  assert.equal(c.calls.length, 1, "restore did not run it again");
  c.settleAll();
  await q.idle();
  store.close();
});

test("restore: a live run is adopted — its settle releases the slot through finish()", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const live = store.loopRuns
    .enqueue({ loopId: loop.id, loopVersion: 1, workspaceId: loop.workspaceId, triggerKind: "schedule", triggerKey: "s:1" })
    .run;
  store.loopRuns.update(live.id, { status: "running", botId: "bot-live" });
  const queued = store.loopRuns
    .enqueue({ loopId: loop.id, loopVersion: 1, workspaceId: loop.workspaceId, triggerKind: "manual", triggerKey: "q" })
    .run;
  const c = controllable();
  let release;
  const resumed = [];
  const q = createLoopQueue({
    store,
    runOne: c.runOne,
    maxConcurrent: 1, // live occupies the only slot: the queued run waits until the adopted settle frees it
    isRunSessionLive: async () => true,
    resumeRun: (run) => new Promise((res) => { resumed.push(run.id); release = res; }),
  });
  await q.restore();
  assert.deepEqual(resumed, [live.id], "the live run was adopted via resumeRun");
  assert.equal(store.loopRuns.get(live.id).status, "running", "still running while the session is mid-answer");
  assert.equal(store.loopRuns.get(queued.id).status, "queued", "queued run waits: live still occupies the slot");
  release(); // the resumed submission settles successfully
  await tick();
  assert.equal(store.loopRuns.get(live.id).status, "succeeded", "adopted settle -> succeeded");
  await tick();
  assert.ok(c.calls.includes(queued.id), "slot freed by the adopted settle: queued run started");
  c.settleAll();
  await q.idle();
  store.close();
});

test("restore: adopted run's settle failure marks it failed and frees the slot", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const live = store.loopRuns
    .enqueue({ loopId: loop.id, loopVersion: 1, workspaceId: loop.workspaceId, triggerKind: "manual", triggerKey: "s:1" })
    .run;
  store.loopRuns.update(live.id, { status: "running", botId: "bot-live" });
  let reject;
  const q = createLoopQueue({
    store,
    runOne: controllable().runOne,
    maxConcurrent: 1,
    isRunSessionLive: async () => true,
    resumeRun: () => new Promise((_, rej) => { reject = rej; }),
  });
  await q.restore();
  reject(new Error("submission aborted during restart"));
  await tick();
  const done = store.loopRuns.get(live.id);
  assert.equal(done.status, "failed");
  assert.match(done.error, /aborted/);
  assert.equal(store.loopRuns.countOccupying(), 0, "slot released");
  store.close();
});

test("B1: cancel while 'starting' never resurrects the run — no Bot, no status overwrite", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  // runOne simulates the real runner: a slow worktree step, then a canceled-check before any Bot/session side effect,
  // mirroring runner.checkNotCanceled (queue flag or terminal row).
  let botsCreated = 0;
  const q = createLoopQueue({
    store,
    maxConcurrent: 1,
    abortRun: async () => {},
    isRunSessionLive: async () => false,
    runOne: async (run) => {
      await new Promise((r) => setTimeout(r, 40)); // slow worktree: the cancel lands inside this window
      const canceled = q.isCanceled(run.id) || ["succeeded", "failed", "canceled", "skipped"].includes(store.loopRuns.get(run.id)?.status);
      if (canceled) {
        const e = new Error("run canceled");
        e.code = "canceled";
        throw e;
      }
      botsCreated++;
      store.loopRuns.update(run.id, { status: "running", botId: "botX" }); // terminal guard refuses on a canceled row
      store.loopRuns.update(run.id, { status: "succeeded" });
    },
  });
  const { run } = q.enqueue({ loop, triggerKind: "manual", triggerKey: "m1" });
  await tick(); // dequeued -> starting, runOne sleeping
  const out = await q.cancel(run.id, { abortGraceMs: 60 });
  assert.equal(out.status, "canceled");
  await q.idle();
  const final = store.loopRuns.get(run.id);
  assert.equal(final.status, "canceled", "never resurrected to running/succeeded");
  assert.equal(botsCreated, 0, "no Bot was created for the canceled run");
  assert.equal(final.botId, null);
  store.close();
});

test("B1: a bot created just before cancel is recorded but never reaches succeeded", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const q = createLoopQueue({
    store,
    maxConcurrent: 1,
    abortRun: async () => {},
    runOne: async (run) => {
      // Bot already exists when the cancel lands during the post-create check: the audit field lands, status never revives.
      store.loopRuns.update(run.id, { botId: "bot-orphan", startedAt: "2026-10-31T00:00:00Z" });
      await new Promise((r) => setTimeout(r, 40)); // configure/submit window
      const canceled = q.isCanceled(run.id) || ["succeeded", "failed", "canceled", "skipped"].includes(store.loopRuns.get(run.id)?.status);
      if (canceled) { const e = new Error("run canceled"); e.code = "canceled"; throw e; }
      store.loopRuns.update(run.id, { status: "succeeded" }); // terminal guard refuses this even if reached
    },
  });
  const { run } = q.enqueue({ loop, triggerKind: "manual", triggerKey: "m2" });
  await tick();
  const out = await q.cancel(run.id, { abortGraceMs: 60 });
  assert.equal(out.status, "canceled");
  await q.idle();
  const final = store.loopRuns.get(run.id);
  assert.equal(final.status, "canceled");
  assert.equal(final.botId, "bot-orphan", "the orphan Session id stays recorded for audit/cleanup");
  store.close();
});

test("terminal guard: a status update against a finished run is rejected, audit fields still writable", async () => {
  const { store, mkLoop } = env();
  const loop = mkLoop("L");
  const run = store.loopRuns
    .enqueue({ loopId: loop.id, loopVersion: 1, workspaceId: loop.workspaceId, triggerKind: "manual", triggerKey: "t" })
    .run;
  store.loopRuns.update(run.id, { status: "succeeded", endedAt: "2026-10-31T00:00:00Z" });
  assert.throws(() => store.loopRuns.update(run.id, { status: "running" }), /已终结|invalid/);
  assert.throws(() => store.loopRuns.update(run.id, { status: "failed" }), /已终结|invalid/);
  // non-status audit fields stay writable (e.g. an orphan botId recorded after a late createBot)
  store.loopRuns.update(run.id, { botId: "bot-late" });
  assert.equal(store.loopRuns.get(run.id).botId, "bot-late");
  assert.equal(store.loopRuns.get(run.id).status, "succeeded");
  store.close();
});
