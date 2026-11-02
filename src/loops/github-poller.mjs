// GitHub polling (Issue14 Phase2) — a durable background task per workspace that polls the repo events feed
// and (for loops subscribed to checks_*) the Checks API, feeding every entry through the same canonical
// ingest path the webhook uses. One task per workspace with github loops; interval TARSBOT_LOOPS_GH_POLL_SEC
// (default 300s). The github_event_cursor row persists the newest seen feed id so a restart resumes where it
// left off instead of re-scanning the whole feed; events already delivered via webhook are still dropped by
// the shared canonical-key dedup (github_deliveries + UNIQUE(loop_id,trigger_key)).
//
// The repo events API is NOT a complete feed (per Issue14 + Issue13's read-only reference): check-suite
// results and some per-review states are absent, so the poller supplements them via the Checks API for open
// PRs on subscribed loops. Supplemented events are marked `supplemented: true` in the run payload — a missing
// window is explicit, never silently absent.
import { defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { ctx } from "../harness.mjs";
import { normalizePollEvent } from "./github-events.mjs";

export const LoopGhPollDoc = defineDoc({
  kind: "tarsbot.loops.ghpoll",
  version: 1,
  scope: "session",
  initial: () => ({ tasks: {} }),
  checkpointWhen: () => false,
});

export const DEFAULT_POLL_SEC = 300;
const META_KEY = "loops.ghpoll.carrierConversationId";

// Late-bound deps — the Extension object must exist at harness-open time (registry), while the actual poll
// wiring (github client, ingest fn, store) is created by createLoops after the store exists. Same pattern as
// loopSched's defaultEnqueue.
let bound;
/** createLoops calls this once; the Poll task + sync/pollOnce resolve deps through it. */
export function bindGithubPoller(deps) {
  bound = deps;
}
const D = () => {
  if (!bound) throw new Error("github poller is not bound (createLoops not wired)");
  return bound;
};

/**
 * One poll tick: feed scan + checks supplement. Shared by the durable task and sync callers (pollOnce).
 * @param {object} deps {ingest, github, control, ghLoopsByWorkspace, now}
 */
async function pollOnceWith(deps, workspaceId, repo) {
  const now = deps.now ?? Date.now;
  let lastSeenId = deps.control.githubCursor.get(workspaceId)?.lastEventId ?? null;
  const events = await deps.github.listEvents(repo, { limit: 300 });
  const sorted = [...events].sort((a, b) => (BigInt(a.id || 0) < BigInt(b.id || 0) ? -1 : 1));
  let ingested = 0;
  for (const raw of sorted) {
    const ev = normalizePollEvent({ ...raw, repo });
    if (!ev) continue;
    if (lastSeenId && ev.pollId && BigInt(ev.pollId) <= BigInt(lastSeenId)) continue;
    const r = await deps.ingest(workspaceId, ev);
    if (r?.ingested) ingested += 1;
    if (ev.pollId && (!lastSeenId || BigInt(ev.pollId) > BigInt(lastSeenId))) lastSeenId = ev.pollId;
  }
  if (lastSeenId) deps.control.githubCursor.set(workspaceId, String(lastSeenId));

  // Checks supplement: the feed never carries check-suite results. For loops subscribed to checks_*, poll
  // the head SHA of every open PR and feed the aggregate state as a check_suite-shaped event.
  const entry = deps.ghLoopsByWorkspace()?.get(workspaceId);
  if (entry?.loops?.some((l) => (l.trigger?.events ?? []).some((e) => e === "checks_failed" || e === "checks_passed"))) {
    const prs = await deps.github.listPulls(repo, { limit: 20 }).catch(() => []);
    for (const pr of prs) {
      const headSha = pr.headSha ?? pr.head?.sha ?? null;
      if (!headSha) continue;
      const checks = await deps.github.getCheckRuns(repo, headSha).catch(() => null);
      if (!checks?.state || checks.state === "none" || checks.state === "pending") continue;
      await deps.ingest(workspaceId, {
        kind: "check_suite", action: "completed", state: checks.state,
        entity: { kind: "pr", number: pr.number, url: pr.url ?? null, title: pr.title ?? "" },
        headSha,
        actor: null, at: new Date(now()).toISOString(), repo, isPr: true, supplemented: true,
        pollId: `checks:${pr.number}:${String(headSha).slice(0, 12)}:${checks.state}`,
      });
    }
  }
  return { ingested, lastSeenId };
}

const Poll = defineTask({
  name: "loops.github.poll",
  version: 1,
  initial: (input) => ({ phase: "poll", nextAt: input.firstAt }),
  phases: {
    poll: async (task, runtime, taskContext) => {
      const { workspaceId, repo } = task.input;
      const scheduled = task.state.checkpoint.nextAt;
      if (runtime.now() < scheduled) {
        await runtime.sleepUntil(scheduled, { phase: "poll", nextAt: scheduled }, taskContext);
        return;
      }
      const rec = (await runtime.snapshot(LoopGhPollDoc, taskContext))?.tasks?.[workspaceId];
      if (!rec) {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { polled: 0 } } }), taskContext);
        return;
      }
      const deps = D();
      const pollSec = Math.max(30, Number(deps.pollSec ?? DEFAULT_POLL_SEC));
      try {
        await pollOnceWith(deps, workspaceId, repo);
      } catch (e) {
        console.error(`loops.github.poll: ${workspaceId} failed: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      const nextAt = runtime.now() + pollSec * 1000;
      // Same contract as the schedule task: ONE commit that both updates the doc and returns the sleeping
      // transition — no separate sleepUntil after a checkpoint-shaped return (that was the SessionFailed
      // source: {phase,nextAt} is a checkpoint, not a status; the task then slept in a second commit).
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(LoopGhPollDoc);
        const r = doc.tasks[workspaceId];
        if (r) r.nextAt = nextAt;
        return { status: "sleeping", until: nextAt, checkpoint: { phase: "poll", nextAt } };
      }, taskContext);
    },
  },
});

/** The extension object — installed in the registry once, independent of the bound deps. */
export const LoopGithubPollExt = defineExtension({ name: "tarsbot.loops.ghpoll", tasks: [Poll], docs: [LoopGhPollDoc] });

/**
 * @param {{ ingest: (workspaceId: string, ev: object) => any, github: object, control: object,
 *   ghLoopsByWorkspace: () => Map<string, {ws:object, loops:object[]}>, harness: object, pollSec?: number,
 *   now?: () => number }} deps
 * @returns {{ sync: () => Promise<void>, pollOnce: (workspaceId: string, repo: string) => Promise<object> }}
 */
export function createGithubPoller(deps) {
  bindGithubPoller(deps);
  const { control, harness } = deps;
  const now = deps.now ?? Date.now;

  async function carrier() {
    const id = control.meta.get(META_KEY);
    if (id !== undefined) {
      const conv = await harness.conversation(id, ctx);
      if (conv) return conv;
    }
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    control.meta.ensure(META_KEY, () => conv.id);
    return conv;
  }

  return {
    pollOnce: (workspaceId, repo) => pollOnceWith(deps, workspaceId, repo),

    /** Ensure a poll task exists for every workspace with enabled github loops; stop the rest. */
    async sync() {
      const want = deps.ghLoopsByWorkspace();
      const doc = await harness.snapshot(LoopGhPollDoc, ctx);
      const live = doc?.tasks ?? {};
      for (const [workspaceId, { ws }] of want) {
        if (live[workspaceId]) continue;
        const repo = ws.repo ?? null;
        if (!repo) continue;
        const conv = await carrier();
        const firstAt = now();
        await conv.commit(async (tx) => {
          const taskId = await tx.createTask(Poll, { workspaceId, repo, firstAt }, { ownership: { kind: "conversation" }, background: true });
          const d = await tx.doc(LoopGhPollDoc);
          d.tasks[workspaceId] = { taskId, repo, nextAt: firstAt };
          return taskId;
        }, ctx);
      }
      for (const workspaceId of Object.keys(live)) {
        if (!want.has(workspaceId)) {
          const conv = await carrier();
          await conv.commit(async (tx) => {
            const d = await tx.doc(LoopGhPollDoc);
            const rec = d.tasks[workspaceId];
            if (!rec) return undefined;
            delete d.tasks[workspaceId];
            const t = await tx.task(rec.taskId);
            if (t && t.status === "live") await t.abort();
            return undefined;
          }, ctx);
        }
      }
    },
  };
}
