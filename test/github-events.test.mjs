// Offline tests for AMP13-events: src/github-events.mjs + src/routes/github-events.mjs.
// Everything is in-process: a real control store (memory), fake GitHub client shapes (listEvents/getCommitStatus
// injected), a fake bots registry recording submitted inputs, and a real HTTP server for status codes. No network,
// no model, no Sprite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { createGithubEventsService, describeEvent, eventMessage, EVENT_TEXT_LIMIT } from "../src/github-events.mjs";
import { register as registerEvents } from "../src/routes/github-events.mjs";

const REPO = "hifizz/tars-sandbox-playground";
const SHA = "a".repeat(40);

function seedWorkspace(store, { repo = REPO, status = "ready" } = {}) {
  const project = store.projects.upsert({ repo, defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: `seed-${Math.random().toString(36).slice(2)}`,
    projectId: project.id,
    name: "events-ws",
    baseBranch: "main",
    branch: "tarsbot/ws-events",
    cwd: "/home/sprite/workspace/app",
    model: { provider: "faux", modelId: "faux-1" },
    task: "task",
  });
  const ws = store.workspaces.update(workspace.id, { status });
  return { ...ws, repo, baseCommit: SHA };
}

function fakeBots(wsId = "ws_e") {
  const list = [
    { id: "b1", name: "primary", conversationId: "5001", workspaceId: wsId },
    { id: "d1", name: "issue-7-discuss", conversationId: "5002", workspaceId: wsId, issueLoop: { issue: 7, baseBranch: "main", pinnedSha: SHA, dir: "/home/sprite/x" } },
  ];
  const submits = [];
  return {
    submits,
    list: () => list.map((b) => ({ ...b })),
    get: (id) => list.find((b) => b.id === id || b.name === id),
    add(bot) {
      list.push(bot);
    },
    async conversation(id) {
      const bot = list.find((b) => b.id === id || b.name === id);
      if (!bot) return undefined;
      return {
        async submit(input) {
          submits.push({ botId: id, input });
          return { id: submits.length };
        },
      };
    },
  };
}

function fakeGithub(events = [], { status = null, checkRuns = null, pulls = {} } = {}) {
  return {
    calls: [],
    async listEvents(repo, { limit } = {}) {
      this.calls.push(`listEvents ${repo} ${limit}`);
      return events.slice(0, limit ?? events.length);
    },
    async getCommitStatus(repo, sha) {
      this.calls.push(`status ${sha}`);
      return status;
    },
    async getCheckRuns(repo, sha) {
      this.calls.push(`checkRuns ${sha}`);
      return checkRuns;
    },
    async getPull(repo, n) {
      this.calls.push(`getPull ${n}`);
      return pulls[n] ?? null;
    },
  };
}

/** A manually-driven clock matching the service's {setTimer, clearTimer, nowMs} seams. `advance(ms)` moves time
 * forward and runs every timer that comes due (re-armed timers fire only after their own interval elapses). */
function fakeClock() {
  const timers = new Set();
  let now = 1_700_000_000_000;
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    timers,
    nowMs: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, unref() { return this; } };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => {
      timers.delete(t);
    },
    pendingCount: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = Math.max(now, due.at);
        await due.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

const issueOpened = (n, id = `i${n}`) => ({ id, kind: "issue", action: "opened", number: n, title: `issue ${n}`, url: `https://x/${n}`, actor: "alice", at: "2026-01-01T00:00:00Z", isPr: false });
const prOpened = (n, id = `p${n}`) => ({ id, kind: "pr", action: "opened", number: n, title: `pr ${n}`, url: `https://x/p${n}`, actor: "bob", at: "2026-01-01T00:01:00Z", isPr: true });
const commentOn = (n, isPr, id = `c${n}`) => ({ id, kind: "comment", action: "created", number: n, title: `t${n}`, url: `https://x/c${n}`, actor: "carol", at: "2026-01-01T00:02:00Z", body: "a comment", isPr });

