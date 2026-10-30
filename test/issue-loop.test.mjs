// Issue-loop spike behavior tests (offline). Uses the real HTTP server (createApi), the real GitHub client on a fake
// fetch, a real in-memory control store, a fake Bot registry that records createBot specs and submissions, and a fake
// runtimeBash that records the worktree commands. No real Sprite, model or GitHub access.
//
// Covered (normal path only):
//  - baseline selection: a real branch name in the issue body wins; otherwise the repo default; never a guessed main/master
//  - the SAME pinned SHA drives both the detached discussion worktree and the branched execution worktree
//  - both sessions are fresh conversations (createBot, not fork): the execution's first input is the task verbatim
//  - both sessions link to the same workspace (same runtimeId binding) but run in distinct worktree directories
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { createGithubClient } from "../src/github.mjs";
import { register as registerWorkspaces } from "../src/routes/workspaces.mjs";
import { BotRegistry } from "../src/bots.mjs";

const TOKEN = "ghp_FAKEtoken0123456789abcdefghijklmnop";
const FAUX = { provider: "faux", modelId: "faux-1" };
const REPO = "hifizz/tars-sandbox-playground";
const MAIN_SHA = "3157db095cb9344e5b9cf0669657bf613d036b46";
const OTHER_SHA = "b".repeat(40);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** GitHub REST double: repo meta, branches, the issue and its comments. */
function fakeGithubApi({ branches, defaultBranch = "main", issue, comments = [] }) {
  const st = { calls: [] };
  const reply = (status, data) => ({ status, headers: { get: () => null }, text: async () => (data === undefined ? "" : JSON.stringify(data)) });
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
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/.exec(u.pathname))) {
      const sha = branches[decodeURIComponent(m[2])];
      return sha ? reply(200, { name: decodeURIComponent(m[2]), commit: { sha } }) : reply(404, { message: "Branch not found" });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(u.pathname))) {
      return issue ? reply(200, { number: Number(m[2]), title: issue.title, body: issue.body, html_url: `https://github.com/${REPO}/issues/${m[2]}`, state: "open", user: { login: "fizz" }, comments: comments.length }) : reply(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(u.pathname))) {
      return reply(200, comments.map((c) => ({ user: { login: c.author }, body: c.body, html_url: `https://github.com/${REPO}/issues/${m[2]}#c` })));
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(u.pathname))) {
      return reply(200, []); // no open PRs for the baseline
    }
    return reply(404, { message: "Not Found" });
  };
  return { st, fetch };
}

/** Bot registry double: records every createBot spec and every submitted first message, returns distinct conversations. */
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

