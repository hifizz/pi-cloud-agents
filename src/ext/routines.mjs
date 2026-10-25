// Scheduled routines (F06): a routine is a durable BACKGROUND task that periodically submits a prompt to a Bot.
//
// How "wait until time T" works (pi-durable >= 1.4.0 durable sleeps):
//   - The task never waits inside a phase. It ends its phase ASLEEP: `runtime.sleepUntil(until, checkpoint, ctx)`, or
//     `{ status: "sleeping", until, checkpoint }` returned from `runtime.commit()` when the sleep must commit together with
//     other writes (the routine list update). A sleeping task holds no invocation; the deadline is stored, survives a
//     restart, and the Harness resumes the task at its checkpoint once the Harness clock (`HarnessOptions.now`) reaches
//     `until`. If `until` already passed when the Harness reopens, the task runs at once.
//   - Phase `tick` with checkpoint `{phase:"tick", nextAt}`: if the Harness clock is before `nextAt` the phase only goes
//     back to sleep until `nextAt` (also the path for records written by 1.0.x, which were stored mid-wait as running);
//     otherwise it fires once and sleeps until the next slot, in the same commit that updates the routine list.
//   - Catch-up: one firing per overdue slot series. After waking late we fire ONCE (for the saved `nextAt`), then compute
//     the next slot strictly after "now" on the original grid, so missed slots are never replayed in a burst.
//   - Exactly-once: the submission carries `requestId = routine:<id>:<nextAt>`. If a crash happens between submit and the
//     checkpoint commit, the rerun submits the same requestId and pi-durable returns the first submission.
//   - Abort semantics (REQ-F06-3): the task is `background: true`, so `conv.abort(ctx)` skips it;
//     `conv.abort(ctx, { background: true })` (or `cancelRoutine`) reaches it and the task's `abort` handler ends it.
//
// Clock injection: sleeps run on the Harness clock, so a fake clock goes to the Harness:
// `openHarness({ now, setTimer })`. `createRoutines({ now })` must get the same `now`; it only stamps `createdAt` and the
// first slot. (`setTimer` is still accepted by `createRoutines` for compatibility and ignored.)
//
// The routine list lives in a Session-scoped document (`tarsbot.routines`): routines span bots, so no single conversation
// should own the list. The document is updated inside the same commit as each checkpoint.
import { randomUUID } from "node:crypto";
import { defineDoc, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { ctx } from "../harness.mjs";

const RECENT_FIRES = 20;
/** Bot-created routine limits (idea 3): min interval and max routines per bot conversation. */
export const BOT_MIN_EVERY_MS = 5 * 60 * 1000;
export const BOT_MAX_ROUTINES = 50;
/** Failed tick retry delay (idea 11): re-fire the same slot once after this long. */
export const RETRY_DELAY_MS = 10 * 60 * 1000;

/** Session document: routine id -> public record (also what listRoutines returns). */
export const RoutinesDoc = defineDoc({
  kind: "tarsbot.routines",
  version: 1,
  scope: "session",
  initial: () => ({ routines: {} }),
  // Small document; keep ordinary changes as deltas (pi-durable >= 1.4.0 requires an explicit policy).
  checkpointWhen: () => false,
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Validate a watch spec ({command}); returns {command} or throws. The command runs in the shared sandbox. */
export function normalizeWatch(watch) {
  if (!watch || typeof watch !== "object") throw new Error("watch must be {command}");
  const command = String(watch.command ?? "").trim();
  if (!command) throw new Error("watch.command is required");
  if (command.length > 2000) throw new Error("watch.command too long (max 2000 chars)");
  return { command };
}

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

/**
 * Build a routines bundle. Use the default exports unless you need an injected clock.
 * @param {{ now?: () => number, setTimer?: unknown }} [opts] `now` must be the Harness clock (`openHarness({ now })`);
 *   `setTimer` is ignored (sleep timers belong to the Harness).
 */
export function createRoutines(opts = {}) {
  const clock = { now: opts.now ?? Date.now };

  const Tick = defineTask({
    name: "routine.tick",
    version: 1,
    initial: (input) => ({ phase: "tick", nextAt: input.firstAt }),
    phases: {
      tick: async (task, runtime, taskContext) => {
        const { id, botConversationId, prompt, everyMs, atTimes, watch } = task.input;
        const scheduled = task.state.checkpoint.nextAt;
        const retried = task.state.checkpoint.retried === true;
        // Not due yet: end the phase asleep until the saved slot (durable; resumes here at `scheduled`).
        if (runtime.now() < scheduled) {
          await runtime.sleepUntil(scheduled, { phase: "tick", nextAt: scheduled, ...(retried ? { retried: true } : {}) }, taskContext);
          return;
        }

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

        // Watch mode (idea 10): compute a fingerprint WITHOUT calling the model; skip this slot when unchanged.
        // The sandbox call runs OUTSIDE any commit (a commit callback must not hold the mutation line over I/O);
        // the compare-and-record is then one short commit.
        if (watch && !retried) {
          let hash = "error";
          try {
            const { loadSandbox } = await import("../sandbox/index.mjs");
            const { bash } = await loadSandbox();
            const r = await bash(`( ${watch.command} ) 2>&1 | sha256sum | cut -d' ' -f1`, { timeoutMs: 60_000 });
            if (r.exitCode === 0) hash = String(r.stdout ?? "").trim();
          } catch {
            hash = "error";
          }
          const lastHash = current?.watchHash;
          const unchanged = hash === lastHash && hash !== "error";
          if (unchanged) {
            const nextAt = computeNext({ everyMs, atTimes }, scheduled, runtime.now());
            await runtime.commit(async (tx) => {
              const doc = await tx.doc(RoutinesDoc);
              const rec = doc.routines[id];
              if (rec) {
                rec.watchHash = hash;
                rec.lastWatchAt = runtime.now();
                rec.watchSkips = (rec.watchSkips ?? 0) + 1;
                rec.recent.push({ at: scheduled, status: "skipped", durationMs: 0 });
                while (rec.recent.length > RECENT_FIRES) rec.recent.shift();
                rec.nextAt = nextAt;
              }
              return { status: "sleeping", until: nextAt, checkpoint: { phase: "tick", nextAt } };
            }, taskContext);
            return;
          }
          // Changed (or the fingerprint failed): remember the hash with this firing.
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(RoutinesDoc);
            const rec = doc.routines[id];
            if (rec) {
              rec.watchHash = hash;
              rec.lastWatchAt = runtime.now();
            }
          }, taskContext);
        }

        const requestId = `routine:${id}:${scheduled}`;
        const startedAt = runtime.now();
        let submission;
        try {
          submission = await conv.submit({ type: "input", content: prompt, whenBusy: "followUp", requestId }, taskContext);
        } catch (e) {
          // Retry discipline (idea 11): one retry after RETRY_DELAY_MS, then record the failure and move on.
          if (!retried) {
            await runtime.commit(() => ({
              status: "sleeping",
              until: runtime.now() + RETRY_DELAY_MS,
              checkpoint: { phase: "tick", nextAt: scheduled, retried: true },
            }), taskContext);
            return;
          }
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(RoutinesDoc);
            const rec = doc.routines[id];
            if (rec) rec.recent.push({ at: scheduled, status: "error", error: String(e?.message ?? e).slice(0, 300), durationMs: runtime.now() - startedAt });
            return { status: "sleeping", until: computeNext({ everyMs, atTimes }, scheduled, runtime.now()), checkpoint: { phase: "tick", nextAt: computeNext({ everyMs, atTimes }, scheduled, runtime.now()) } };
          }, taskContext);
          return;
        }
        const settled = await submission.wait(taskContext);

        const nextAt = computeNext({ everyMs, atTimes }, scheduled, runtime.now());
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(RoutinesDoc);
          const rec = doc.routines[id];
          if (rec) {
            rec.nextAt = nextAt;
            rec.lastFiredAt = scheduled;
            rec.lastSubmissionId = submission.id;
            rec.fireCount = (rec.fireCount ?? 0) + 1;
            // Run record (idea 11): status + duration + error instead of bare timestamps. Old records stay readable.
            rec.recent.push({ at: scheduled, status: settled.status === "done" ? "done" : "error", durationMs: runtime.now() - startedAt, ...(settled.status !== "done" ? { error: "unanswered" } : {}) });
            while (rec.recent.length > RECENT_FIRES) rec.recent.shift();
          }
          // Sleep until the next slot in the same commit as the list update.
          return { status: "sleeping", until: nextAt, checkpoint: { phase: "tick", nextAt } };
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
   * Create a routine for a Bot conversation. Exactly one of everyMs / atTimes. Optional `watch` (idea 10): run a
   * sandbox command first and fire only when its output hash changed since the last firing.
   * @param {any} harness
   * @param {{ botConversationId: number, prompt: string, everyMs?: number, atTimes?: string[], watch?: {command: string} }} spec
   */
  async function createRoutine(harness, spec) {
    const { botConversationId, prompt } = spec ?? {};
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt is required");
    const hasEvery = spec.everyMs !== undefined && spec.everyMs !== null;
    const hasAt = spec.atTimes !== undefined && spec.atTimes !== null;
    if (hasEvery === hasAt) throw new Error("exactly one of everyMs or atTimes is required");
    if (hasEvery && !(Number.isFinite(spec.everyMs) && spec.everyMs >= 1)) throw new Error("everyMs must be a positive number");
    const watch = spec.watch ? normalizeWatch(spec.watch) : undefined;
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
      ...(watch ? { watch } : {}),
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
        ...(watch ? { watch } : {}),
        enabled: true,
        createdAt,
        nextAt: firstAt,
        fireCount: 0,
        recent: [],
      };
      return taskId;
    }, ctx);
    return { id, taskId, botConversationId, prompt, nextAt: firstAt, enabled: true, ...(atTimes ? { atTimes } : { everyMs: input.everyMs }), ...(watch ? { watch } : {}) };
  }

  /** All routines, each with the live task status ("pending"|"running"|"sleeping"|...|"terminal:<outcome>"). */
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

  // ---- bot-facing routine tools (idea 3) ----------------------------------------------------------------------------
  // The tools close over a late-bound harness: runtime.mjs calls createRoutineTools({harness, resolveBot}) once the
  // harness exists; the extension instance created here is only a placeholder (see createRoutineTools below).

  return { Routines, Tick, createRoutine, listRoutines, cancelRoutine, RoutineTools: null };
}

