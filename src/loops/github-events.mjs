// GitHub event ingestion + matching for Loops (Issue14 Phase2).
//
// Two inbound channels share ONE canonical event shape and ONE dedup layer:
//   webhook  POST /api/github/webhook (HMAC machine auth) -> normalizeWebhookEvent -> ingest
//   poll     durable loops.github.poll task -> github.listEvents -> normalizePollEvent -> ingest
//
// Dedup is layered (Issue13 review note): `github_deliveries` marks an event ingested ONCE globally per
// canonical key — one event always fans out to EVERY matching enabled loop in a single ingest call, so a
// second loop is never swallowed by the global mark. Per-destination dedup is loop_runs'
// UNIQUE(loop_id, trigger_key) where trigger_key = "gh:" + canonicalKey.
//
// Canonical keys identify the EVENT (what happened), not just the entity:
//   gh:issue.opened:<n>          gh:issue.labeled:<n>:<label>
//   gh:issue.comment:<commentId> gh:pr.opened:<n>  gh:pr.merged:<n>
//   gh:pr.checks:<n>:<headSha>:<state>  gh:pr.review:<n>:<reviewId>:<state>
// Poll-generated fallback keys use the raw feed entry id when a stable business key doesn't exist:
//   gh:poll:<eventId>
//
// "Starts matching" semantics: loop_match_state remembers (loop, entity) matched=true/false across events;
// an event triggers a run only when the loop was NOT matched for that entity before — condition-loop style.
// Plain events (one-shot, e.g. opened/merged) don't use match state: each is its own trigger.
import { randomUUID } from "node:crypto";

/** GitHub webhook event name -> normalized kind. Webhook names differ from the repo-events feed names. */
const WEBHOOK_KIND = {
  issues: "issue",
  issue_comment: "comment",
  pull_request: "pr",
  pull_request_review: "review",
  pull_request_review_comment: "review_comment",
  check_suite: "check_suite",
  check_run: "check_run",
  label: "label",
  ping: "ping",
};

/** One bot-actor guard: comments authored by this actor never trigger loops (self-loop prevention). */
export const BOT_ACTOR_SUFFIX = "[bot]";

const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Entity ref used in match state + run payload: "issue:12" | "pr:34". */
const entityRefOf = (ev) =>
  ev?.entity?.kind && ev.entity.number ? `${ev.entity.kind}:${ev.entity.number}` : null;

/**
 * Normalize a GitHub webhook delivery into the canonical loop event.
 * @param {string} name X-GitHub-Event header (e.g. "issues", "pull_request", "check_suite")
 * @param {object} payload decoded JSON body
 * @returns {null | {kind, action, event, entity:{kind,number,url,title}, key, repo, actor, at, isPr, labels?, state?, headSha?, body?, delivery}}
 */