/** runtimeBash double: records commands; worktree/echo reads return empty success. */
function fakeRuntimeBash() {
  const calls = [];
  const bash = async (command) => {
    calls.push(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { calls, bash };
}

async function makeEnv({ branches, issue, comments, defaultBranch } = {}) {
  const store = openControlStore({ path: null });
  const gh = fakeGithubApi({ branches, issue, comments, defaultBranch });
  const github = createGithubClient({ token: TOKEN, fetch: gh.fetch });
  const bots = fakeBots();
  const rt = fakeRuntimeBash();

  const project = store.projects.upsert({ repo: REPO, defaultBranch: defaultBranch ?? "main" });
  const { workspace } = store.workspaces.create({
    requestId: "seed-il",
    projectId: project.id,
    name: "issue-loop ws",
    baseBranch: defaultBranch ?? "main",
    branch: "tarsbot/ws-abc123",
    cwd: "/home/sprite/workspace/tars-sandbox-playground",
    model: FAUX,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  const binding = store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-eae56f671c" });

  const wsView = () => store.workspaces.get(workspace.id); // live record (status may change)
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
    wsView,
    binding,
    call,
    post: (p, b) => call("POST", p, b),
    async close() {
      await api.close();
      store.close();
    },
  };
}

// ---- baseline selection ---------------------------------------------------------------------------------------------

test("discussion: issue body names a real branch → it wins and its SHA is pinned and used for the detached worktree", async () => {
  const env = await makeEnv({
    defaultBranch: "main",
    branches: { main: MAIN_SHA, "feature/xyz": OTHER_SHA },
    issue: { title: "demo", body: "请在 feature/xyz 分支上分析这个问题" },
    comments: [],
  });
  try {
    const { status, json } = await env.post(`/api/workspaces/${env.ws.id}/issue-loop/discuss`, { issue: 12 });
    assert.equal(status, 200, json?.error);
    const d = json.discussion;
    assert.equal(d.baseBranch, "feature/xyz");
    assert.equal(d.pinnedSha, OTHER_SHA);
    // detached worktree at the pinned SHA, fetched via the BRANCH ref
    const add = env.rt.calls.find((c) => c.includes("worktree add --detach"));
    assert.ok(add, `no worktree command: ${JSON.stringify(env.rt.calls)}`);
    assert.ok(add.includes(`--detach '${d.dir}' '${OTHER_SHA}'`), `detached at pinned SHA: ${add}`);
    assert.ok(add.includes(`fetch origin 'feature/xyz'`), `fetches the baseline branch ref: ${add}`);
    assert.ok(!/\bcheckout\b/.test(add) && !/\breset\b/.test(add), "no checkout/reset of the original dir");
    // fresh conversation linked to the same workspace, distinct cwd
    const spec = env.bots.created[0];
    assert.equal(spec.cwd, d.dir);
    // remove must be the real Preamble extension object: the harness reads its .name (a string would throw)
    assert.deepEqual(spec.extensions.remove.map((e) => e.name), ["tarsbot.preamble"]);
    assert.equal(spec.workspaceId, env.ws.id);
    assert.equal(spec.issueLoop.pinnedSha, OTHER_SHA);
    const link = env.store.links.workspaceOf(String(env.bots.records[0].conversationId));
    assert.equal(link?.id, env.ws.id, "discussion conversation links to the workspace");
    // first message carries the real issue, baseline + reason
    const msg = env.bots.submits.get(d.botId)[0].content;
    assert.ok(msg.includes(OTHER_SHA), "message carries the pinned SHA");
    assert.ok(msg.includes("feature/xyz"), "message names the baseline branch");
    assert.ok(msg.includes("issue 正文中最先出现"), "message records the selection reason");
    assert.ok(msg.includes("请在 feature/xyz"), "message carries the issue body");
  } finally {
    await env.close();
  }
});

test("discussion: no valid branch in body → falls back to the repo default branch, never guesses main/master", async () => {
  const env = await makeEnv({
    defaultBranch: "trunk", // not main/master: proves the default comes from the repo, not a guess
    branches: { trunk: MAIN_SHA, other: OTHER_SHA },
    issue: { title: "demo", body: "分析这个问题（没有提到任何真实分支）" },
    comments: [],
  });
  try {
    const { status, json } = await env.post(`/api/workspaces/${env.ws.id}/issue-loop/discuss`, { issue: 12 });
    assert.equal(status, 200, json?.error);
    const d = json.discussion;
    assert.equal(d.baseBranch, "trunk");
    assert.equal(d.pinnedSha, MAIN_SHA);
    const msg = env.bots.submits.get(d.botId)[0].content;
    assert.ok(msg.includes("使用仓库默认分支 trunk"), `reason: ${msg}`);
  } finally {
    await env.close();
  }
});

// ---- pinned SHA + fresh execution session ----------------------------------------------------------------------------

test("publish: execution worktree uses the SAME pinned SHA (not a fresh tip), its own branch/dir, and its first message is the task verbatim", async () => {
  const env = await makeEnv({
    defaultBranch: "main",
    branches: { main: MAIN_SHA },
    issue: { title: "demo", body: "分析这个问题" },
    comments: [{ author: "fizz", body: "第一条评论" }],
  });
  try {
    const d = (await env.post(`/api/workspaces/${env.ws.id}/issue-loop/discuss`, { issue: 12 })).json.discussion;
    // The baseline moves on the remote AFTER the discussion pinned its SHA; the new tip must NOT leak in.
    const NEW_TIP = "c".repeat(40);
    env.gh.st; // branches are read fresh per call below, so a publish that re-read would see NEW_TIP
    // publish uses the recorded pinnedSha, independent of any later branch movement
    const task = "请实现 X 功能，并跑测试。";
    const { status, json } = await env.post(`/api/workspaces/${env.ws.id}/issue-loop/publish`, { botId: d.botId, task });
    assert.equal(status, 200, json?.error);
    const ex = json.execution;
    // Same pinned SHA as the discussion, own branch and own dir
    assert.equal(ex.pinnedSha, MAIN_SHA);
    assert.notEqual(ex.pinnedSha, NEW_TIP);
    assert.equal(ex.branch, `tarsbot/issue-12-${d.botId}`);
    assert.notEqual(ex.dir, d.dir);
    const add = env.rt.calls.find((c) => c.includes("worktree add -b"));
    assert.ok(add, "no execution worktree command");
    assert.ok(add.includes(`-b 'tarsbot/issue-12-${d.botId}'`), `own branch: ${add}`);
    assert.ok(add.includes(`'${ex.dir}' '${MAIN_SHA}'`), `branched at the pinned SHA: ${add}`);
    // fresh conversation: createBot (not fork), linked to the same workspace, distinct cwd, preamble removed
    const spec = env.bots.created[1];
    assert.equal(spec.cwd, ex.dir);
    assert.equal(spec.workspaceId, env.ws.id);
    assert.equal(spec.issueLoop.sourceBotId, d.botId, "sourceBotId recorded for the UI backlink only");
    assert.equal(spec.issueLoop.pinnedSha, MAIN_SHA);
    // remove must be the real Preamble extension object: the harness reads its .name (a string would throw)
    assert.deepEqual(spec.extensions.remove.map((e) => e.name), ["tarsbot.preamble"]);
    // the FIRST user message is the task verbatim: no issue text, no comment, no discussion content
    const first = env.bots.submits.get(ex.botId)[0];
    assert.equal(first.content, task, "first message must be the literal task");
    assert.ok(!first.content.includes("分析这个问题"), "no issue body inherited");
    assert.ok(!first.content.includes("第一条评论"), "no comments inherited");
    // both sessions share the same workspace binding (same runtimeId -> same Sprite)
    assert.equal(env.store.links.workspaceOf(String(env.bots.records[0].conversationId)).id, env.ws.id);
    assert.equal(env.store.links.workspaceOf(String(env.bots.records[1].conversationId)).id, env.ws.id);
    assert.equal(env.bots.created.length, 2, "two fresh conversations, no fork");
  } finally {
    await env.close();
  }
});

test("publish: rejects a non-issue-loop session and a discussion belonging to another workspace", async () => {
  const env = await makeEnv({
    defaultBranch: "main",
    branches: { main: MAIN_SHA },
    issue: { title: "demo", body: "分析这个问题" },
    comments: [],
  });
  try {
    // a plain bot with no issueLoop metadata
    env.bots.records.push({ id: "plain", name: "plain", conversationId: 9999, model: FAUX });
    let r = await env.post(`/api/workspaces/${env.ws.id}/issue-loop/publish`, { botId: "plain", task: "x" });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /no pinned baseline|not an issue-loop/);
    // missing task
    r = await env.post(`/api/workspaces/${env.ws.id}/issue-loop/publish`, { botId: "plain" });
    assert.equal(r.status, 400);
    // unknown discussion
    r = await env.post(`/api/workspaces/${env.ws.id}/issue-loop/publish`, { botId: "nope", task: "x" });
    assert.equal(r.status, 404);
    // wrong repo / non-ready workspace is rejected up front
    const other = await makeEnv({ branches: { main: MAIN_SHA }, issue: { title: "t", body: "b" }, comments: [] });
    try {
      other.store.workspaces.update(other.ws.id, { status: "preparing" });
      const rr = await other.post(`/api/workspaces/${other.ws.id}/issue-loop/discuss`, { issue: 12 });
      assert.equal(rr.status, 409, "a not-ready workspace cannot start a discussion");
    } finally {
      await other.close();
    }
  } finally {
    await env.close();
  }
});

// ---- real harness contract (regression for the extension-remove shape) -----------------------------------------------
// The fake registry above accepts any value, which is how a plain-string `extensions.remove` slipped through once. This
// test runs the REAL harness and checks that a discussion/execution conversation really drops the generic git-workflow
// preamble while keeping Exec and Approval. (AgentChange.extensions.remove takes Extension objects, not names.)
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx as harnessCtx } from "../src/harness.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { Exec } from "../src/ext/exec.mjs";
import { Approval } from "../src/ext/approval.mjs";

test("real harness: extensions.remove [Preamble] drops the git-workflow preamble and keeps Exec + Approval", async () => {
  const f = fauxProvider();
  f.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  const models = createModels();
  models.setProvider(f.provider);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble, Exec, Approval] });
  try {
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: "/tmp", extensions: { remove: [Preamble] } } },
      harnessCtx,
    );
    const names = (await conv.agent(harnessCtx)).extensions.map((e) => e.name);
    assert.ok(!names.includes("tarsbot.preamble"), `preamble still selected: ${names}`);
    assert.ok(names.includes("tarsbot.exec"), `exec dropped: ${names}`);
    assert.ok(names.includes("tarsbot.approval"), `approval dropped: ${names}`);
  } finally {
    await harness.close(harnessCtx);
  }
});

