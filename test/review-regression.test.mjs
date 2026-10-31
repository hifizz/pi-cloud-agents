// Review/results regression tests (AMP13-review). Same offline rig as test/issue-loop.test.mjs: the real HTTP
// server (createApi), the real GitHub client on a fake fetch, a real in-memory control store, a fake Bot registry
// that records createBot specs and submissions, and a fake runtimeBash that records the worktree commands.
// No real Sprite, model or GitHub access.
//
// Covered (cheap, real-behavior):
//  - review reuse scope: a review session linked to the workspace but missing workspaceId still reuses
//    (cross-workspace double guard: no foreign match, no duplicate)
//  - diff retrieval failures fail the request: 404 -> 502, GitHub error -> mapped, oversized diff -> 409;
//    no worktree, no Bot, no submit ever runs without the diff
//  - an empty-string diff is sent labelled and never fabricated
//  - status/result writes are rejected for sessions of another workspace (cross-workspace information write protection)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { createGithubClient } from "../src/github.mjs";
import { register as registerWorkspaces } from "../src/routes/workspaces.mjs";

const TOKEN = "ghp_FAKEtoken0123456789abcdefghijklmnop";
const FAUX = { provider: "faux", modelId: "faux-1" };
const REPO = "hifizz/tars-sandbox-playground";
const MAIN_SHA = "3157db095cb9344e5b9cf0669657bf613d036b46";
const PR_SHA = "d".repeat(40);
const PR = { number: 5, title: "Add feature", body: "pr body", headSha: PR_SHA, headRef: "feat", baseRef: "main", baseSha: MAIN_SHA, diff: "diff --git a/f b/f\n+new\n" };

/** GitHub REST double: repo meta, branches, /pulls detail + diff (Accept: vnd.github.diff) and /pulls list.
 * `pulls` maps PR number -> record; `diffs` overrides per-PR diff responses ({status, text}). */
function fakeGithubApi({ branches = {}, defaultBranch = "main", pulls = {}, diffs = {} } = {}) {
  const st = { calls: [] };
  const reply = (status, data) => ({ status, headers: { get: () => null }, text: async () => (data === undefined ? "" : JSON.stringify(data)) });
  const rawReply = (status, text) => ({ status, headers: { get: () => null }, text: async () => text });
  const fetch = async (url, init) => {
    const u = new URL(url);
    st.calls.push(`${init.method} ${u.pathname}${u.search}`);
    let m;
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(u.pathname))) {
      return m[1] === REPO ? reply(200, { full_name: REPO, default_branch: defaultBranch }) : reply(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/branches$/.exec(u.pathname))) {
      return reply(200, Object.entries(branches).map(([name, sha]) => ({ name, commit: { sha } })));
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(u.pathname))) {
      const n = Number(m[2]);
      const p = pulls[n];
      if (String(init.headers.Accept).includes("vnd.github.diff")) {
        const d = diffs[n];
        if (d) return rawReply(d.status, d.text);
        return p ? rawReply(200, p.diff ?? "diff --git a/x b/x\n") : reply(404, { message: "Not Found" });
      }
      if (!p) return reply(404, { message: "Not Found" });
      return reply(200, {
        number: p.number,
        title: p.title,
        body: p.body ?? "",
        html_url: `https://github.com/${REPO}/pull/${p.number}`,
        state: p.state ?? "open",
        user: { login: "fizz" },
        head: { ref: p.headRef ?? "feature", sha: p.headSha },
        base: { ref: p.baseRef ?? "main", sha: p.baseSha ?? MAIN_SHA },
      });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(u.pathname))) {
      return reply(200, []);
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(u.pathname))) {
      return reply(200, []);
    }
    return reply(404, { message: "Not Found" });
  };
  return { st, fetch };
}

/** Bot registry double: records every createBot spec and every submitted first message. `update` mirrors the real
 * BotRegistry.update semantics: only status/executionResult are writable; undefined removes nothing, null deletes. */
function fakeBots() {
  const records = [];
  const created = [];
  const submits = new Map();
  const registry = {
    created,
    submits,
    records,
    list: () => [...records],
    get: (id) => records.find((b) => b.id === id || b.name === id),
    update: (id, patch) => {
      const bot = registry.get(id);
      if (!bot) return undefined;
      for (const key of ["status", "executionResult"]) {
        if (key in patch) {
          if (patch[key] === null) delete bot[key];
          else bot[key] = patch[key];
        }
      }
      return bot;
    },
    async createBot(spec) {
      const bot = { id: `bot${records.length + 1}`, name: spec.name, conversationId: 5000 + records.length, model: spec.model, cwd: spec.cwd, ...spec };
      records.push(bot);
      created.push(spec);
      return bot;
    },
    async conversation(id) {
      const bot = registry.get(id);
      return {
        id: bot.conversationId,
        async submit(input) {
          if (!submits.has(bot.id)) submits.set(bot.id, []);
          submits.get(bot.id).push(input);
          return { id: `${bot.id}-sub${submits.get(bot.id).length}` };
        },
      };
    },
  };
  return registry;
}