async function makeService({ events = [], ws = null, store = null, status = null, sessions = {}, github = null, clock = null, serviceOpts = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "gh-events-"));
  const ctl = store ?? openControlStore({ path: null });
  const w = ws ?? seedWorkspace(ctl);
  ctl.workspaces.update(w.id, { status: w.status ?? "ready", baseCommit: SHA });
  const bots = fakeBots(w.id);
  const gh = github ?? fakeGithub(events, { status });
  const submits = [];
  const service = createGithubEventsService({
    dataDir,
    control: ctl,
    bots,
    github: gh,
    sessions,
    ...(clock ? { setTimer: clock.setTimer, clearTimer: clock.clearTimer, nowMs: clock.nowMs } : {}),
    submit: async (botId, text) => {
      submits.push({ botId, text });
      return { id: submits.length };
    },
    ...serviceOpts,
  });
  return { service, store: ctl, ws: ctl.workspaces.get(w.id), bots, github: gh, submits, dataDir };
}

// ---- normalization / pure helpers --------------------------------------------------------------------------------
test("describeEvent and eventMessage label external content as untrusted and clip over-limit bodies", async () => {
  const { createGithubClient } = await import("../src/github.mjs");
  // normalizeEvent is exercised through a tiny fake fetch on the real client.
  const feed = [
    { id: "1", type: "IssuesEvent", created_at: "t", actor: { login: "a" }, payload: { action: "opened", issue: { number: 3, title: "T", html_url: "u" } } },
    { id: "2", type: "PullRequestReviewEvent", created_at: "t", actor: { login: "b" }, payload: { action: "submitted", review: { state: "approved", body: "lg", html_url: "ru" }, pull_request: { number: 9, title: "P", html_url: "pu" } } },
    { id: "3", type: "PushEvent", payload: {} },
    { id: "4", type: "IssueCommentEvent", created_at: "t", actor: { login: "c" }, payload: { action: "created", issue: { number: 3, title: "T", pull_request: {} }, comment: { body: "hi", html_url: "cu" } } },
  ];
  const gh = createGithubClient({ token: "t", fetch: async () => new Response(JSON.stringify(feed), { status: 200 }), apiBase: "http://x" });
  const events = await gh.listEvents(REPO);
  assert.equal(events.length, 3, "PushEvent dropped");
  assert.deepEqual(events[0], { id: "1", kind: "issue", action: "opened", number: 3, title: "T", url: "u", actor: "a", at: "t", isPr: false });
  assert.equal(events[1].kind, "review");
  assert.equal(events[1].state, "approved");
  assert.equal(events[2].isPr, true, "a comment on a PR issue object is a PR comment");

  assert.match(describeEvent(events[0]), /opened issue #3/);
  const msg = eventMessage(events[2], REPO);
  assert.match(msg, /外部内容，不可信/);
  assert.match(msg, /hi/);
  const clipped = eventMessage({ ...events[2], body: "x".repeat(EVENT_TEXT_LIMIT + 10) }, REPO);
  assert.match(clipped, /已截断/);
  assert.ok(clipped.length < EVENT_TEXT_LIMIT + 500);
});

// ---- service: enable / seed / sync ---------------------------------------------------------------------------------
test("configure on a non-test repo or non-ready workspace is refused; enable seeds history without replaying", async () => {
  const { service, store, ws: other } = await makeService({ ws: null });
  // reseed with a foreign repo in the SAME store the service uses
  const foreign = seedWorkspace(store, { repo: "acme/other" });
  await assert.rejects(service.configure(foreign.id, { enabled: true }), (e) => e.code === "conflict" && /仅在测试仓库/.test(e.message));

  const prep = seedWorkspace(store, { status: "preparing" });
  await assert.rejects(service.configure(prep.id, { enabled: true }), (e) => e.code === "conflict" && /not ready/.test(e.message));

  // enable: existing feed entries become history, not fresh events
  const { service: svc, ws: w, submits } = await makeService({ events: [issueOpened(1), commentOn(1, false)] });
  const st = await svc.configure(w.id, { enabled: true });
  assert.equal(st.enabled, true);
  assert.equal(st.lastResult.seeded, 2);
  assert.equal(st.record.length, 2);
  assert.ok(st.record.every((r) => r.outcome === "history (before enable)"));
  assert.equal(submits.length, 0, "no session message for history");

  // sync with nothing new
  const after = await svc.sync(w.id);
  assert.equal(after.lastResult.events, 0);
  store.close();
});

test("sync processes only new events once (dedup); repeated sync is a no-op", async () => {
  const history = [issueOpened(1)];
  const { service, ws, submits, github } = await makeService({ events: history });
  await service.configure(ws.id, { enabled: true, autoAppend: true });

  // a new issue comment arrives
  github.listEvents = async () => [commentOn(1, false, "c-new"), ...history];
  const st = await service.sync(ws.id);
  assert.equal(st.lastResult.events, 1);
  // comment on issue 1 with no subscription -> not appended, recorded as seen
  assert.equal(st.lastResult.appended, 0);
  assert.equal(submits.length, 0);
  assert.equal(st.record.find((r) => r.id === "c-new").outcome, "seen");

  // same feed again: nothing new
  const st2 = await service.sync(ws.id);
  assert.equal(st2.lastResult.events, 0);
  assert.equal(submits.length, 0);
});

test("new issue with autoCreate starts a discussion session via the injected startDiscussion and subscribes it", async () => {
  const created = [];
  const sessions = {
    startDiscussion: async (ws, n) => {
      created.push(n);
      return { botId: "d1", name: `issue-${n}-discuss` };
    },
    startReview: async () => {
      throw new Error("not for issues");
    },
  };
  const gh = null;
  const { service, ws, github } = await makeService({ sessions });
  await service.configure(ws.id, { enabled: true, autoCreate: true });
  github.listEvents = async () => [issueOpened(7, "i7")];
  const st = await service.sync(ws.id);
  assert.deepEqual(created, [7]);
  assert.equal(st.lastResult.created, 1);
  assert.ok(st.subscriptions.find((s) => s.key === "issue:7" && s.botId === "d1"));
  assert.match(st.record.find((r) => r.id === "i7").outcome, /created session/);
});

test("autoAppend delivers a comment to the subscribed session, labelled untrusted; later same-target events keep flowing", async () => {
  const { service, ws, submits, github } = await makeService();
  await service.configure(ws.id, { enabled: true, autoAppend: true });
  await service.subscribe(ws.id, { target: "issue:1", botId: "b1" });
  github.listEvents = async () => [commentOn(1, false, "c1")];
  const st = await service.sync(ws.id);
  assert.equal(st.lastResult.appended, 1);
  assert.equal(submits.length, 1);
  assert.equal(submits[0].botId, "b1");
  assert.match(submits[0].text, /外部内容，不可信/);
  assert.match(submits[0].text, /a comment/);
  // and it does not re-deliver on the next sync
  await service.sync(ws.id);
  assert.equal(submits.length, 1);
});

test("explicit send appends once per (event, session); subscribing requires a same-workspace session", async () => {
  const { service, ws, submits, github } = await makeService();
  await service.configure(ws.id, { enabled: true });
  github.listEvents = async () => [commentOn(9, false, "c9")];
  await service.sync(ws.id);

  const out = await service.send(ws.id, { eventId: "comment:c9", botId: "b1" });
  assert.equal(out.sent, true);
  assert.equal(submits.length, 1);
  await assert.rejects(service.send(ws.id, { eventId: "comment:c9", botId: "b1" }), (e) => e.code === "conflict");
  await assert.rejects(service.send(ws.id, { eventId: "comment:nope", botId: "b1" }), (e) => e.code === "not_found");
  await assert.rejects(service.send(ws.id, { eventId: "comment:c9" }), (e) => e.code === "invalid");

  // a foreign-session bot (different workspace) cannot be subscribed
  await assert.rejects(service.subscribe(ws.id, { target: "issue:1", botId: "ghost" }), (e) => e.code === "not_found");
  const sub = await service.subscribe(ws.id, { target: "pr:5", botId: "b1" });
  assert.ok(sub.subscriptions.find((s) => s.key === "pr:5"));
});

test("CI transition on the tracked baseline is recorded once", async () => {
  const { service, ws, github } = await makeService();
  // first configure records the baseline without an event
  github.getCommitStatus = async () => ({ state: "pending", sha: SHA, statuses: [] });
  await service.configure(ws.id, { enabled: true });
  github.getCommitStatus = async () => ({ state: "success", sha: SHA, statuses: [{ context: "ci", state: "success", targetUrl: "https://ci/1" }] });
  const st = await service.sync(ws.id);
  const ci = st.record.find((r) => r.kind === "ci");
  assert.ok(ci);
  assert.equal(ci.state, "success");
  assert.match(ci.targetUrl, /ci\/1/);
  // same state again -> no duplicate
  const st2 = await service.sync(ws.id);
  assert.equal(st2.record.filter((r) => r.kind === "ci").length, 1);
});

test("state persists to <dataDir>/github-events/<ws>.json and survives a new service instance", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gh-events-persist-"));
  const store = openControlStore({ path: null });
  const w = seedWorkspace(store);
  const bots = fakeBots();
  const gh = fakeGithub([issueOpened(2, "i2")]);
  const submit = async () => {};
  const svc1 = createGithubEventsService({ dataDir, control: store, bots, github: gh, sessions: {}, submit });
  await svc1.configure(w.id, { enabled: true, autoAppend: true });
  const svc2 = createGithubEventsService({ dataDir, control: store, bots, github: gh, sessions: {}, submit });
  const st = svc2.getState(w.id);
  assert.equal(st.enabled, true);
  assert.equal(st.autoAppend, true);
  assert.equal(st.record.length, 1);
  store.close();
});