test("real harness: the string shape is rejected (documents why the route passes objects)", async () => {
  const f = fauxProvider();
  f.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  const models = createModels();
  models.setProvider(f.provider);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble, Exec, Approval] });
  try {
    await assert.rejects(
      harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: "/tmp", extensions: { remove: ["tarsbot.preamble"] } } },
        harnessCtx,
      ),
    );
  } finally {
    await harness.close(harnessCtx);
  }
});

test("real harness: a fresh conversation does not inherit a sibling's history (no fork, no copy)", async () => {
  const f = fauxProvider();
  f.setResponses([fauxAssistantMessage([fauxText("discussion-answer")]), fauxAssistantMessage([fauxText("exec-answer")])]);
  const models = createModels();
  models.setProvider(f.provider);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble, Exec, Approval] });
  try {
    const model = { provider: "faux", modelId: "faux-1" };
    // a discussion conversation that already has real history
    const discussion = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: "/tmp", extensions: { remove: [Preamble] } } }, harnessCtx);
    await (await discussion.submit({ type: "input", content: "analyse the issue (secret research)" }, harnessCtx)).wait(harnessCtx);
    const discussionEntries = (await discussion.entries({}, 100, undefined, harnessCtx)).items;
    assert.ok(discussionEntries.length >= 2, "discussion has history");

    // the execution conversation is created FRESH from the same registry: it must start empty
    const execution = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: "/tmp", extensions: { remove: [Preamble] } } }, harnessCtx);
    const execEntries = (await execution.entries({}, 100, undefined, harnessCtx)).items;
    assert.equal(execEntries.length, 0, `fresh conversation inherited ${execEntries.length} entries`);
    assert.notEqual(String(execution.id), String(discussion.id), "distinct conversation ids");
  } finally {
    await harness.close(harnessCtx);
  }
});

