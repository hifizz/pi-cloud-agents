// Scheduled routines (F06): a routine is a durable BACKGROUND task that periodically submits a prompt to a Bot.
//
// How "wait until time T" works in pi-durable 1.0.4 (verified in node_modules/.../dist/types.d.ts + harness/scheduler.js):
//   - There IS a native timed wait: `runtime.sleep(untilMs, ctx)` resolves once the Harness clock (`HarnessOptions.now`,
//     default Date.now) reaches `untilMs`. It is an IN-MEMORY timer (setTimeout chunks) bound to the task invocation:
//     closing the Harness cancels it, and nothing about the wait itself is persisted.
//   - Durability therefore comes from the checkpoint: the task stores `{phase:"tick", nextAt}` through `runtime.commit`.
//     After a restart `harness.resume()` re-reserves the unfinished task, the phase handler runs again from the saved
//     checkpoint and re-arms the sleep from `nextAt`. If `nextAt` already passed, the sleep returns at once.
//   - Catch-up: one firing per overdue slot series. After waking late we fire ONCE (for the saved `nextAt`), then compute
//     the next slot strictly after "now" on the original grid, so missed slots are never replayed in a burst.
//   - Exactly-once: the submission carries `requestId = routine:<id>:<nextAt>`. If a crash happens between submit and the
//     checkpoint commit, the rerun submits the same requestId and pi-durable returns the first submission.
//   - Abort semantics (REQ-F06-3): the task is `background: true`, so `conv.abort(ctx)` skips it;
//     `conv.abort(ctx, { background: true })` (or `cancelRoutine`) reaches it and the task's `abort` handler ends it.
//
// Clock injection: `createRoutines({ now, setTimer })`. Without injection the native `runtime.sleep` is used. With injection
// the task sleeps with the injected clock instead (loop: `now() < until` -> `setTimer(wake, ms)`), so tests can drive time
// with a fake clock. `setTimer(fn, ms)` must return a cancel function.
//
// The routine list lives in a Session-scoped document (`tarsbot.routines`): routines span bots, so no single conversation
// should own the list. The document is updated inside the same commit as each checkpoint.
import { randomUUID } from "node:crypto";
import { defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { ctx } from "../harness.mjs";

const MAX_TIMER_MS = 2 ** 31 - 1;
const RECENT_FIRES = 20;

/** Session document: routine id -> public record (also what listRoutines returns). */
export const RoutinesDoc = defineDoc({
  kind: "tarsbot.routines",
  version: 1,
  scope: "session",
  initial: () => ({ routines: {} }),
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Validate an atTimes list; returns a sorted, de-duplicated copy. */
export function normalizeAtTimes(atTimes) {
  if (!Array.isArray(atTimes) || atTimes.length === 0) throw new Error("atTimes must be a non-empty array of HH:MM");
  for (const t of atTimes) if (typeof t !== "string" || !TIME_RE.test(t)) throw new Error(`invalid time "${t}", expected HH:MM`);
  return [...new Set(atTimes)].sort();
}

/** Next local-time HH:MM slot strictly after `after` (ms since epoch). */
export function nextAtTime(atTimes, after) {
  const base = new Date(after);
  let best = Infinity;
  for (let day = 0; day <= 2; day++) {
    for (const t of atTimes) {
      const [h, m] = t.split(":").map(Number);
      const ms = new Date(base.getFullYear(), base.getMonth(), base.getDate() + day, h, m, 0, 0).getTime();
      if (ms > after && ms < best) best = ms;
    }
    if (best !== Infinity) break;
  }
  return best;
}

/**
 * Next firing time after a firing scheduled for `scheduled`, given the current time `now`.
 * everyMs: next grid slot strictly after `now` (never earlier than scheduled + everyMs). atTimes: next HH:MM after now.
 */
export function computeNext(spec, scheduled, now) {
  if (spec.atTimes?.length) return nextAtTime(spec.atTimes, Math.max(now, scheduled));
  const every = spec.everyMs;
  const after = Math.max(now, scheduled);
  const steps = Math.floor((after - scheduled) / every) + 1;
  return scheduled + steps * every;
}

function defaultSetTimer(fn, ms) {
  const t = setTimeout(fn, Math.min(ms, MAX_TIMER_MS));
  return () => clearTimeout(t);
}

/** Sleep with an injected clock. Rejects with signal.reason when aborted. */
function sleepInjected({ now, setTimer }, until, signal) {
  return new Promise((resolve, reject) => {
    let cancel = () => {};
    const onAbort = () => {
      cancel();
      reject(signal.reason ?? new Error("aborted"));
    };
    const step = () => {
      if (signal.aborted) return onAbort();
      const remaining = until - now();
      if (remaining <= 0) {
        signal.removeEventListener("abort", onAbort);
        return resolve();
      }
      cancel = setTimer(step, remaining);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    step();
  });
}

/**
 * Build a routines bundle. Use the default exports unless you need an injected clock.
 * @param {{ now?: () => number, setTimer?: (fn: () => void, ms: number) => (() => void) }} [opts]
 */
export function createRoutines(opts = {}) {
  const injected = opts.now || opts.setTimer;
  const clock = { now: opts.now ?? Date.now, setTimer: opts.setTimer ?? defaultSetTimer };

  const Tick = defineTask({
    name: "routine.tick",
    version: 1,
    initial: (input) => ({ phase: "tick", nextAt: input.firstAt }),
    phases: {
      tick: async (task, runtime, taskContext) => {
        const { id, botConversationId, prompt, everyMs, atTimes } = task.input;
        const scheduled = task.state.checkpoint.nextAt;
        // Wait for the saved slot. After a restart this re-arms from the checkpoint (returns at once if overdue).
        if (injected) await sleepInjected(clock, scheduled, runtime.signal);
        else await runtime.sleep(scheduled, taskContext);

        // Disabled or removed from the list: finish quietly.
        const current = (await runtime.snapshot(RoutinesDoc, taskContext))?.routines?.[id];
        if (!current || current.enabled === false) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { fired: 0 } } }), taskContext);
          return;
        }

        // followUp: never steer a running answer; the prompt waits for the current answer to finish.
        const conv = await runtime.conversation(botConversationId, taskContext);
        if (!conv) {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "failed", error: { message: `conversation ${botConversationId} not found` } } }),
            taskContext,
          );
          return;
        }
        const requestId = `routine:${id}:${scheduled}`;
        const submission = await conv.submit({ type: "input", content: prompt, whenBusy: "followUp", requestId }, taskContext);

        const nowMs = clock.now();
        const nextAt = computeNext({ everyMs, atTimes }, scheduled, injected ? nowMs : runtime.now());
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(RoutinesDoc);
          const rec = doc.routines[id];
          if (rec) {
            rec.nextAt = nextAt;
            rec.lastFiredAt = scheduled;
            rec.lastSubmissionId = submission.id;
            rec.fireCount = (rec.fireCount ?? 0) + 1;
            rec.recent.push(scheduled);
            while (rec.recent.length > RECENT_FIRES) rec.recent.shift();
          }
          return { status: "running", checkpoint: { phase: "tick", nextAt } };
        }, taskContext);
      },
    },
    abort: async (task, runtime, taskContext) => {
      await runtime.commit(async (tx) => {
        const rec = (await tx.doc(RoutinesDoc)).routines[task.input.id];
        if (rec) rec.enabled = false;
        return { status: "terminal", outcome: { status: "aborted" } };
      }, taskContext);
    },
  });

  const Routines = defineExtension({ name: "tarsbot.routines", tasks: [Tick] });

  /**
   * Create a routine for a Bot conversation. Exactly one of everyMs / atTimes.
   * @param {any} harness
   * @param {{ botConversationId: number, prompt: string, everyMs?: number, atTimes?: string[] }} spec
   */
  async function createRoutine(harness, spec) {
    const { botConversationId, prompt } = spec ?? {};
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt is required");
    const hasEvery = spec.everyMs !== undefined && spec.everyMs !== null;
    const hasAt = spec.atTimes !== undefined && spec.atTimes !== null;
    if (hasEvery === hasAt) throw new Error("exactly one of everyMs or atTimes is required");
    if (hasEvery && !(Number.isFinite(spec.everyMs) && spec.everyMs >= 1)) throw new Error("everyMs must be a positive number");
    const atTimes = hasAt ? normalizeAtTimes(spec.atTimes) : undefined;
    const conv = await harness.conversation(botConversationId, ctx);
    if (!conv) throw new Error(`conversation not found: ${botConversationId}`);

    const id = randomUUID().slice(0, 8);
    const createdAt = clock.now();
    const firstAt = atTimes ? nextAtTime(atTimes, createdAt) : createdAt + Math.floor(spec.everyMs);
    const input = {
      id,
      botConversationId,
      prompt,
      firstAt,
      ...(atTimes ? { atTimes } : { everyMs: Math.floor(spec.everyMs) }),
    };
    // The conversation handle's commit binds the task to the target conversation; background keeps Esc away from it.
    const taskId = await conv.commit(async (tx) => {
      const taskId = await tx.createTask(Tick, input, { ownership: { kind: "conversation" }, background: true });
      const doc = await tx.doc(RoutinesDoc);
      doc.routines[id] = {
        id,
        taskId,
        botConversationId,
        prompt,
        ...(atTimes ? { atTimes } : { everyMs: input.everyMs }),
        enabled: true,
        createdAt,
        nextAt: firstAt,
        fireCount: 0,
        recent: [],
      };
      return taskId;
    }, ctx);
    return { id, taskId, botConversationId, prompt, nextAt: firstAt, enabled: true, ...(atTimes ? { atTimes } : { everyMs: input.everyMs }) };
  }

  /** All routines, each with the live task status ("pending"|"running"|...|"terminal:<outcome>"). */
  async function listRoutines(harness) {
    const doc = await harness.snapshot(RoutinesDoc, ctx);
    const out = [];
    for (const rec of Object.values(doc?.routines ?? {})) {
      const task = await harness.getTask(rec.taskId, ctx);
      const st = task?.state;
      const status = !st ? "missing" : st.status === "terminal" ? `terminal:${st.outcome.status}` : st.status;
      out.push({ ...structuredClone(rec), status });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Stop a routine for good (background abort of its task). Returns false when unknown. */
  async function cancelRoutine(harness, id) {
    const doc = await harness.snapshot(RoutinesDoc, ctx);
    const rec = doc?.routines?.[id];
    if (!rec) return false;
    await harness.abortTask(rec.taskId, ctx);
    // Already-terminal tasks never ran the abort handler; make sure the list says disabled.
    await harness.commit(async (tx) => {
      const r = (await tx.doc(RoutinesDoc)).routines[id];
      if (r) r.enabled = false;
    }, ctx);
    return true;
  }

  return { Routines, Tick, createRoutine, listRoutines, cancelRoutine };
}

const defaults = createRoutines();
export const Routines = defaults.Routines;
export const createRoutine = defaults.createRoutine;
export const listRoutines = defaults.listRoutines;
export const cancelRoutine = defaults.cancelRoutine;