export function normalizeWebhookEvent(name, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const kind = WEBHOOK_KIND[name];
  const actor = p.sender?.login ?? null;
  const at = new Date().toISOString(); // webhook bodies don't carry a reliable event time; receive-time is fine for ordering
  const repo = p.repository?.full_name ?? null;
  const delivery = undefined; // delivery id is handled by the route layer (replay dedup), not the event key
  switch (name) {
    case "issues": {
      const issue = p.issue ?? {};
      const action = p.action ?? "";
      return {
        kind, event: name, action,
        entity: { kind: "issue", number: toInt(issue.number), url: issue.html_url ?? null, title: issue.title ?? "" },
        labels: (issue.labels ?? []).map((l) => l.name ?? l),
        label: p.label?.name ?? null,
        entityUpdatedAt: issue.updated_at ?? null,
        actor, at, repo, delivery, isPr: false,
      };
    }
    case "issue_comment": {
      if (p.action !== "created" && p.action !== "edited") return null;
      const issue = p.issue ?? {};
      const isPr = Boolean(issue.pull_request);
      return {
        kind, event: name, action: p.action,
        entity: { kind: isPr ? "pr" : "issue", number: toInt(issue.number), url: p.comment?.html_url ?? issue.html_url ?? null, title: issue.title ?? "" },
        commentId: p.comment?.id ?? null,
        body: p.comment?.body ?? "",
        labels: (issue.labels ?? []).map((l) => l.name ?? l),
        entityUpdatedAt: issue.updated_at ?? null,
        actor, at, repo, delivery, isPr,
      };
    }
    case "pull_request": {
      const pr = p.pull_request ?? {};
      const action = p.action === "closed" && pr.merged ? "merged" : (p.action ?? "");
      return {
        kind, event: name, action,
        entity: { kind: "pr", number: toInt(pr.number), url: pr.html_url ?? null, title: pr.title ?? "" },
        labels: (pr.labels ?? []).map((l) => l.name ?? l),
        label: p.label?.name ?? null,
        headSha: pr.head?.sha ?? null,
        baseRef: pr.base?.ref ?? null,
        headRef: pr.head?.ref ?? null,
        merged: Boolean(pr.merged),
        entityUpdatedAt: pr.updated_at ?? null,
        actor, at, repo, delivery, isPr: true,
      };
    }
    case "pull_request_review": {
      const r = p.review ?? {};
      const pr = p.pull_request ?? {};
      return {
        kind, event: name, action: "review_submitted", state: r.state ?? null,
        entity: { kind: "pr", number: toInt(pr.number), url: r.html_url ?? pr.html_url ?? null, title: pr.title ?? "" },
        reviewId: r.id ?? null,
        body: r.body ?? "",
        baseRef: pr.base?.ref ?? null,
        entityUpdatedAt: pr.updated_at ?? null,
        actor, at, repo, delivery, isPr: true,
      };
    }
    case "pull_request_review_comment": {
      const pr = p.pull_request ?? {};
      return {
        kind, event: name, action: p.action ?? "created",
        entity: { kind: "pr", number: toInt(pr.number), url: p.comment?.html_url ?? pr.html_url ?? null, title: pr.title ?? "" },
        commentId: p.comment?.id ?? null,
        body: p.comment?.body ?? "",
        baseRef: pr.base?.ref ?? null,
        entityUpdatedAt: pr.updated_at ?? null,
        actor, at, repo, delivery, isPr: true,
      };
    }
    case "check_suite": {
      const cs = p.check_suite ?? {};
      const prs = Array.isArray(cs.pull_requests) ? cs.pull_requests : [];
      const pr = prs[0] ?? {};
      const state = cs.conclusion ?? cs.status ?? null; // conclusion: success/failure/... ; status while running
      return {
        kind, event: name, action: p.action ?? "completed", state,
        entity: pr.number ? { kind: "pr", number: toInt(pr.number), url: pr.url ?? null, title: "" } : null,
        headSha: cs.head_sha ?? null,
        actor, at, repo, delivery, isPr: true,
      };
    }
    case "check_run": {
      const cr = p.check_run ?? {};
      const prs = Array.isArray(cr.pull_requests) ? cr.pull_requests : [];
      const pr = prs[0] ?? {};
      const state = cr.conclusion ?? cr.status ?? null;
      return {
        kind, event: name, action: p.action ?? "completed", state, checkName: cr.name ?? null,
        entity: pr.number ? { kind: "pr", number: toInt(pr.number), url: pr.url ?? null, title: "" } : null,
        headSha: cr.head_sha ?? null,
        actor, at, repo, delivery, isPr: true,
      };
    }
    default:
      return null; // ping, label, and every unmapped event is ignored
  }
}

/**
 * Normalize a repo-events feed entry (already mapped by github.listEvents' normalizeEvent into
 * {id, kind, action, number, title, url, isPr, actor, at, state?, body?}).
 */
export function normalizePollEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entityKind = raw.isPr ? "pr" : "issue";
  const entity = raw.number ? { kind: entityKind, number: raw.number, url: raw.url ?? null, title: raw.title ?? "" } : null;
  return {
    kind: raw.kind, event: `poll:${raw.kind}`, action: raw.action ?? "",
    entity, pollId: raw.id ?? null,
    body: raw.body ?? "",
    state: raw.state ?? null,
    labels: raw.labels ?? undefined,
    label: raw.label ?? null,
    baseRef: raw.baseRef ?? null,
    headSha: raw.headSha ?? null,
    commentId: raw.commentId ?? null,
    reviewId: raw.reviewId ?? null,
    entityUpdatedAt: raw.entityUpdatedAt ?? null,
    supplemented: raw.supplemented === true,
    actor: raw.actor ?? null, at: raw.at ?? null, repo: raw.repo ?? null,
    isPr: Boolean(raw.isPr),
  };
}

