// Loops bundle (Issue14 Phase1): store + queue + runner + scheduler, wired once by server.mjs.
// Everything is injectable so tests can compose the same pieces over an in-memory store, a fake Bot registry,
// a fake runtimeBash and a faux harness clock.
import { createLoopStore } from "./store.mjs";
import { createLoopQueue } from "./queue.mjs";
import { createLoopRunner } from "./runner.mjs";
import { createLoopSched, createLoopScheduler } from "./sched.mjs";
import { scheduleTriggerKey } from "./schedule.mjs";
import { ingestGithubEvent } from "./github-events.mjs";
import { createGithubPoller } from "./github-poller.mjs";
import { bindLoopGithubTools } from "./tools.mjs";


// The scheduler + github-poller extensions are created once (task definitions must be the same object the
// registry holds).
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

  // ---- Phase 2: GitHub ingestion (webhook + poll share one canonical ingest path) ----
  const ingest = async (workspaceId, ev) =>
    ingestGithubEvent({
      store,
      github,
      enqueue: (loopId, triggerKey, { ev: e, loop } = {}) =>
        queue.enqueue({
          loop: loop ?? store.loops.get(loopId),
          triggerKind: loop?.trigger?.kind ?? "github_issue",
          triggerKey,
          payload: {
            github: {
              kind: e.kind, action: e.action, state: e.state ?? null,
              actor: e.actor ?? null, at: e.at ?? null, supplemented: e.supplemented === true,
            },
            entity: e.entity ?? null,
            repo: e.repo ?? null,
          },
          entityRef: e.entity ? `${e.entity.kind}:${e.entity.number}` : undefined,
        }),
      ev,
    });

  /** Workspaces that currently own an enabled github_* loop, for the poller's target set. */
  const ghLoopsByWorkspace = () => {
    const map = new Map();
    for (const loop of store.loops.listEnabledGithub()) {
      const ws = store.workspaces.get(loop.workspaceId);
      if (!ws?.repo) continue;
      const e = map.get(loop.workspaceId) ?? { ws, loops: [] };
      e.loops.push(loop);
      map.set(loop.workspaceId, e);
    }
    return map;
  };

  const githubPoller = harness
    ? createGithubPoller({
        ingest,
        github,
        control: store,
        ghLoopsByWorkspace,
        harness,
        pollSec: opts.githubPollSec,
        now,
      })
    : undefined;

  // Scoped GitHub write tools for loop sessions — added per-run when capabilities.github has switches on.
  // Scoped GitHub write tools for loop sessions — the shared registry singleton, bound to this store/bots set.
  // Loop sessions add LoopGithubToolsExt via extensions.add only when capabilities.github has switches on.
  bindLoopGithubTools({
    loopRuns: store.loopRuns,
    loops: store.loops,
    github,
    runtimeBash,
    publicUrl: opts.publicUrl,
    botOfConversation: async (conversationId) => {
      const link = store.links.ofConversation?.(conversationId);
      const botId = link?.botId;
      return botId ? bots.get(botId) : undefined;
    },
    workspaceOf: (wsId) => store.workspaces.get(wsId),
    record: (runId, patch) => {
      const run = store.loopRuns.get(runId);
      if (!run) return;
      const payload = { ...(run.payload ?? {}) };
      if (patch.prNumber !== undefined) payload.pr = { number: patch.prNumber, url: patch.prUrl ?? null };
      if (patch.suggestedTask !== undefined) payload.suggestedTask = patch.suggestedTask;
      if (patch.commented !== undefined) payload.commented = patch.commented;
      if (patch.pushed !== undefined) payload.pushed = patch.pushed;
      store.loopRuns.update(runId, patch.prNumber !== undefined ? { payload, prNumber: patch.prNumber } : { payload });
      // Surface the produced artifact on the run's Session record — the compose panel/overview read the bot's
      // executionResult shape (summary/testsReportedByHuman/pull). testsReportedByHuman stays null: an
      // automated PR artifact is never presented as human-verified. A bots.update failure propagates — the
      // caller learns the artifact wasn't surfaced, it is never swallowed into a silent miss.
      if (patch.prNumber !== undefined && run.botId) {
        const issueMatch = /^issue:(\d+)$/.exec(run.entityRef ?? "");
        const issue = issueMatch ? Number(issueMatch[1]) : 0;
        bots.update(run.botId, { executionResult: {
          summary: `Loop run ${runId} opened PR #${patch.prNumber}`,
          testsReportedByHuman: null,
          pull: { number: patch.prNumber, title: `Loop PR #${patch.prNumber}`, url: patch.prUrl ?? "" },
          issue,
          sourceBotId: run.botId,
          reportedAt: new Date().toISOString(),
        } });
      }
    },
    // Self-feedback marker: a comment id produced by send_github_comment is marked so ingestion drops it.
    markProduced: (key) => store.githubDeliveries.mark(key, "tool"),
  });

  /**
   * Boot reconciliation: queued rows keep their order; in-flight rows keep a slot only when their Session is
   * still executing under pi-durable; then schedule ticks and the github poller are re-synced.
   */
  async function restore() {
    await queue.restore();
    if (scheduler) await scheduler.restore();
    if (githubPoller) await githubPoller.sync();
  }

  return { store: loopStore, queue, runner, scheduler, githubPoller, ingestGithub: ingest, restore, enqueueScheduled };
}