const defaults = createRoutines();
export const Routines = defaults.Routines;
export const createRoutine = defaults.createRoutine;
export const listRoutines = defaults.listRoutines;
export const cancelRoutine = defaults.cancelRoutine;

// ---- bot-facing routine tools (idea 3) ----------------------------------------------------------------------------
// schedule_routine / update_routine / list_routines / cancel_routine, mirroring the HTTP API but callable by the
// model, with the bot-routine limits (interval >= BOT_MIN_EVERY_MS, <= BOT_MAX_ROUTINES per bot).
// Built AFTER the harness exists (runtime.mjs): the tools need it to reach the RoutinesDoc and create tasks.
/**
 * @param {{ harness: any, now?: () => number, minEveryMs?: number, maxRoutines?: number }} io
 */
export function createRoutineTools(io) {
  if (!io?.harness) throw new Error("createRoutineTools requires {harness}");
  const minEveryMs = io.minEveryMs ?? BOT_MIN_EVERY_MS;
  const maxRoutines = io.maxRoutines ?? BOT_MAX_ROUTINES;
  const { createRoutine: create, listRoutines: list, cancelRoutine: cancel } = createRoutines({ now: io.now });

  const countFor = async (botConversationId) => {
    const doc = await io.harness.snapshot(RoutinesDoc, ctx);
    return Object.values(doc?.routines ?? {}).filter((r) => r.botConversationId === botConversationId && r.enabled !== false).length;
  };

  const scheduleRoutine = defineTool({
    name: "schedule_routine",
    description:
      `Schedule yourself a recurring routine: a prompt run in your conversation on a schedule (like "every weekday at 8am tell me what needs my attention"). ` +
      `Limits: interval >= ${Math.round(minEveryMs / 60000)} minutes, max ${maxRoutines} routines. ` +
      "Optional watch: a sandbox command whose output hash must change for the routine to fire (only-when-changed).",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to run at each firing" }),
      everyMinutes: Type.Optional(Type.Number({ minimum: 1, description: "Fire every N minutes" })),
      atTimes: Type.Optional(Type.Array(Type.String(), { description: 'Daily local times "HH:MM"' })),
      name: Type.Optional(Type.String({ description: "Short label for the UI" })),
      watchCommand: Type.Optional(Type.String({ description: "Sandbox command; fire only when its output changes" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      let botConversationId = api.conversationId;
      let spec;
      if (args.everyMinutes !== undefined) {
        const everyMs = Math.round(args.everyMinutes * 60_000);
        if (everyMs < minEveryMs) throw new Error(`everyMinutes must be >= ${Math.round(minEveryMs / 60000)} (got ${args.everyMinutes})`);
        spec = { everyMs };
      } else if (Array.isArray(args.atTimes) && args.atTimes.length > 0) {
        spec = { atTimes: args.atTimes };
      } else {
        throw new Error("exactly one of everyMinutes or atTimes is required");
      }
      if ((await countFor(botConversationId)) >= maxRoutines) throw new Error(`this bot already has ${maxRoutines} active routines; cancel one first`);
      const created = await create(io.harness, {
        botConversationId,
        prompt: args.prompt,
        ...spec,
        ...(args.watchCommand ? { watch: { command: args.watchCommand } } : {}),
        ...(args.name ? { name: args.name } : {}),
      });
      return {
        output: [
          {
            type: "text",
            text: `routine ${created.id} scheduled${args.name ? ` (${args.name})` : ""}: next fire at ${new Date(created.nextAt).toISOString()}`,
          },
        ],
      };
    },
  });

  const listRoutinesTool = defineTool({
    name: "list_routines",
    description: "List your scheduled routines with next fire time and recent run outcomes.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      const all = await list(io.harness);
      const mine = all.filter((r) => r.botConversationId === api.conversationId);
      if (mine.length === 0) return { output: [{ type: "text", text: "no routines scheduled" }] };
      const text = mine
        .map((r) => {
          const sched = r.atTimes ? `at ${r.atTimes.join(", ")}` : `every ${Math.round((r.everyMs ?? 0) / 60000)}min`;
          const runs = (r.recent ?? []).slice(-3).map((x) => (typeof x === "object" ? x.status : "fired")).join(",");
          return `- ${r.id} [${r.enabled ? "on" : "off"}] ${sched} next=${r.nextAt ? new Date(r.nextAt).toISOString() : "?"} runs(${runs || "none"}): ${r.prompt.slice(0, 120)}`;
        })
        .join("\n");
      return { output: [{ type: "text", text }] };
    },
  });

  const cancelRoutineTool = defineTool({
    name: "cancel_routine",
    description: "Cancel one of your scheduled routines for good.",
    parameters: Type.Object({ id: Type.String({ description: "Routine id from list_routines" }) }),
    replay: "unsafe",
    async execute(args) {
      const ok = await cancel(io.harness, args.id);
      if (!ok) return { output: [{ type: "text", text: `no such routine: ${args.id}` }], isError: true };
      return { output: [{ type: "text", text: `routine ${args.id} cancelled` }] };
    },
  });

  const updateRoutineTool = defineTool({
    name: "update_routine",
    description: "Change a routine's prompt, schedule or watch command. Unchanged fields keep their current value.",
    parameters: Type.Object({
      id: Type.String({ description: "Routine id" }),
      prompt: Type.Optional(Type.String({ description: "New prompt" })),
      everyMinutes: Type.Optional(Type.Number({ minimum: 1, description: "New interval in minutes" })),
      atTimes: Type.Optional(Type.Array(Type.String(), { description: 'New daily local times "HH:MM"' })),
      watchCommand: Type.Optional(Type.String({ description: "New watch command (empty string clears it)" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      const all = await list(io.harness);
      const rec = all.find((r) => r.id === args.id && r.botConversationId === api.conversationId);
      if (!rec) return { output: [{ type: "text", text: `no such routine of yours: ${args.id}` }], isError: true };
      await cancel(io.harness, args.id);
      const spec = {
        botConversationId: rec.botConversationId,
        prompt: args.prompt ?? rec.prompt,
        ...(args.everyMinutes !== undefined ? { everyMs: Math.round(args.everyMinutes * 60_000) } : args.atTimes !== undefined ? { atTimes: args.atTimes } : rec.atTimes ? { atTimes: rec.atTimes } : { everyMs: rec.everyMs }),
        ...(args.watchCommand !== undefined ? (args.watchCommand ? { watch: { command: args.watchCommand } } : {}) : rec.watch ? { watch: rec.watch } : {}),
      };
      const created = await create(io.harness, spec);
      return { output: [{ type: "text", text: `routine ${args.id} replaced by ${created.id} (next ${new Date(created.nextAt).toISOString()})` }] };
    },
  });

  return defineExtension({
    name: "tarsbot.routineTools",
    tools: [scheduleRoutine, listRoutinesTool, cancelRoutineTool, updateRoutineTool],
  });
}