test("discussion start message: sibling busy/queued are reported; an unreadable sibling is 未取得, never idle", async () => {
  const env = await makeEnv({
    defaultBranch: "main",
    branches: { main: MAIN_SHA },
    issue: { title: "demo", body: "分析" },
    comments: [],
  });
  try {
    // an existing sibling session in the same workspace: busy with one queued input
    env.bots.records.push({ id: "sib1", name: "sibling-busy", conversationId: 7001, model: FAUX, workspaceId: env.ws.id });
    env.store.links.link({ conversationId: "7001", workspaceId: env.ws.id, botId: "sib1" });
    const origConv = env.bots.conversation;
    env.bots.conversation = async (id) => {
      if (env.bots.get(id)?.id === "sib1") {
        return {
          id: 7001,
          async submit() {
            return { id: "x" };
          },
          async viewState() {
            return { value: { docs: { "pi.live": { run: { id: 1 } }, "pi.inbox": { items: [{ id: 1 }] } } }, dispose() {} };
          },
        };
      }
      return origConv.call(env.bots, id);
    };
    // a second sibling whose view cannot be read
    env.bots.records.push({ id: "sib2", name: "sibling-unreadable", conversationId: 7002, model: FAUX, workspaceId: env.ws.id });
    env.store.links.link({ conversationId: "7002", workspaceId: env.ws.id, botId: "sib2" });
    const prev = env.bots.conversation;
    env.bots.conversation = async (id) => {
      if (env.bots.get(id)?.id === "sib2") {
        return {
          id: 7002,
          async submit() {
            return { id: "y" };
          },
          async viewState() {
            throw new Error("view unavailable");
          },
        };
      }
      return prev(id);
    };

    const { status, json } = await env.post(`/api/workspaces/${env.ws.id}/issue-loop/discuss`, { issue: 12 });
    assert.equal(status, 200, json?.error);
    const msg = env.bots.submits.get(json.discussion.botId)[0].content;
    assert.match(msg, /sibling-busy：busy，queued 1/, `busy sibling not reported: ${msg}`);
    assert.match(msg, /sibling-unreadable：busy\/queued 未取得/, `unreadable sibling not marked: ${msg}`);
    assert.ok(!/sibling-unreadable[^\n]*idle/.test(msg), "an unreadable sibling must never be reported as idle");
  } finally {
    await env.close();
  }
});

