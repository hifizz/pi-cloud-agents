// Loop run queue (Issue14 Phase1): global FIFO over the control store, maxConcurrent slots.
// Persistence is the truth: loop_runs rows carry status; this module only transitions them and drives the injected
// runner for the runs it dequeues. Restart behavior: rows survive the process; restore() reconciles them once at boot.
import { LOOP_RUN_ACTIVE } from "../control/db.mjs";

const TERMINAL = new Set(["succeeded", "failed", "canceled", "skipped"]);

/**
 * @param {object} opts
 * @param {object} opts.store control store (loops, loopRuns)
 * @param {(run: object) => Promise<void>} opts.runOne execute one dequeued run; must resolve/reject — the queue
 *   marks the outcome itself unless runOne already ended the run (terminal check inside finish()).
 * @param {(run: object) => Promise<void>} [opts.abortRun] best-effort abort of a starting/running run's session
 * @param {(run: object) => Promise<boolean>} [opts.isRunSessionLive] restart probe: does this run's Session still
 *   execute? Return false to mark the run failed(interrupted).
 * @param {(run: object) => Promise<void>} [opts.resumeRun] adopted live run after a restart: reacquires its session's
 *   in-flight submission and settles with it (resolve = succeeded, reject = failed). When absent, a live restored run
 *   keeps its slot but its completion is never observed (slot leak) — only for tests that finish() it by hand.
 * @param {number} [opts.maxConcurrent] default 3
 * @param {() => number} [opts.now]
 * @param {(msg: string) => void} [opts.log]
 */