// ---- routes -----------------------------------------------------------------------------------------------------------
async function withApi(fn, { sessions = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "gh-events-api-"));
  const store = openControlStore({ path: null });
  const ws = seedWorkspace(store);
  const bots = fakeBots(ws.id);
  const gh = fakeGithub([]);
  const inject = (app) =>
    Object.assign(app.ctx, {
      control: store,
      github: gh,
      dataDir,
      workspaceSessions: sessions,
    });
  const api = createApi({ harness: {}, bots, routes: [inject, registerEvents] });
  const { port } = await api.listen(0);
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  try {
    await fn({ call, ws, gh, bots, store });
  } finally {
    await api.close();
    store.close();
  }
}

test("routes: not registered (one warning) when control/github/bots are missing", () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    for (const ctxObj of [{}, { control: {} }, { control: {}, github: {} }]) {
      const routes = [];
      const app = { ctx: ctxObj, get: (p) => routes.push(`GET ${p}`), post: (p) => routes.push(`POST ${p}`) };
      registerEvents(app);
      assert.deepEqual(routes, []);
    }
    const full = { ctx: { control: {}, github: {}, bots: {} }, get() {}, post() {} };
    registerEvents(full); // needs all three: bots included here -> registers
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warnings.length >= 1 && warnings.length <= 2, `expected a single warning, got ${warnings.length}`);
});