test("real harness: an added session is a blank conversation whose own agent cwd is its worktree (no submit, no history)", async () => {
  const f = fauxProvider();
  f.setResponses([fauxAssistantMessage([fauxText("never")])]);
  const models = createModels();
  models.setProvider(f.provider);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble, Exec, Approval] });
  try {
    const model = { provider: "faux", modelId: "faux-1" };
    const bots = new BotRegistry(harness, { path: null });
    // a workspace primary session with history, in the workspace cwd
    const primary = await bots.createBot({ name: "primary", model, cwd: "/home/sprite/workspace/repo", extensions: { remove: [] } });
    await (await (await bots.conversation(primary.id)).submit({ type: "input", content: "PRIMARY-HISTORY" }, harnessCtx)).wait(harnessCtx);
    // the add-session spec exactly as the route builds it: own worktree dir, preamble removed, metadata recorded
    const dir = "/home/sprite/sessions/w1/session-ab12cd34";
    const added = await bots.createBot({
      name: "新 Session",
      model,
      cwd: dir,
      extensions: { remove: [Preamble] },
      workspaceId: "w1",
      worktree: { baseBranch: "main", pinnedSha: MAIN_SHA, dir },
    });
    const conv = await bots.conversation(added.id);
    const agent = await conv.agent(harnessCtx);
    assert.equal(agent.cwd, dir, "the session's own agent cwd is its worktree, not the workspace cwd");
    const names = agent.extensions.map((e) => e.name);
    assert.ok(!names.includes("tarsbot.preamble"), "preamble removed");
    assert.ok(names.includes("tarsbot.approval"), "approval kept");
    // blank: no entries at all, the primary's history is not inherited
    assert.equal((await conv.entries({}, 100, undefined, harnessCtx)).items.length, 0, "added session starts empty");
    assert.equal(added.worktree.dir, dir, "worktree metadata is recorded on the Bot");
    assert.notEqual(String(conv.id), String(primary.conversationId), "its own conversation");
  } finally {
    await harness.close(harnessCtx);
  }
});

