// Loops bundle (Issue14 Phase1): store + queue + runner + scheduler, wired once by server.mjs.
// Everything is injectable so tests can compose the same pieces over an in-memory store, a fake Bot registry,
// a fake runtimeBash and a faux harness clock.
import { createLoopStore } from "./store.mjs";
import { createLoopQueue } from "./queue.mjs";
import { createLoopRunner } from "./runner.mjs";
import { createLoopSched, createLoopScheduler } from "./sched.mjs";
import { scheduleTriggerKey } from "./schedule.mjs";

// The scheduler extension is created once (the task definition must be the same object the registry holds).
export const loopSched = createLoopSched({
  enqueue: (loopId, slotMs) => defaultEnqueue?.(loopId, slotMs),
});
let defaultEnqueue;

/**
 * @param {object} opts
 * @param {object} opts.store control store (loops/loopRuns/workspaces/bindings/links/meta)
 * @param {object} opts.bots BotRegistry
 * @param {object} opts.github GitHub client
 * @param {(wsId: string) => Promise<Function>} opts.runtimeBash workspace runtime bash resolver
 * @param {object} opts.harness pi-durable harness (schedule tasks + restart probes)
 * @param {number} [opts.maxConcurrent] queue limit (default config.loopsMaxConcurrent / 3)
 * @param {() => number} [opts.now]
 * @param {() => string} [opts.homeDir]
 * @param {(msg: string) => void} [opts.log]
 */
export function createLoops(opts) {
  const { store, bots, github, runtimeBash, harness } = opts;
  const now = opts.now ?? Date.now;
  const loopStore = createLoopStore({ store, now });
  // queue is declared before runner: runner's finishRun/isRunCanceled close over it and only run after queue exists.
  let queue;
  const runner = createLoopRunner({
    store,
    bots,
    github,
    runtimeBash,
    harness,
    homeDir: opts.homeDir,
    now,
    // B1: every terminal outcome goes through queue.finish — terminal-state + cancelRequested protection in one place.
    finishRun: (runId, outcome) => queue.finish(runId, outcome),
    isRunCanceled: (runId) => queue.isCanceled(runId),
  });

  const enqueueScheduled = (loopId, slotMs) => {
    const loop = store.loops.get(loopId);
    if (!loop || !loop.enabled || loop.trigger?.kind !== "schedule") return;
    queue.enqueue({
      loop,
      triggerKind: "schedule",
      triggerKey: scheduleTriggerKey(slotMs),
      payload: { slot: slotMs },
    });
  };

  queue = createLoopQueue({
    store,
    runOne: (run) => runner.runOne(run),
    abortRun: (run) => runner.abortRun(run),
    isRunSessionLive: (run) => runner.isRunSessionLive(run),
    resumeRun: (run) => runner.resumeRun(run),
    maxConcurrent: opts.maxConcurrent ?? 3,
    now,
    log: opts.log,
  });

  const scheduler = harness
    ? createLoopScheduler({ harness, store, enqueue: enqueueScheduled, Tick: loopSched.Tick, now })
    : undefined;

  defaultEnqueue = enqueueScheduled;

  /**
   * Boot reconciliation: queued rows keep their order; in-flight rows keep a slot only when their Session is
   * still executing under pi-durable; then schedule tasks are re-synced. Call after the harness is open and
   * resolvers are installed, before the API accepts traffic.
   */
  async function restore() {
    await queue.restore();
    if (scheduler) await scheduler.restore();
  }

  return { store: loopStore, queue, runner, scheduler, restore, enqueueScheduled };
}
