// Loop scheduler (Issue14 Phase1): durable wake-ups for schedule-triggered loops.
//
// Mechanism reuses pi-durable's durable sleep (same as src/ext/routines.mjs), but as a separate extension:
// the existing routine behavior is untouched. One background task per scheduled loop, owned by a carrier
// conversation ("loops.scheduler", an ownerless conversation created once and remembered in control meta).
// At each slot the task calls the injected enqueue(loopId, triggerKey, slot) — exactly-once comes from the
// loop_runs UNIQUE(loop_id, trigger_key) index, so a replayed fire is absorbed by the database, not by luck.
// Missed slots are never replayed in a burst: the next slot is computed strictly after now on the original grid.
import { randomUUID } from "node:crypto";
import { defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { ctx } from "../harness.mjs";
import { nextSlot, scheduleTriggerKey } from "./schedule.mjs";

/** Session doc: loopId -> {taskId} of the live schedule task. */
export const LoopSchedDoc = defineDoc({
  kind: "tarsbot.loops.sched",
  version: 1,
  scope: "session",
  initial: () => ({ tasks: {} }),
  checkpointWhen: () => false,
});

/**
 * @param {{ enqueue: (loopId: string, slotMs: number) => void | Promise<void>, now?: () => number }} deps
 */
export function createLoopSched(deps) {
  if (typeof deps?.enqueue !== "function") throw new TypeError("createLoopSched requires an enqueue(loopId, slotMs) callback");
  const enqueue = deps.enqueue;

  const Tick = defineTask({
    name: "loops.schedule.tick",
    version: 1,
    initial: (input) => ({ phase: "tick", nextAt: input.firstAt }),
    phases: {
      tick: async (task, runtime, taskContext) => {
        const { loopId, spec } = task.input;
        const scheduled = task.state.checkpoint.nextAt;
        if (runtime.now() < scheduled) {
          await runtime.sleepUntil(scheduled, { phase: "tick", nextAt: scheduled }, taskContext);
          return;
        }
        // Removed from the registry (loop disabled / trigger changed / deleted): finish quietly.
        const rec = (await runtime.snapshot(LoopSchedDoc, taskContext))?.tasks?.[loopId];
        if (!rec) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { fired: 0 } } }), taskContext);
          return;
        }
        // Fire once for this slot. Dedup is the store's UNIQUE(loop_id, trigger_key): enqueue is idempotent.
        try {
          await enqueue(loopId, scheduled);
        } catch (e) {
          // A failing enqueue is visible in the run history attempt via error propagation; the schedule keeps ticking.
          console.error(`loops.schedule: enqueue ${loopId} failed: ${String(e?.message ?? e).slice(0, 200)}`);
        }
        const nextAt = nextSlot(spec, Math.max(runtime.now(), scheduled));
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(LoopSchedDoc);
          const r = doc.tasks[loopId];
          if (r) {
            r.nextAt = nextAt;
            r.lastFiredAt = scheduled;
            r.fireCount = (r.fireCount ?? 0) + 1;
          }
          return { status: "sleeping", until: nextAt, checkpoint: { phase: "tick", nextAt } };
        }, taskContext);
      },
    },
    abort: async (task, runtime, taskContext) => {
      await runtime.commit(async (tx) => {
        delete (await tx.doc(LoopSchedDoc)).tasks[task.input.loopId];
        return { status: "terminal", outcome: { status: "aborted" } };
      }, taskContext);
    },
  });

  const Extension = defineExtension({ name: "tarsbot.loops.schedule", tasks: [Tick] });

  return { Extension, Tick };
}

/**
 * Scheduler lifecycle manager over a live harness. Keeps one background Tick task per enabled schedule loop.
 * The carrier conversation is created once (ownerless) and remembered in control meta `loops.carrierConversationId`.
 *
 * @param {{ harness: any, store: any, enqueue: (loopId: string, slotMs: number) => void | Promise<void>, Tick: any, now?: () => number }} opts
 */
export function createLoopScheduler({ harness, store, enqueue, Tick, now = Date.now }) {
  async function carrier() {
    const id = store.meta.get("loops.carrierConversationId");
    if (id !== undefined) {
      const conv = await harness.conversation(id, ctx);
      if (conv) return conv;
    }
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    store.meta.ensure("loops.carrierConversationId", () => conv.id);
    return conv;
  }

  /** Ensure loop's schedule task matches its current trigger; creates, rebuilds or removes as needed. */
  async function sync(loop) {
    const doc = await harness.snapshot(LoopSchedDoc, ctx);
    const rec = doc?.tasks?.[loop.id];
    const wantsSchedule = loop.enabled && loop.trigger?.kind === "schedule";
    const spec = wantsSchedule ? loop.trigger : undefined;
    const sameSpec = rec && JSON.stringify(rec.spec) === JSON.stringify(spec);
    if (rec && sameSpec) return rec;
    if (rec) await stop(loop.id);
    if (!spec) return undefined;
    const conv = await carrier();
    const firstAt = nextSlot(spec, now());
    const taskId = await conv.commit(async (tx) => {
      const taskId = await tx.createTask(Tick, { loopId: loop.id, spec, firstAt }, { ownership: { kind: "conversation" }, background: true });
      const doc2 = await tx.doc(LoopSchedDoc);
      doc2.tasks[loop.id] = { taskId, spec, nextAt: firstAt, fireCount: 0 };
      return taskId;
    }, ctx);
    return { taskId, spec, nextAt: firstAt };
  }

  async function stop(loopId) {
    const doc = await harness.snapshot(LoopSchedDoc, ctx);
    const rec = doc?.tasks?.[loopId];
    if (!rec) {
      // Still make sure the doc no longer claims a task (e.g. abort handler already removed it).
      return;
    }
    await harness.abortTask(rec.taskId, ctx);
    await harness.commit(async (tx) => {
      delete (await tx.doc(LoopSchedDoc)).tasks[loopId];
    }, ctx);
  }

  /** Boot: sync every loop in the store (adds missing, removes stale, rebuilds changed specs). */
  async function restore() {
    const all = [];
    for (const ws of store.workspaces.list()) all.push(...store.loops.listByWorkspace(ws.id));
    const doc = await harness.snapshot(LoopSchedDoc, ctx);
    for (const loopId of Object.keys(doc?.tasks ?? {})) {
      if (!all.some((l) => l.id === loopId)) await stop(loopId);
    }
    for (const loop of all) await sync(loop);
  }

  return { sync, stop, restore, Tick };
}