/**
 * Canonical dedup key — stable across channels. Repo is ALWAYS the first segment: issue/PR numbers are
 * per-repo, so an event on repo A must never dedup or match against repo B's loop. Same real-world event
 * produces the same key whether it came via webhook or poll; repeat-instance events (labeled, closed,
 * reopened, checks) carry the entity's `updated_at` (or the check's sha+state) as the instance discriminator
 * so an unlabeled→relabeled cycle fires again instead of being permanently deduped.
 */
export function canonicalKey(ev) {
  if (!ev?.repo) return null;
  const repo = ev.repo;
  const e = ev.entity ?? {};
  const n = e.number;
  const stamp = ev.entityUpdatedAt ?? ev.at ?? "";
  switch (ev.kind) {
    case "issue":
      switch (ev.action) {
        case "opened": return `${repo}:issue.opened:${n}`;
        case "labeled": return `${repo}:issue.labeled:${n}:${ev.label ?? "?"}:${stamp}`;
        case "unlabeled": return `${repo}:issue.unlabeled:${n}:${ev.label ?? "?"}:${stamp}`;
        case "closed": return `${repo}:issue.closed:${n}:${stamp}`;
        case "reopened": return `${repo}:issue.reopened:${n}:${stamp}`;
        case "assigned": return `${repo}:issue.assigned:${n}:${stamp}`;
        default: return `${repo}:issue.${ev.action || "other"}:${n}`;
      }
    case "pr":
      switch (ev.action) {
        case "opened": return `${repo}:pr.opened:${n}`;
        case "ready_for_review": return `${repo}:pr.ready:${n}`;
        case "labeled": return `${repo}:pr.labeled:${n}:${ev.label ?? "?"}:${stamp}`;
        case "unlabeled": return `${repo}:pr.unlabeled:${n}:${ev.label ?? "?"}:${stamp}`;
        case "merged": return `${repo}:pr.merged:${n}`;
        case "closed": return `${repo}:pr.closed:${n}:${stamp}`;
        case "reopened": return `${repo}:pr.reopened:${n}:${stamp}`;
        case "push": case "synchronize": return ev.headSha ? `${repo}:pr.push:${n}:${ev.headSha}` : `${repo}:pr.push:${n}:${ev.pollId ?? "?"}`;
        default: return `${repo}:pr.${ev.action || "other"}:${n}`;
      }
    case "comment":
      return ev.commentId
        ? `${repo}:${ev.isPr ? "pr" : "issue"}.comment:${n}:${ev.commentId}`
        : `${repo}:${ev.isPr ? "pr" : "issue"}.comment:${n}:${ev.pollId ?? "?"}`;
    case "review":
      return ev.reviewId ? `${repo}:pr.review:${n}:${ev.reviewId}` : `${repo}:pr.review:${n}:${ev.state ?? "?"}:${ev.pollId ?? "?"}`;
    case "review_comment":
      return ev.commentId ? `${repo}:pr.review_comment:${ev.commentId}` : `${repo}:pr.review_comment:${n}:${ev.pollId ?? "?"}`;
    case "check_suite":
      return `${repo}:checksuite:${ev.headSha ?? "?"}:${ev.state ?? "?"}${n ? `:pr${n}` : ""}`;
    case "check_run":
      return `${repo}:checkrun:${ev.checkName ?? "?"}:${ev.headSha ?? "?"}:${ev.state ?? "?"}`;
    case "timeline":
      return `${repo}:timeline.${ev.event || "other"}:${n}:${ev.pollId ?? "?"}`;
    default:
      return `${repo}:${ev.kind ?? "other"}.${ev.action ?? ""}${n ? `:${n}` : ""}${ev.pollId ? `:poll${ev.pollId}` : ""}`;
  }
}

/** The event labels a trigger spec's `events` list may name — normalized names, not raw GitHub event names. */
const EVENT_ALIASES = {
  // github_issue trigger events
  opened: (ev) => (ev.kind === "issue" || ev.kind === "pr") && ev.action === "opened",
  labeled: (ev) => ev.action === "labeled",
  closed: (ev) => (ev.kind === "issue" && ev.action === "closed") || ev.action === "closed",
  assigned: (ev) => ev.action === "assigned",
  commented: (ev) => ev.kind === "comment",
  // github_pr trigger events
  ready_for_review: (ev) => ev.action === "ready_for_review",
  merged: (ev) => ev.action === "merged" || ev.merged === true,
  checks_failed: (ev) => (ev.kind === "check_suite" || ev.kind === "check_run") && /fail|cancel|timed_out|action_required|startup_failure/.test(String(ev.state ?? "")),
  checks_passed: (ev) => (ev.kind === "check_suite" || ev.kind === "check_run") && ev.state === "success",
  review_submitted: (ev) => ev.kind === "review",
  push: (ev) => ev.action === "push" || ev.action === "synchronize",
  // generic
};