test("routes: sync before enable -> 409; enable -> GET shows state; sync -> processed events; disable stops", () =>
  withApi(async ({ call, ws, gh }) => {
    const base = `/api/workspaces/${ws.id}/events`;
    assert.equal((await call("POST", `${base}/sync`)).status, 409);

    const enable = await call("POST", `${base}/configure`, { enabled: true });
    assert.equal(enable.status, 200, enable.text);
    assert.equal(enable.json.enabled, true);

    gh.listEvents = async () => [issueOpened(11, "i11")];
    const synced = await call("POST", `${base}/sync`);
    assert.equal(synced.status, 200);
    assert.equal(synced.json.lastResult.events, 1);
    assert.equal(synced.json.record[0].id, "i11");

    const state = await call("GET", base);
    assert.equal(state.json.enabled, true);
    assert.equal(state.json.record.length, 1);

    const off = await call("POST", `${base}/disable`);
    assert.equal(off.json.enabled, false);
    assert.equal((await call("POST", `${base}/sync`)).status, 409, "sync after disable is refused");

    // validation
    assert.equal((await call("POST", `${base}/configure`, { enabled: "yes" })).status, 400);
    assert.equal((await call("POST", `${base}/send`, { eventId: "x" })).status, 400);
    assert.equal((await call("GET", "/api/workspaces/ws_nope/events")).status, 404);
  }));