export function createLoopQueue({ store, runOne, abortRun, isRunSessionLive, resumeRun, maxConcurrent = 3, now = Date.now, log = console.error }) {
  if (typeof runOne !== "function") throw new TypeError("createLoopQueue requires runOne");
  let limit = maxConcurrent;
  let pumping = false;
  const inflight = new Map(); // runId -> Promise (starting/running in this process)
  const cancelRequested = new Set(); // runIds the user canceled; finish() maps their outcome to canceled

  /** Dequeue waiting runs into free slots. Re-entrant safe; never throws out of a trigger path. */
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const occupying = store.loopRuns.countOccupying();
        if (occupying >= limit) return;
        const next = store.loopRuns.nextQueued();
        if (!next) return;
        // A disabled loop's run skips at dequeue time (enqueue-time check races with a later disable).
        const loop = next.loopId ? store.loops.get(next.loopId) : undefined;
        if (loop && !loop.enabled) {
          store.loopRuns.update(next.id, { status: "skipped", error: "loop disabled", endedAt: new Date(now()).toISOString() });
          continue;
        }
        store.loopRuns.update(next.id, { status: "starting" });
        const p = Promise.resolve()
          .then(() => runOne(next))
          .then(
            () => finish(next.id, { status: "succeeded" }),
            (e) => finish(next.id, { status: "failed", error: brief(e) }),
          )
          .finally(() => inflight.delete(next.id));
        inflight.set(next.id, p);
        p.catch(() => {}); // settle inside finish; never an unhandled rejection
      }
    } finally {
      pumping = false;
    }
  }

  const brief = (e) => String(e?.message ?? e ?? "").replace(/\s+/g, " ").slice(0, 500);

  /**
   * Mark a run ended and free its slot. Only a non-terminal run may transition; when runOne already ended it
   * (e.g. marked failed itself), the terminal check makes this a no-op. `outcome.status` is succeeded|failed|canceled.
   */
  function finish(runId, { status, error, usage, botId, branch, prNumber } = {}) {
    const run = store.loopRuns.get(runId);
    if (!run || TERMINAL.has(run.status)) {
      if (run && TERMINAL.has(run.status)) pump();
      return run;
    }
    // A user-canceled run keeps its own outcome: an in-flight settle after the abort never upgrades it to succeeded.
    const effective = cancelRequested.has(runId) ? "canceled" : status;
    cancelRequested.delete(runId);
    const patch = { status: effective, endedAt: new Date(now()).toISOString() };
    if (error !== undefined) patch.error = error;
    if (usage !== undefined) patch.usage = usage;
    if (botId !== undefined) patch.botId = botId;
    if (branch !== undefined) patch.branch = branch;
    if (prNumber !== undefined) patch.prNumber = prNumber;
    const out = store.loopRuns.update(runId, patch);
    pump();
    return out;
  }

  return {
    /**
     * Enqueue a run for a loop. Returns {run, created, skipped}.
     * - disabled loop → skipped: manual/webhook callers decide to record or not; `record:true` writes a skipped row.
     * - duplicate (loop_id, trigger_key) → the original run with created:false (idempotent retry).
     */
    enqueue({ loop, triggerKind, triggerKey, payload, entityRef, record = true } = {}) {
      if (!loop) throw new Error("enqueue requires the loop record");
      if (!loop.enabled) {
        if (!record) return { run: undefined, created: false, skipped: true };
        const { run } = store.loopRuns.enqueue({
          loopId: loop.id,
          loopVersion: loop.version,
          workspaceId: loop.workspaceId,
          triggerKind,
          triggerKey,
          payload,
          entityRef,
          status: "skipped",
        });
        if (run.status !== "skipped") store.loopRuns.update(run.id, { status: "skipped", error: "loop disabled", endedAt: new Date(now()).toISOString() });
        return { run: store.loopRuns.get(run.id), created: false, skipped: true };
      }
      const { run, created } = store.loopRuns.enqueue({
        loopId: loop.id,
        loopVersion: loop.version,
        workspaceId: loop.workspaceId,
        triggerKind,
        triggerKey,
        // Snapshot the loop's capabilities into the run payload at enqueue: the scoped tools and runner read
        // THIS copy, so a later loop edit can never widen the permissions of an already-queued/running run.
        payload: { ...(payload ?? {}), capabilities: loop.capabilities, repo: payload?.repo ?? undefined },
        entityRef,
      });
      if (created) pump();
      return { run, created, skipped: false };
    },

    pump,
    finish,

    /** Cancel a queued or active run. Queued: marked, never started.
     *  Active: abort the session FIRST and give the in-flight runOne a bounded grace to settle — the slot is only
     *  released after the abort was actually awaited/confirmed (or the grace elapsed, which is then recorded
     *  honestly in the run's error as abort-unconfirmed). Never just bookkeeping: the concurrency slot tracks real work. */
    async cancel(runId, { abortGraceMs = 10_000 } = {}) {
      const run = store.loopRuns.get(runId);
      if (!run) return undefined;
      if (TERMINAL.has(run.status)) return run;
      if (run.status === "queued") {
        store.loopRuns.update(run.id, { status: "canceled", error: "canceled by user", endedAt: new Date(now()).toISOString() });
        pump();
        return store.loopRuns.get(runId);
      }
      let aborted = true;
      cancelRequested.add(runId);
      if (abortRun) {
        try {
          await abortRun(run);
        } catch (e) {
          aborted = false;
          log?.(`loops: abortRun ${runId} failed: ${brief(e)}`);
        }
      }
      // Confirm the in-flight execution actually winds down before the slot is freed (bounded: a hung runOne
      // cannot hold the queue forever). The slot stays occupied (status untouched) until this wait resolves.
      const inflightRun = inflight.get(runId);
      if (inflightRun) {
        await Promise.race([
          inflightRun.catch(() => {}),
          new Promise((r) => setTimeout(r, abortGraceMs)),
        ]);
      }
      const after = store.loopRuns.get(runId);
      if (TERMINAL.has(after.status)) {
        pump();
        return after;
      }
      store.loopRuns.update(run.id, {
        status: "canceled",
        error: aborted ? "canceled by user" : "canceled by user (session abort unconfirmed)",
        endedAt: new Date(now()).toISOString(),
      });
      pump();
      return store.loopRuns.get(runId);
    },

    /**
     * Boot reconciliation. queued rows keep their order; starting/running/needs_approval rows keep their slot only
     * when `isRunSessionLive` says the Session is still executing (pi-durable resumed it), else failed(interrupted).
     * Never re-runs runOne, never re-creates a Bot or worktree. A live run is adopted: `resumeRun` reacquires its
     * submission and its settle drives finish() — the slot is released when the run actually completes.
     */
    async restore() {
      const occupying = store.loopRuns.listOccupying();
      for (const run of occupying) {
        let live = false;
        try {
          live = isRunSessionLive ? await isRunSessionLive(run) : false;
        } catch (e) {
          live = false;
          log?.(`loops: restore probe ${run.id} failed: ${brief(e)}`);
        }
        if (!live) {
          try {
            store.loopRuns.update(run.id, { status: "failed", error: "interrupted: server restarted before the session resumed", endedAt: new Date(now()).toISOString() });
          } catch (e) {
            // Already terminal (e.g. a concurrent cancel): leave the terminal outcome alone.
            log?.(`loops: restore mark-interrupted ${run.id} skipped: ${brief(e)}`);
          }
          continue;
        }
        // Adopt: the run's session is alive under the resumed harness. resumeRun settles when its submission does;
        // the slot frees through finish() exactly once.
        if (resumeRun) {
          const p = Promise.resolve()
            .then(() => resumeRun(run))
            .then(
              () => finish(run.id, { status: "succeeded" }),
              (e) => finish(run.id, { status: "failed", error: brief(e) }),
            )
            .finally(() => inflight.delete(run.id));
          inflight.set(run.id, p);
          p.catch(() => {});
        }
      }
      pump();
    },

    /** Queue view: running (slot holders) and queued with 1-based FIFO positions. */
    view() {
      const occupying = store.loopRuns.listOccupying();
      const queued = store.loopRuns.listQueued();
      return {
        maxConcurrent: limit,
        running: occupying.map((r) => ({ ...r, position: 0 })),
        queued: queued.map((r, i) => ({ ...r, position: i + 1 })),
      };
    },

    setMaxConcurrent(n) {
      if (!Number.isInteger(n) || n < 1) throw new Error("maxConcurrent must be an integer >= 1");
      limit = n;
      pump();
    },
    get maxConcurrent() {
      return limit;
    },
    /** A cancel() was requested for this run; an in-flight runOne checks this at each side-effect point. */
    isCanceled(runId) {
      return cancelRequested.has(runId);
    },
    /** Test seam: settle the runOne calls in flight right now. Queued work that has not started is not awaited. */
    async idle() {
      const current = [...inflight.values()];
      if (current.length) await Promise.allSettled(current);
    },
    _activeStatuses: LOOP_RUN_ACTIVE,
  };
}