/** Normalize one trigger event name to the canonical test. Unknown names never match. */
function eventMatches(name, ev) {
  const test = EVENT_ALIASES[name];
  return test ? Boolean(test(ev)) : false;
}

/**
 * Does this loop's github trigger fire for `ev`? Checks trigger kind (issue vs pr), the event list, and the
 * optional filters {branch, label, author}. Also drops the loop's own bot-actor comments (self-loop guard).
 * @returns {boolean}
 */
export function matchesTrigger(trigger, ev) {
  if (!trigger || typeof trigger !== "object") return false;
  const kind = trigger.kind;
  if (kind !== "github_issue" && kind !== "github_pr") return false;
  // A github_issue trigger only fires on issue-side events; a github_pr trigger only on PR-side events
  // (comments on a PR's conversation thread are PR-side — the payload marks them isPr).
  if (kind === "github_issue" && ev.isPr) return false;
  if (kind === "github_pr" && !ev.isPr) return false;
  // Self-feedback guard: comments produced by our own send_github_comment tool never retrigger — recorded as
  // produced:<commentId> deliveries at write time (PAT actor can't be identified by a bot suffix).
  if (ev.kind === "comment" && ev.actor && String(ev.actor).endsWith(BOT_ACTOR_SUFFIX)) return false;
  const events = Array.isArray(trigger.events) ? trigger.events : [];
  if (!events.some((name) => eventMatches(name, ev))) return false;
  const f = trigger.filters;
  if (f && typeof f === "object") {
    // FAIL CLOSED: a configured filter whose field the event doesn't carry cannot pass — callers enrich
    // baseRef/labels via fetchEntity when the payload lacks them; a missing value means "no match".
    if (f.branch && String(f.branch) !== String(ev.baseRef ?? "")) return false;
    if (f.author && String(f.author) !== String(ev.actor ?? "")) return false;
    if (f.label) {
      const labels = Array.isArray(ev.labels) ? ev.labels : (ev.label ? [ev.label] : []);
      if (!labels.includes(f.label)) return false;
    }
  }
  return true;
}

/**
 * "Starts matching" semantics: condition triggers (labeled/closed/assigned/checks_* state) fire on the
 * transition into the condition — not on every matching event. `matchStore` persists (loop, entityRef) ->
 * matched. Returns true when the event should enqueue a run.
 */
export function startsMatching({ matchStore, loopId, entityRef, matched }) {
  if (!entityRef || !matchStore) return matched; // no entity = always fire when matched (one-shot events)
  const prev = matchStore.get(loopId, entityRef);
  if (matched !== prev) matchStore.set(loopId, entityRef, matched);
  return matched && !prev; // rising edge only
}

/** Condition-type events that use match-state edges rather than firing every time. */
const CONDITION_EVENTS = new Set(["labeled", "unlabeled", "closed", "reopened", "assigned", "merged", "checks_failed", "checks_passed", "ready_for_review", "review_submitted"]);
/** Negative counterparts: their arrival CLEARS the matched flag so a later positive transition fires again.
 *  unlabeled ↔ labeled, reopened ↔ closed, unassigned ↔ assigned. */
const NEGATIVE_EVENTS = new Set(["unlabeled", "reopened", "unassigned"]);
const isConditionEvent = (ev, trigger) => {
  const events = Array.isArray(trigger?.events) ? trigger.events : [];
  if (!events.some((e) => CONDITION_EVENTS.has(e))) return false;
  const actionKey =
    ev.kind === "check_suite" || ev.kind === "check_run"
      ? String(ev.state) === "success" ? "checks_passed" : "checks_failed"
      : ev.action === "merged" ? "merged" : ev.action;
  return CONDITION_EVENTS.has(actionKey) || NEGATIVE_EVENTS.has(ev.action);
};

/** Enrich an event's filter-relevant fields when the payload lacks them (fail-closed needs real values).
 * @param {{ github?: object }} deps — github.getPull fills baseRef/labels for PR-side events. */