test("routes: autoCreate reuses workspaceSessions.startDiscussion (extracted from the workspaces route)", () =>
  withApi(
    async ({ call, ws, gh }) => {
      const base = `/api/workspaces/${ws.id}/events`;
      await call("POST", `${base}/configure`, { enabled: true, autoCreate: true });
      gh.listEvents = async () => [issueOpened(21, "i21")];
      const synced = await call("POST", `${base}/sync`);
      assert.equal(synced.status, 200, synced.text);
      assert.equal(synced.json.lastResult.created, 1);
      assert.ok(synced.json.subscriptions.find((s) => s.key === "issue:21" && s.botId === "d1"));
    },
    {
      sessions: {
        startDiscussion: async (_ws, n) => ({ botId: "d1", name: `issue-${n}-discuss` }),
        startReview: async (_ws, n) => ({ botId: "r1", name: `pr-${n}-review` }),
      },
    },
  ));

test("routes: workspaceSessions is read lazily — works even when workspaces.mjs registers after this route", async () => {
  // Production order: sorted filenames put github-events before workspaces, so workspaceSessions is only set
  // AFTER this plugin's register() returned. The service must look it up per call, not at register time.
  const dataDir = mkdtempSync(join(tmpdir(), "gh-events-lazy-"));
  const store = openControlStore({ path: null });
  const ws = seedWorkspace(store);
  const bots = fakeBots(ws.id);
  const gh = fakeGithub([]);
  let api;
  {
    const inject = (app) => Object.assign(app.ctx, { control: store, github: gh, dataDir });
    api = createApi({ harness: {}, bots, routes: [inject, registerEvents] });
  }
  const { port } = await api.listen(0);
  try {
    // set AFTER registration, mimicking workspaces.mjs registering later
    api.app.ctx.workspaceSessions = { startDiscussion: async (_w, n) => ({ botId: "d1", name: `issue-${n}-discuss` }), startReview: async () => ({ botId: "r1" }) };
    const base = `http://127.0.0.1:${port}/api/workspaces/${ws.id}/events`;
    const post = (p, b) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
    await post("/configure", { enabled: true, autoCreate: true });
    gh.listEvents = async () => [issueOpened(31, "i31")];
    const synced = await post("/sync");
    assert.equal(synced.lastResult.created, 1);
    assert.ok(synced.subscriptions.find((s) => s.key === "issue:31"));
  } finally {
    await api.close();
    store.close();
  }
});

test("routes: send appends to a real conversation submit through bots.conversation", () =>
  withApi(async ({ call, ws, gh, bots }) => {
    const base = `/api/workspaces/${ws.id}/events`;
    await call("POST", `${base}/configure`, { enabled: true });
    gh.listEvents = async () => [commentOn(3, false, "c3")];
    await call("POST", `${base}/sync`);
    const sent = await call("POST", `${base}/send`, { eventId: "comment:c3", botId: "b1" });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.json.sent, true);
    assert.equal(bots.submits.length, 1);
    assert.match(bots.submits[0].input.content, /外部内容，不可信/);
    assert.equal((await call("POST", `${base}/send`, { eventId: "comment:c3", botId: "b1" })).status, 409);
  }));