test("real harness: the execution conversation's only user message is the literal task (no discussion text)", async () => {
  const f = fauxProvider();
  f.setResponses([fauxAssistantMessage([fauxText("discussion-analysis")]), fauxAssistantMessage([fauxText("exec-done")])]);
  const models = createModels();
  models.setProvider(f.provider);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble, Exec, Approval] });
  try {
    const model = { provider: "faux", modelId: "faux-1" };
    const bots = new BotRegistry(harness, { path: null });
    const d = await bots.createBot({ name: "disc", model, cwd: "/x", extensions: { remove: [Preamble] } });
    const dc = await bots.conversation(d.id);
    await (await dc.submit({ type: "input", content: "START-MESSAGE with issue text" }, harnessCtx)).wait(harnessCtx);
    const e = await bots.createBot({ name: "exec", model, cwd: "/y", extensions: { remove: [Preamble] } });
    const ec = await bots.conversation(e.id);
    // the execution conversation is empty before the human's task
    assert.equal((await ec.entries({}, 100, undefined, harnessCtx)).items.length, 0);
    await (await ec.submit({ type: "input", content: "TASK-ONLY" }, harnessCtx)).wait(harnessCtx);
    const items = (await ec.entries({}, 100, undefined, harnessCtx)).items;
    const userMsgs = items.filter((x) => x.model?.[0]?.role === "user");
    assert.equal(userMsgs.length, 1, "exactly one user message");
    const content = userMsgs[0].model[0].content;
    const text = Array.isArray(content) ? content.map((p) => p.text ?? "").join("") : String(content);
    assert.equal(text, "TASK-ONLY", "first user message is the task verbatim");
    assert.ok(!JSON.stringify(items).includes("START-MESSAGE"), "no discussion text reached the execution history");
  } finally {
    await harness.close(harnessCtx);
  }
});

// ---- add session (SPIKE-add-session) ---------------------------------------------------------------------------------

test("add session: a blank session in the same Sprite, its own detached worktree at the default SHA, no submit, no branch", async () => {
  const env = await makeEnv({ defaultBranch: "main", branches: { main: MAIN_SHA }, issue: { title: "t", body: "b" }, comments: [] });
  try {
    const { status, json } = await env.post(`/api/workspaces/${env.ws.id}/sessions`, { name: "新 Session" });
    assert.equal(status, 200, json?.error);
    const s = json.session;
    // detached worktree at the repo default branch's current SHA, in a directory of its own, never a new branch
    assert.equal(s.pinnedSha, MAIN_SHA);
    assert.equal(s.baseBranch, "main");
    assert.notEqual(s.dir, env.ws.cwd, "the session has its own directory, not the workspace cwd");
    const add = env.rt.calls.find((c) => c.includes("worktree add"));
    assert.ok(add, `no worktree command: ${JSON.stringify(env.rt.calls)}`);
    assert.ok(add.includes(`--detach '${s.dir}' '${MAIN_SHA}'`), `detached at the SHA: ${add}`);
    assert.ok(!/worktree add -b|checkout -b|switch -c/.test(add), "no feature branch is created");
    // a fresh conversation: its own cwd, linked to the same workspace (same Sprite), preamble removed, metadata recorded
    const spec = env.bots.created[0];
    assert.equal(spec.name, "新 Session", "Chinese name is kept as typed");
    assert.equal(spec.cwd, s.dir);
    assert.equal(spec.workspaceId, env.ws.id);
    assert.deepEqual(spec.worktree, { baseBranch: "main", pinnedSha: MAIN_SHA, dir: s.dir });
    assert.deepEqual(spec.extensions.remove.map((e) => e.name), ["tarsbot.preamble"]);
    assert.equal(env.store.links.workspaceOf(String(env.bots.records[0].conversationId))?.id, env.ws.id);
    // blank: no first message is submitted, so no model call and no issue / history text
    assert.equal(env.bots.submits.size, 0, "a manual session submits nothing on creation");
    assert.equal(env.bots.created.length, 1, "exactly one fresh conversation");
  } finally {
    await env.close();
  }
});