/** runtimeBash double: records commands; worktree commands return empty success. */
function fakeRuntimeBash() {
  const calls = [];
  const bash = async (command) => {
    calls.push(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { calls, bash };
}

async function makeEnv({ branches = { main: MAIN_SHA }, pulls, diffs } = {}) {
  const store = openControlStore({ path: null });
  const gh = fakeGithubApi({ branches, pulls, diffs });
  const github = createGithubClient({ token: TOKEN, fetch: gh.fetch });
  const bots = fakeBots();
  const rt = fakeRuntimeBash();

  const project = store.projects.upsert({ repo: REPO, defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "seed-rr",
    projectId: project.id,
    name: "review ws",
    baseBranch: "main",
    branch: "tarsbot/ws-abc123",
    cwd: "/home/sprite/workspace/tars-sandbox-playground",
    model: FAUX,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-eae56f671c" });

  const inject = (app) =>
    Object.assign(app.ctx, {
      workspaces: { get: (id) => store.workspaces.get(id), list: () => store.workspaces.list(), create: async () => workspace, retry: async () => workspace },
      github,
      control: store,
      runtimeBash: () => rt.bash,
    });
  const api = createApi({ harness: {}, bots, routes: [inject, registerWorkspaces] });
  const { port } = await api.listen(0);
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    assert.ok(!text.includes(TOKEN), `response leaks token: ${text.slice(0, 200)}`);
    assert.ok(!text.includes(tmpdir()), "response carries a server path");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  return {
    store,
    gh,
    github,
    bots,
    rt,
    ws: workspace,
    call,
    post: (p, b) => call("POST", p, b),
    async close() {
      await api.close();
      store.close();
    },
  };
}

// ---- reuse scope ----------------------------------------------------------------------------------------------------

test("review reuse: a same-workspace review session found via the conversation link (workspaceId lost) still reuses — no duplicate", async () => {
  const env = await makeEnv({ pulls: { 5: { ...PR } } });
  try {
    // Simulate a review session whose Bot record lost workspaceId (e.g. an older record adopted via the link only).
    // The conversation link says it belongs to this workspace.
    env.bots.records.push({
      id: "r-old",
      name: "pr-5-review",
      conversationId: "8805",
      model: FAUX,
      // no workspaceId: only the link associates it
      review: { pr: 5, title: "Add feature", baseBranch: "main", headSha: PR_SHA, dir: "/home/sprite/reviews/old/pr-5-x" },
    });
    env.store.links.link({ conversationId: "8805", workspaceId: env.ws.id, botId: "r-old" });

    const r = await env.post(`/api/workspaces/${env.ws.id}/review`, { pr: 5 });
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(r.json.review.reused, true, "a linked review session must be reused, not duplicated");
    assert.equal(r.json.review.botId, "r-old");
    assert.equal(r.json.review.dir, "/home/sprite/reviews/old/pr-5-x", "the recorded dir is returned");
    assert.equal(env.bots.created.length, 0, "no second review session was created");
    assert.equal(env.rt.calls.length, 0, "no worktree / fetch ran again");
  } finally {
    await env.close();
  }
});

test("review reuse: a review session of ANOTHER workspace never matches, even with the same PR + head SHA", async () => {
  const env = await makeEnv({ pulls: { 5: { ...PR } } });
  try {
    // A second workspace in the same repo with its own review of the same PR head.
    const otherProject = env.store.projects.upsert({ repo: REPO, defaultBranch: "main" });
    const { workspace: foreign } = env.store.workspaces.create({
      requestId: "seed-rr2",
      projectId: otherProject.id,
      name: "other ws",
      baseBranch: "main",
      branch: "tarsbot/ws-other",
      cwd: "/home/sprite/workspace/tars-sandbox-playground",
      model: FAUX,
    });
    env.store.workspaces.update(foreign.id, { status: "ready" });
    env.store.bindings.bind(foreign.id, { provider: "sprites", runtimeId: "pca-other00000" });
    env.bots.records.push({
      id: "r-foreign",
      name: "pr-5-review",
      conversationId: "8806",
      model: FAUX,
      workspaceId: foreign.id,
      review: { pr: 5, title: "Add feature", baseBranch: "main", headSha: PR_SHA, dir: "/home/sprite/reviews/foreign/pr-5-y" },
    });
    env.store.links.link({ conversationId: "8806", workspaceId: foreign.id, botId: "r-foreign" });

    const r = await env.post(`/api/workspaces/${env.ws.id}/review`, { pr: 5 });
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(r.json.review.reused, false, "a foreign review session must not be reused here");
    assert.notEqual(r.json.review.botId, "r-foreign");
    assert.equal(env.bots.created.length, 1, "this workspace gets its own review session");
  } finally {
    await env.close();
  }
});

// ---- diff retrieval failures fail the request -----------------------------------------------------------------------

test("review: a missing diff (404 on the diff endpoint) fails the request — no session, no worktree, no empty diff", async () => {
  const env = await makeEnv({ pulls: { 5: { ...PR } }, diffs: { 5: { status: 404, text: "" } } });
  try {
    const r = await env.post(`/api/workspaces/${env.ws.id}/review`, { pr: 5 });
    assert.equal(r.status, 502, `diff retrieval failure must fail the request, got ${r.status}: ${r.text}`);
    assert.match(r.json.error, /diff/i, "the error says the diff could not be fetched");
    assert.equal(env.bots.created.length, 0, "no review session was created without the diff");
    assert.equal(env.rt.calls.length, 0, "no worktree was added without the diff");
    assert.equal(env.bots.submits.size, 0, "no first message was sent");
  } finally {
    await env.close();
  }
});

test("review: a GitHub failure on the diff endpoint surfaces as a request failure, never an empty diff", async () => {
  const env = await makeEnv({ pulls: { 5: { ...PR } }, diffs: { 5: { status: 500, text: JSON.stringify({ message: "boom" }) } } });
  try {
    const r = await env.post(`/api/workspaces/${env.ws.id}/review`, { pr: 5 });
    assert.ok(r.status >= 400, `expected an error, got ${r.status}`);
    assert.equal(env.bots.created.length, 0);
    assert.equal(env.rt.calls.length, 0);
  } finally {
    await env.close();
  }
});

test("review: an over-limit diff fails the request with an explicit error — never silently truncated", async () => {
  const big = "x".repeat(400_001);
  const env = await makeEnv({ pulls: { 5: { ...PR } }, diffs: { 5: { status: 200, text: big } } });
  try {
    const r = await env.post(`/api/workspaces/${env.ws.id}/review`, { pr: 5 });
    assert.equal(r.status, 409, `oversized diff must be an explicit 409, got ${r.status}: ${r.text.slice(0, 200)}`);
    assert.equal(env.bots.created.length, 0, "no session was created from a truncated diff");
    assert.equal(env.rt.calls.length, 0, "no worktree was added");
    // the giant diff text never reaches a response
    assert.ok(!r.text.includes(big.slice(0, 1000)), "the diff body is not echoed into the error");
  } finally {
    await env.close();
  }
});

test("review: an empty-string diff is sent labelled as 空, never fabricated", async () => {
  const env = await makeEnv({ pulls: { 5: { ...PR } }, diffs: { 5: { status: 200, text: "" } } });
  try {
    const r = await env.post(`/api/workspaces/${env.ws.id}/review`, { pr: 5 });
    assert.equal(r.status, 200, r.json?.error);
    const msg = env.bots.submits.get(r.json.review.botId)[0].content;
    assert.match(msg, /（diff 为空）/, "an empty diff is stated as empty, not fabricated");
  } finally {
    await env.close();
  }
});

// ---- cross-workspace write protection (status / result) --------------------------------------------------------------

test("status: a session of another workspace cannot be re-labelled through this workspace's route", async () => {
  const env = await makeEnv();
  try {
    const otherProject = env.store.projects.upsert({ repo: REPO, defaultBranch: "main" });
    const { workspace: foreign } = env.store.workspaces.create({
      requestId: "seed-rr3",
      projectId: otherProject.id,
      name: "other ws",
      baseBranch: "main",
      branch: "tarsbot/ws-other",
      cwd: "/home/sprite/workspace/tars-sandbox-playground",
      model: FAUX,
    });
    env.store.workspaces.update(foreign.id, { status: "ready" });
    env.store.bindings.bind(foreign.id, { provider: "sprites", runtimeId: "pca-other00000" });
    env.bots.records.push({ id: "b-foreign", name: "foreign session", conversationId: "8807", model: FAUX, workspaceId: foreign.id });
    env.store.links.link({ conversationId: "8807", workspaceId: foreign.id, botId: "b-foreign" });

    const r = await env.post(`/api/workspaces/${env.ws.id}/sessions/b-foreign/status`, { status: "done" });
    assert.equal(r.status, 409, "a session of another workspace cannot be re-labelled here");
    assert.equal(env.bots.get("b-foreign").status, undefined, "no status was written");
  } finally {
    await env.close();
  }
});