async function enrichEvent(deps, trigger, ev) {
  const f = trigger?.filters;
  if (!f || typeof f !== "object") return ev;
  const needsBase = f.branch && ev.baseRef == null && ev.isPr && ev.entity?.number && ev.repo;
  const needsLabels = f.label && !Array.isArray(ev.labels) && ev.entity?.number && ev.repo;
  if (!needsBase && !needsLabels) return ev;
  const github = deps?.github;
  if (!github?.getPull && !github?.getIssue) return ev;
  try {
    const detail = ev.isPr
      ? await github.getPull?.(ev.repo, ev.entity.number)
      : await github.getIssue?.(ev.repo, ev.entity.number);
    if (!detail) return ev;
    return {
      ...ev,
      baseRef: ev.baseRef ?? detail.baseRef ?? null,
      labels: Array.isArray(ev.labels) ? ev.labels : (detail.labels ?? detail.labelNames ?? ev.labels),
    };
  } catch {
    return ev; // enrichment failed → fail-closed matching decides (missing field = no match)
  }
}

/**
 * Ingest one canonical event: fan out to every enabled github loop ON THE SAME REPO whose trigger matches,
 * applying the starts-matching edge (including negative transitions that re-arm the loop).
 *
 * Ordering is failure-safe: the global delivery mark is written LAST, only after every candidate loop was
 * evaluated AND its enqueue settled. Per-loop, matchState advances only AFTER that loop's enqueue succeeded
 * — a throwing enqueue leaves both the loop's state and the delivery un-marked, so the next delivery (or a
 * manual replay) re-processes the event cleanly: already-enqueued loops dedup via UNIQUE(loop_id,trigger_key),
 * the failing one re-fires. `seen` at the top only short-circuits fully-completed ingests.
 *
 * @param {{ store: object, enqueue: (loopId: string, triggerKey: string, ctx: object) => any,
 *   github?: object, loops?: object[], now?: () => number }} deps
 * @returns {{ ingested: boolean, runs: Array<{loopId:string, runId:string}>, skipped?: string }}
 */
export async function ingestGithubEvent({ store, enqueue, github, ev, loops }) {
  const key = canonicalKey(ev);
  if (!key) return { ingested: false, runs: [], skipped: "no canonical key (missing repo)" };
  const source = ev.deliveryId ? "webhook" : "poll";
  if (store.githubDeliveries.seen(key)) return { ingested: false, runs: [], skipped: "duplicate" };
  const runs = [];
  const candidates = loops ?? store.loops.listEnabledGithub() ?? [];
  for (const loop of candidates) {
    if (loop.enabled !== true && loop.enabled !== 1) continue;
    const trigger = loop.trigger ?? {};
    if (trigger.kind !== "github_issue" && trigger.kind !== "github_pr") continue;
    // Repo isolation is an exact-match gate per candidate loop, BEFORE any matching work — an event on repo A
    // can never reach or dedup against repo B's loops (canonical keys also carry the repo prefix).
    const ws = store.workspaces.get(loop.workspaceId);
    if (!ws?.repo || ws.repo !== ev.repo) continue;
    const ev2 = await enrichEvent({ github }, trigger, ev);
    // Self-feedback guard: a comment this app produced (send_github_comment records produced:<id>) never
    // triggers — the PAT actor is a normal user, so only the recorded id can identify it.
    if (ev2.kind === "comment" && ev2.commentId && store.githubDeliveries.seen(`produced:${ev2.commentId}`)) continue;
    const matched = matchesTrigger(trigger, ev2);
    const entityRef = entityRefOf(ev2);
    const conditional = entityRef && isConditionEvent(ev2, trigger);
    // Rising-edge decision reads the persisted state — the write happens only AFTER this loop's enqueue
    // settled, so a failure never advances the state without the run existing.
    const prevMatched = conditional ? store.loopMatchState.get(loop.id, entityRef) : false;
    const fire = conditional ? matched && !prevMatched : matched;
    if (!fire && conditional && matched !== prevMatched) {
      // Negative transition that did NOT enqueue (unlabeled/reopened on a non-subscribed path or an already
      // unmatched state): still persist the edge — a later positive transition must see the cleared state.
      store.loopMatchState.set(loop.id, entityRef, matched);
      continue;
    }
    if (!fire) continue;
    const r = await enqueue(loop.id, `gh:${key}`, { ev: ev2, loop });
    if (conditional) store.loopMatchState.set(loop.id, entityRef, matched);
    if (r?.created !== false) runs.push({ loopId: loop.id, runId: r?.run?.id ?? null });
  }
  store.githubDeliveries.mark(key, source);
  return { ingested: true, runs };
}