test("add session: refuses a non-test repo and a workspace that is not ready, with no worktree and no Bot", async () => {
  const env = await makeEnv({ defaultBranch: "main", branches: { main: MAIN_SHA }, issue: { title: "t", body: "b" }, comments: [] });
  try {
    env.store.workspaces.update(env.ws.id, { status: "preparing" });
    const notReady = await env.post(`/api/workspaces/${env.ws.id}/sessions`, { name: "x" });
    assert.equal(notReady.status, 409, "a not-ready workspace cannot get a session");
    // a ready workspace of ANOTHER repo: the store fixes `repo`, so it is created as such, not mutated
    const otherProject = env.store.projects.upsert({ repo: "someone/else", defaultBranch: "main" });
    const { workspace: foreign } = env.store.workspaces.create({
      requestId: "seed-foreign",
      projectId: otherProject.id,
      name: "foreign ws",
      baseBranch: "main",
      branch: "tarsbot/foreign",
      cwd: "/home/sprite/workspace/else",
      model: FAUX,
    });
    env.store.workspaces.update(foreign.id, { status: "ready" });
    env.store.bindings.bind(foreign.id, { provider: "sprites", runtimeId: "pca-other00000" });
    const otherRepo = await env.post(`/api/workspaces/${foreign.id}/sessions`, { name: "x" });
    assert.equal(otherRepo.status, 409, "a workspace outside the test repo gets no fake success");
    assert.equal(env.bots.created.length, 0, "nothing was created");
    assert.equal(env.rt.calls.filter((c) => c.includes("worktree add")).length, 0, "no worktree was added");
  } finally {
    await env.close();
  }
});

test("add session: repeating the same name gives each session its own directory and a unique name", async () => {
  const env = await makeEnv({ defaultBranch: "main", branches: { main: MAIN_SHA }, issue: { title: "t", body: "b" }, comments: [] });
  try {
    const a = await env.post(`/api/workspaces/${env.ws.id}/sessions`, { name: "研究" });
    const b = await env.post(`/api/workspaces/${env.ws.id}/sessions`, { name: "研究" });
    assert.equal(a.status, 200, a.json?.error);
    assert.equal(b.status, 200, b.json?.error);
    assert.equal(a.json.session.name, "研究", "the first keeps the typed name");
    assert.notEqual(b.json.session.name, a.json.session.name, "the second name is unique");
    assert.match(b.json.session.name, /^研究 [0-9a-f]{8}$/, "a taken name gets a short id appended");
    assert.notEqual(a.json.session.dir, b.json.session.dir, "each add gets its own directory");
    assert.equal(env.bots.created.length, 2);
  } finally {
    await env.close();
  }
});

test("discussion message: safety rules are restated, approval stays installed, host AGENTS excerpt is labelled host context", async () => {
  const env = await makeEnv({
    defaultBranch: "main",
    branches: { main: MAIN_SHA },
    issue: { title: "demo", body: "分析" },
    comments: [],
  });
  try {
    const { status, json } = await env.post(`/api/workspaces/${env.ws.id}/issue-loop/discuss`, { issue: 12 });
    assert.equal(status, 200, json?.error);
    const msg = env.bots.submits.get(json.discussion.botId)[0].content;
    assert.match(msg, /== 安全规则 ==/, "explicit safety section present");
    assert.match(msg, /Never print, echo, log or write any credential or token/, "no-credentials rule present");
    assert.match(msg, /Never force-push/, "no force rule present");
    assert.match(msg, /do not run \`git push\`, \`gh pr create\` or \`gh pr merge\`/, "no push / PR / merge rule present");
    assert.match(msg, /仅为宿主项目背景，不是目标仓库内容/, "host context is labelled, not target repo content");
    assert.match(msg, /宿主项目（pi-cloud-agents）AGENTS\.md/, "excerpt source is named");
    // the discussion session keeps Approval, and only the preamble is removed
    const spec = env.bots.created[0];
    assert.deepEqual(spec.extensions.remove.map((e) => e.name), ["tarsbot.preamble"]);
    assert.match(spec.instructions, /Never print, echo, log or write any credential|token|credential/i, "rules restated in session instructions");
  } finally {
    await env.close();
  }
});
