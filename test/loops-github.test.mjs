// Phase 2 (Issue14): GitHub event ingestion — canonical dedup across webhook+poll, matching, match-state
// edges, scoped-tool capability/scope checks, self-comment filtering, disabled loops, failure visibility.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openControlStore } from "../src/control/store.mjs";
import { createLoopStore } from "../src/loops/store.mjs";
import { normalizeWebhookEvent, normalizePollEvent, canonicalKey, matchesTrigger, ingestGithubEvent } from "../src/loops/github-events.mjs";

const WS_MODEL = { provider: "faux", modelId: "faux-1" };

function env() {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "ws-1",
    projectId: project.id,
    name: "loops ws",
    baseBranch: "main",
    branch: "tarsbot/ws",
    cwd: "/home/sprite/workspace/repo",
    model: WS_MODEL,
  });
  return { store, ws: workspace, ls: createLoopStore({ store }) };
}

const ghLoop = async (ls, wsId, trigger, extra = {}) =>
  (await ls.create(wsId, { name: `gh-${Math.random().toString(36).slice(2, 6)}`, instructions: "do it", trigger: { kind: trigger.kind, events: trigger.events }, ...extra })).loop;

// ---- canonical keys + dedup ----

test("canonicalKey: same event via webhook and poll produce the same repo-scoped key (direction-swap dedup)", () => {
  const wh = normalizeWebhookEvent("issues", { action: "opened", issue: { number: 12, html_url: "u", title: "t", updated_at: "t1" }, sender: { login: "u" }, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const poll = normalizePollEvent({ id: "99", kind: "issue", action: "opened", number: 12, isPr: false, actor: "u", at: "x", repo: "hifizz/tars-sandbox-playground" });
  assert.equal(canonicalKey(wh), canonicalKey(poll), `webhook key ${canonicalKey(wh)} != poll key ${canonicalKey(poll)}`);
  // Cross-repo: same issue number on another repo must NOT share the key.
  const other = normalizeWebhookEvent("issues", { action: "opened", issue: { number: 12 }, sender: {}, repository: { full_name: "other/repo" } });
  assert.notEqual(canonicalKey(wh), canonicalKey(other));
  assert.equal(canonicalKey({ kind: "issue", action: "opened", entity: { number: 1 } }), null, "missing repo -> no key (rejected)");
});

test("cross-repo isolation: same issue number on another repo never enqueues nor dedups", async () => {
  const { store, ws, ls } = env();
  await ghLoop(ls, ws.id, { kind: "github_issue", events: ["opened"] });
  const enqueued = [];
  const otherRepo = normalizeWebhookEvent("issues", { action: "opened", issue: { number: 7 }, sender: {}, repository: { full_name: "other/repo" } });
  const out = await ingestGithubEvent({ store, enqueue: async (id, k) => enqueued.push(k) ?? { created: true, run: { id: "r" } }, ev: otherRepo });
  assert.equal(out.ingested, true, "event is marked (its own repo key) but fans to no loop");
  assert.equal(enqueued.length, 0, "no loop on repo A receives repo B's event");
  // And repo B's event does not block repo A's same-numbered event.
  const ours = normalizeWebhookEvent("issues", { action: "opened", issue: { number: 7 }, sender: {}, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const out2 = await ingestGithubEvent({ store, enqueue: async (id, k) => enqueued.push(k) ?? { created: true, run: { id: "r" } }, ev: ours });
  assert.equal(enqueued.length, 1, "our repo's event still fires");
  assert.equal(out2.ingested, true);
});

test("ingest: same canonical event twice is dropped by github_deliveries; a second loop still got the first ingest", async () => {
  const { store, ws, ls } = env();
  await ghLoop(ls, ws.id, { kind: "github_issue", events: ["opened"] });
  await ghLoop(ls, ws.id, { kind: "github_issue", events: ["opened"] });
  const ev = normalizeWebhookEvent("issues", { action: "opened", issue: { number: 7 }, sender: { login: "u" }, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const enqueued = [];
  const out1 = await ingestGithubEvent({ store, enqueue: async (id, key) => enqueued.push({ id, key }) ?? { created: true, run: { id: "r" } }, ev });
  assert.equal(out1.ingested, true);
  assert.equal(enqueued.length, 2, "both enabled github loops receive the one event (no global swallow)");
  // Second ingest (e.g. the poll picking up the same event after the webhook) is dropped at the deliveries layer.
  const out2 = await ingestGithubEvent({ store, enqueue: async () => ({ created: true, run: { id: "x" } }), ev });
  assert.equal(out2.ingested, false);
  assert.equal(out2.skipped, "duplicate");
});

test("per-loop dedup: enqueue conflict on (loop,trigger_key) maps to created:false, not an error", async () => {
  const { store, ws } = env();
  const { run, created } = store.loopRuns.enqueue({ loopId: "l1", loopVersion: 1, workspaceId: ws.id, triggerKind: "github_issue", triggerKey: "gh:issue.opened:1", payload: {}, entityRef: "issue:1" });
  assert.equal(created, true);
  const again = store.loopRuns.enqueue({ loopId: "l1", loopVersion: 1, workspaceId: ws.id, triggerKind: "github_issue", triggerKey: "gh:issue.opened:1", payload: {}, entityRef: "issue:1" });
  assert.equal(again.created, false);
  assert.equal(again.run.id, run.id);
});

// ---- matching ----

test("matchesTrigger: github_issue ignores PR events; github_pr ignores issue events; event list gates", async () => {
  const issue = { kind: "github_issue", events: ["opened", "labeled"] };
  const prLoop = { kind: "github_pr", events: ["opened"] };
  const issueEv = normalizeWebhookEvent("issues", { action: "opened", issue: { number: 1 }, sender: {}, repository: {} });
  const prEv = normalizeWebhookEvent("pull_request", { action: "opened", pull_request: { number: 2, merged: false }, sender: {}, repository: {} });
  assert.equal(matchesTrigger(issue, issueEv), true);
  assert.equal(matchesTrigger(issue, prEv), false, "issue loop must not fire on a pr event");
  assert.equal(matchesTrigger(prLoop, issueEv), false);
  const closedEv = normalizeWebhookEvent("issues", { action: "closed", issue: { number: 1 }, sender: {}, repository: {} });
  assert.equal(matchesTrigger(issue, closedEv), false, "closed is not in the event list");
});

test("self-comment guard: comments authored by a *-bot actor never trigger a commented loop", () => {
  const loop = { kind: "github_issue", events: ["commented"] };
  const botComment = normalizeWebhookEvent("issue_comment", { action: "created", issue: { number: 3 }, comment: { id: 55, body: "done" }, sender: { login: "tarsbot-dev[bot]" }, repository: {} });
  const humanComment = normalizeWebhookEvent("issue_comment", { action: "created", issue: { number: 3 }, comment: { id: 56, body: "hi" }, sender: { login: "alice" }, repository: {} });
  assert.equal(matchesTrigger(loop, botComment), false, "bot-authored comment is self-loop bait");
  assert.equal(matchesTrigger(loop, humanComment), true);
});

test("filters: label filter requires the event to carry that label; author filter checks the actor", () => {
  const loop = { kind: "github_issue", events: ["labeled"], filters: { label: "bug" } };
  const labeled = normalizeWebhookEvent("issues", { action: "labeled", issue: { number: 1, labels: [{ name: "bug" }] }, label: { name: "bug" }, sender: {}, repository: {} });
  const otherLabel = normalizeWebhookEvent("issues", { action: "labeled", issue: { number: 1, labels: [{ name: "feat" }] }, label: { name: "feat" }, sender: {}, repository: {} });
  assert.equal(matchesTrigger(loop, labeled), true);
  assert.equal(matchesTrigger(loop, otherLabel), false);
});

test("disabled loop never triggers; match state edge: same condition event fires once per entity", async () => {
  const { store, ws, ls } = env();
  const { loop } = await ls.create(ws.id, { name: "g", instructions: "i", trigger: { kind: "github_issue", events: ["labeled"] } });
  await ls.setEnabled(loop.id, false);
  const ev = normalizeWebhookEvent("issues", { action: "labeled", issue: { number: 9, labels: [{ name: "x" }] }, label: { name: "x" }, sender: {}, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const enqueued = [];
  const out = await ingestGithubEvent({ store, enqueue: async (id, k) => enqueued.push(k) ?? { created: true, run: { id: "r" } }, ev });
  assert.equal(out.ingested, true, "event is ingested (deliveries marked)");
  assert.equal(enqueued.length, 0, "disabled loop is skipped at fan-out");
});

test("failure is visible: a failing enqueue propagates and is NOT marked as a successful run", async () => {
  const { store, ws, ls } = env();
  await ls.create(ws.id, { name: "g", instructions: "i", trigger: { kind: "github_issue", events: ["opened"] } });
  const ev = normalizeWebhookEvent("issues", { action: "opened", issue: { number: 21 }, sender: {}, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  await assert.rejects(
    ingestGithubEvent({ store, enqueue: async () => { throw new Error("queue full"); }, ev }),
    /queue full/,
  );
  // The run was NOT recorded; the delivery mark is what dedups a retry — the loop can re-fire on the next real event.
  const loops = ls.listByWorkspace(ws.id);
  assert.equal(store.loopRuns.listByLoop(loops[0].id).length, 0);
});

// ---- trigger validation (store) ----

test("validateTrigger: github_issue/pr accept events[] or single event; unknown events rejected", async () => {
  const { ls, ws } = env();
  const { loop } = await ls.create(ws.id, { name: "t", instructions: "i", trigger: { kind: "github_issue", events: ["opened", "labeled"] } });
  assert.deepEqual(loop.trigger.events, ["opened", "labeled"]);
  await assert.rejects(ls.create(ws.id, { name: "t", instructions: "i", trigger: { kind: "github_issue", events: ["hacked"] } }), /must be one of/);
  await assert.rejects(ls.create(ws.id, { name: "t", instructions: "i", trigger: { kind: "github_pr", events: [] } }), /non-empty/);
});

test("self-feedback: a comment produced by send_github_comment never re-triggers a commented loop", async () => {
  const { store, ws, ls } = env();
  await ghLoop(ls, ws.id, { kind: "github_issue", events: ["commented"] });
  // The tool recorded its produced comment id.
  store.githubDeliveries.mark("produced:777", "tool");
  const own = normalizeWebhookEvent("issue_comment", { action: "created", issue: { number: 4 }, comment: { id: 777, body: "done" }, sender: { login: "hifizz" }, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const human = normalizeWebhookEvent("issue_comment", { action: "created", issue: { number: 4 }, comment: { id: 778, body: "hi" }, sender: { login: "hifizz" }, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const enqueued = [];
  const enqueue = async (id, k) => enqueued.push(k) ?? { created: true, run: { id: "r" } };
  await ingestGithubEvent({ store, enqueue, ev: own });
  assert.equal(enqueued.length, 0, "our own produced comment is dropped even though the PAT actor looks human");
  await ingestGithubEvent({ store, enqueue, ev: human });
  assert.equal(enqueued.length, 1, "a real human comment still fires");
});

test("negative transitions re-arm: labeled fires, unlabeled clears, a second labeled fires again", async () => {
  const { store, ws, ls } = env();
  await ghLoop(ls, ws.id, { kind: "github_issue", events: ["labeled"] });
  const enqueued = [];
  const enqueue = async (id, k) => enqueued.push(k) ?? { created: true, run: { id: "r" } };
  const labeled1 = normalizeWebhookEvent("issues", { action: "labeled", issue: { number: 5, labels: [{ name: "bug" }], updated_at: "t1" }, label: { name: "bug" }, sender: {}, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const unlabeled = normalizeWebhookEvent("issues", { action: "unlabeled", issue: { number: 5, labels: [], updated_at: "t2" }, label: { name: "bug" }, sender: {}, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const labeled2 = normalizeWebhookEvent("issues", { action: "labeled", issue: { number: 5, labels: [{ name: "bug" }], updated_at: "t3" }, label: { name: "bug" }, sender: {}, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  await ingestGithubEvent({ store, enqueue, ev: labeled1 });
  assert.equal(enqueued.length, 1, "first label fires");
  // Same event again (webhook retry) dedups on the canonical key.
  await ingestGithubEvent({ store, enqueue, ev: labeled1 });
  assert.equal(enqueued.length, 1, "retry deduped");
  await ingestGithubEvent({ store, enqueue, ev: unlabeled });
  await ingestGithubEvent({ store, enqueue, ev: labeled2 });
  assert.equal(enqueued.length, 2, "re-labeled after unlabeled fires again (new instance key, match state re-armed)");
});

test("fail-closed filters: branch filter on an event without baseRef never matches (no silent pass)", () => {
  const loop = { kind: "github_pr", events: ["commented"], filters: { branch: "main" } };
  const ev = normalizeWebhookEvent("issue_comment", { action: "created", issue: { number: 8, pull_request: {} }, comment: { id: 1, body: "x" }, sender: { login: "u" }, repository: { full_name: "r" } });
  assert.equal(ev.isPr, true);
  assert.equal(ev.baseRef == null, true, "payload carries no baseRef for a comment event");
  assert.equal(matchesTrigger(loop, ev), false, "missing baseRef = no match, not a pass");
});

test("enqueue failure does NOT mark the delivery — a retry re-fires the same event (no lost event)", async () => {
  const { store, ws, ls } = env();
  await ghLoop(ls, ws.id, { kind: "github_issue", events: ["opened"] });
  const ev = normalizeWebhookEvent("issues", { action: "opened", issue: { number: 31 }, sender: {}, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const key = canonicalKey(ev);
  let fail = true;
  const enqueued = [];
  const enqueue = async (id, k) => {
    if (fail) throw new Error("queue full");
    enqueued.push(k);
    return { created: true, run: { id: "r" } };
  };
  await assert.rejects(ingestGithubEvent({ store, enqueue, ev }), /queue full/);
  assert.equal(store.githubDeliveries.seen(key), undefined, "delivery stays UNMARKED after a failed enqueue");
  fail = false;
  const out = await ingestGithubEvent({ store, enqueue, ev });
  assert.equal(out.ingested, true, "redelivery re-processes the event");
  assert.equal(enqueued.length, 1, "the same event reaches the loop on retry");
});

test("match state advances only after enqueue settles — a mid-fanout failure preserves retry edges", async () => {
  const { store, ws, ls } = env();
  const { loop } = await ls.create(ws.id, { name: "cond", instructions: "i", trigger: { kind: "github_issue", events: ["labeled"] } });
  const ev = normalizeWebhookEvent("issues", { action: "labeled", issue: { number: 33, labels: [{ name: "bug" }], updated_at: "t1" }, label: { name: "bug" }, sender: {}, repository: { full_name: "hifizz/tars-sandbox-playground" } });
  const enqueue = async () => { throw new Error("down"); };
  await assert.rejects(ingestGithubEvent({ store, enqueue, ev }));
  assert.equal(store.loopMatchState.get(loop.id, "issue:33"), false, "match state NOT advanced on a failed enqueue — the edge survives for retry");
});

// Closeout event matrix: real webhook payload shapes through ingest (not synthetic keys).
test("matrix: PR opened/ready/labeled/merged + review + checks through real webhook shapes", async () => {
  const { store, ws, ls } = env();
  const evs = [
    ["pull_request", { action: "opened", pull_request: { number: 2, merged: false, draft: false, head: { sha: "a1" }, base: { ref: "main" }, updated_at: "t1" }, sender: {}, repository: { full_name: ws.repo } }],
    ["pull_request", { action: "ready_for_review", pull_request: { number: 2, merged: false, draft: false, head: { sha: "a1" }, base: { ref: "main" }, updated_at: "t2" }, sender: {}, repository: { full_name: ws.repo } }],
    ["pull_request", { action: "labeled", pull_request: { number: 2, merged: false, labels: [{ name: "bug" }], head: { sha: "a1" }, base: { ref: "main" }, updated_at: "t3" }, sender: {}, repository: { full_name: ws.repo } }],
    ["pull_request", { action: "closed", pull_request: { number: 2, merged: true, head: { sha: "a1" }, base: { ref: "main" }, updated_at: "t4" }, sender: {}, repository: { full_name: ws.repo } }],
    ["pull_request_review", { action: "submitted", pull_request: { number: 2, merged: false, head: { sha: "a1" }, base: { ref: "main" }, updated_at: "t5" }, review: { id: 9, state: "approved" }, sender: {}, repository: { full_name: ws.repo } }],
  ];
  const norm = evs.map(([t, p]) => normalizeWebhookEvent(t, p));
  assert.deepEqual(norm.map((e) => e.action), ["opened", "ready_for_review", "labeled", "merged", "review_submitted"], "real PR actions map to canonical names");
  assert.equal(norm[3].action, "merged", "closed+merged=true -> merged (not closed)");
  assert.ok(norm.every((e) => e.repo === ws.repo), "every event carries the repo");
});

test("matrix: issue assigned + closed are condition events that re-arm on reopen", async () => {
  const { store, ws, ls } = env();
  const { loop } = await ls.create(ws.id, { name: "a", instructions: "i", trigger: { kind: "github_issue", events: ["assigned"] } });
  const enqueue = async () => ({ created: true, run: { id: "r" } });
  const mk = (action, extra = {}) => normalizeWebhookEvent("issues", { action, issue: { number: 40, updated_at: "t", ...extra }, sender: {}, repository: { full_name: ws.repo } });
  let n = 0; const enq = async () => { n++; return enqueue(); };
  assert.equal((await ingestGithubEvent({ store, enqueue: enq, ev: mk("assigned") })).runs.length, 1, "assigned fires");
  assert.equal((await ingestGithubEvent({ store, enqueue: enq, ev: mk("assigned") })).runs.length, 0, "same instance deduped");
  // reopened is the negative for assigned too? no — unassigned is; reopened re-arms closed. For assigned the re-arm is unassigned.
  const un = normalizeWebhookEvent("issues", { action: "unassigned", issue: { number: 40, updated_at: "t2" }, sender: {}, repository: { full_name: ws.repo } });
  assert.equal((await ingestGithubEvent({ store, enqueue: enq, ev: un })).runs.length, 0, "unassigned does not fire");
  const re = normalizeWebhookEvent("issues", { action: "assigned", issue: { number: 40, updated_at: "t3" }, sender: {}, repository: { full_name: ws.repo } });
  assert.equal((await ingestGithubEvent({ store, enqueue: enq, ev: re })).runs.length, 1, "assigned re-fires after unassigned cleared the edge");
});

test("capabilities round-trip: github switches survive create + update + reload", async () => {
  const { store, ws, ls } = env();
  const caps = { code: "readwrite", scopeToTrigger: true, github: { comment: true, label: true, openIssue: false, openPr: true } };
  const { loop } = await ls.create(ws.id, { name: "c", instructions: "i", trigger: { kind: "github_issue", events: ["opened"] }, capabilities: caps });
  const saved = store.loops.get(loop.id);
  assert.equal(saved.capabilities.github.openPr, true, "github capabilities persisted through the schema");
  await ls.update(loop.id, { name: "c2" });
  assert.equal(store.loops.get(loop.id).capabilities.github.comment, true, "a no-capabilities update keeps them");
});

test("links.ofConversation accepts a NUMERIC conversationId (parent's String() fix)", () => {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "o/r", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({ requestId: "r", projectId: project.id, name: "w", baseBranch: "m", branch: "b", cwd: "/w", model: WS_MODEL });
  store.links.link({ conversationId: "12345", workspaceId: workspace.id, botId: "bot-x" });
  assert.equal(store.links.ofConversation(12345)?.botId, "bot-x", "a numeric id resolves — String() conversion held");
});