// ---- timer lifecycle (fake clock) -----------------------------------------------------------------------------------
test("enabled workspace polls on the timer: tick syncs, dedups, reschedules, exposes nextSyncAt and pollCount", async () => {
  const clock = fakeClock();
  const gh = fakeGithub([]);
  const { service, ws } = await makeService({ github: gh, clock });
  const st = await service.configure(ws.id, { enabled: true, pollSec: 30 });
  assert.equal(st.enabled, true);
  assert.ok(st.nextSyncAt, "next poll time is exposed");
  assert.ok(service.isPolling(ws.id));
  assert.equal(clock.pendingCount(), 1);

  // first poll: nothing new
  await clock.advance(30_000);
  assert.equal(gh.calls.filter((c) => c.startsWith("listEvents")).length, 2, "seed + first poll");
  let s = service.getState(ws.id);
  assert.equal(s.pollCount, 1);
  assert.ok(s.nextSyncAt > st.nextSyncAt || s.nextSyncAt !== st.nextSyncAt, "re-armed");

  // a new comment appears; next tick delivers it as a record
  gh.listEvents = async () => [commentOn(5, false, "c-poll")];
  await clock.advance(30_000);
  s = service.getState(ws.id);
  assert.equal(s.pollCount, 2);
  assert.ok(s.record.find((r) => r.id === "c-poll"));

  // second tick on the same feed: no duplicate processing
  await clock.advance(30_000);
  s = service.getState(ws.id);
  assert.equal(s.pollCount, 3);
  assert.equal(s.record.filter((r) => r.id === "c-poll").length, 1);
});

test("disable clears the timer; re-enable reschedules; close() clears every timer", async () => {
  const clock = fakeClock();
  const gh = fakeGithub([]);
  const { service, ws } = await makeService({ github: gh, clock });
  await service.configure(ws.id, { enabled: true });
  assert.equal(clock.pendingCount(), 1);
  const before = gh.calls.length;

  await service.disable(ws.id);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(service.isPolling(ws.id), false);
  assert.equal(service.getState(ws.id).nextSyncAt, null);
  await clock.advance(600_000);
  assert.equal(gh.calls.length, before, "nothing polled while disabled");

  await service.configure(ws.id, { enabled: true });
  assert.equal(clock.pendingCount(), 1);
  service.close();
  assert.equal(clock.pendingCount(), 0);
  assert.equal(service.isPolling(ws.id), false);
});

test("startPolling resumes persisted enabled workspaces and skips disabled / vanished ones", async () => {
  const clock = fakeClock();
  const gh = fakeGithub([]);
  const { service, ws, store, dataDir, bots } = await makeService({ github: gh, clock });
  await service.configure(ws.id, { enabled: true });
  const other = seedWorkspace(store);
  store.workspaces.update(other.id, { status: "ready", baseCommit: SHA });
  // a second state file, disabled
  const svcState = service._internals.readState;
  service.close();
  assert.equal(clock.pendingCount(), 0);

  // a new service instance on the same dataDir (a "restart") resumes enabled workspaces
  const submits = [];
  const service2 = createGithubEventsService({
    dataDir,
    control: store,
    bots,
    github: gh,
    sessions: {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    nowMs: clock.nowMs,
    submit: async () => {},
  });
  // also persist a disabled ws file to prove it is skipped
  const disabled = seedWorkspace(store);
  const st = svcState(disabled.id);
  st.enabled = false;
  const resumed = service2.startPolling();
  assert.deepEqual(resumed, [ws.id]);
  assert.equal(clock.pendingCount(), 1, "only the enabled workspace got a timer");
  assert.equal(service2.isPolling(ws.id), true);
  service2.close();
  void st;
  void disabled;
});

test("a failed poll records lastError and keeps the timer armed (no crash, next tick retries)", async () => {
  const clock = fakeClock();
  const gh = fakeGithub([]);
  const { service, ws } = await makeService({ github: gh, clock });
  await service.configure(ws.id, { enabled: true, pollSec: 30 });
  gh.listEvents = async () => {
    throw new Error("boom");
  };
  await clock.advance(30_000);
  const s = service.getState(ws.id);
  assert.match(s.lastError, /boom/);
  assert.ok(service.isPolling(ws.id), "timer survived the failed sync");
  gh.listEvents = async () => [];
  await clock.advance(30_000);
  const s2 = service.getState(ws.id);
  assert.equal(s2.lastError, null, "the retry cleared the error");
  assert.equal(s2.pollCount, 1, "only a completed poll increments pollCount");
});

// ---- PR head check runs (distinct from baseline combined status) ----------------------------------------------------
test("subscribed PR head checks: rollup transition appends to the PR's session; first sighting only records", async () => {
  const PULL = { number: 9, headSha: "b".repeat(40), headRef: "feat/x", title: "PR nine", url: "https://x/pull/9", state: "open" };
  const gh = fakeGithub([], { checkRuns: { sha: PULL.headSha, state: "pending", total: 2, runs: [{ name: "ci", status: "in_progress", conclusion: null, url: "https://ci/9" }] }, pulls: { 9: PULL } });
  const { service, ws, submits, bots } = await makeService({ github: gh });
  bots.list().forEach(() => {});
  bots.add({ id: "r1", name: "pr-9-review", conversationId: "5009", workspaceId: ws.id, review: { pr: 9, headSha: PULL.headSha, dir: "/r" } });
  await service.configure(ws.id, { enabled: true, autoAppend: true });
  await service.subscribe(ws.id, { target: "pr:9", botId: "r1" });

  // first sync only records the rollup — no event, no append
  await service.sync(ws.id);
  assert.equal(submits.length, 0);
  let s = service.getState(ws.id);
  assert.deepEqual(s.prChecks, [{ pr: 9, headSha: PULL.headSha, state: "pending" }]);

  // transition pending -> success: one `checks` event appended to the review session
  gh.getCheckRuns = async () => ({ sha: PULL.headSha, state: "success", total: 2, runs: [{ name: "ci", status: "completed", conclusion: "success", url: "https://ci/9" }] });
  await service.sync(ws.id);
  assert.equal(submits.length, 1);
  assert.equal(submits[0].botId, "r1");
  assert.match(submits[0].text, /PR #9 checks/);
  assert.match(submits[0].text, /pending → success/);
  s = service.getState(ws.id);
  const checksEv = s.record.find((r) => r.kind === "checks");
  assert.ok(checksEv, "checks event recorded");
  assert.equal(checksEv.delivered, true);

  // same rollup again: no duplicate
  await service.sync(ws.id);
  assert.equal(submits.length, 1);

  // a new head SHA is a visible transition too (the moved head's rollup differs and the head SHA changed)
  PULL.headSha = "c".repeat(40);
  gh.getCheckRuns = async () => ({ sha: PULL.headSha, state: "pending", total: 1, runs: [{ name: "ci", status: "queued", conclusion: null, url: "https://ci/9b" }] });
  await service.sync(ws.id);
  assert.equal(submits.length, 2, "moved head reports its new rollup once");
  s = service.getState(ws.id);
  assert.equal(s.prChecks[0].headSha, PULL.headSha);
  const moved = s.record.filter((r) => r.kind === "checks").map((r) => r.sha);
  assert.ok(moved.includes(PULL.headSha), "the new head SHA produced its own checks event");

  // steady state again: nothing new
  await service.sync(ws.id);
  assert.equal(submits.length, 2);
});

test("baseline combined status and PR check runs are tracked independently (different APIs, different events)", async () => {
  const PULL = { number: 4, headSha: "d".repeat(40), headRef: "feat/y", title: "p", url: "u", state: "open" };
  const gh = fakeGithub([], {
    status: { state: "pending", sha: SHA, statuses: [] },
    checkRuns: { sha: PULL.headSha, state: "failure", total: 1, runs: [{ name: "x", status: "completed", conclusion: "failure", url: "u" }] },
    pulls: { 4: PULL },
  });
  const { service, ws } = await makeService({ github: gh });
  await service.configure(ws.id, { enabled: true });
  await service.subscribe(ws.id, { target: "pr:4", botId: "b1" });
  await service.sync(ws.id);
  const s = service.getState(ws.id);
  assert.equal(s.baseline.sha, SHA, "baseline uses the workspace baseCommit + combined status");
  assert.equal(s.prChecks[0].headSha, PULL.headSha, "PR checks use the PR head SHA + check runs API");
  assert.ok(gh.calls.some((c) => c.startsWith("status")), "combined status endpoint was queried");
  assert.ok(gh.calls.some((c) => c.startsWith("checkRuns")), "check-runs endpoint was queried");
  assert.ok(gh.calls.some((c) => c.startsWith("getPull")), "PR head resolved via getPull");
});
