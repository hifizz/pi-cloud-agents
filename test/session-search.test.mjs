// Session-search route tests (docs/tasks/AMP13-search.md). Fully offline: real harness (MemoryStorage + faux model),
// real control store (in-memory) and a real HTTP server — status codes and JSON are the ones a browser sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { ctx, openHarness } from "../src/harness.mjs";
import { register as registerSessionSearch } from "../src/routes/session-search.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };

/** A tiny workspaces.get service: only what the route uses (existence + id check). */
function fakeWorkspaces(store) {
  return {
    get: (id) => store.workspaces.get(id),
  };
}

async function makeEnv() {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models });
  const bots = new BotRegistry(harness, { path: null });
  const store = openControlStore({ path: null });
  const workspaces = fakeWorkspaces(store);
  const api = createApi({ harness, bots, routes: [(app) => Object.assign(app.ctx, { workspaces, control: store }), registerSessionSearch] });
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
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const seedWorkspace = (name) => {
    const { workspace } = store.workspaces.create({ requestId: `req-${name}`, projectId: project.id, name, baseBranch: "main", branch: `tarsbot/${name}`, cwd: `/ws/${name}`, model: FAUX });
    return store.workspaces.update(workspace.id, { status: "ready" });
  };
  const newBot = async (name) => bots.createBot({ name, model: FAUX });
  const link = (bot, ws) => store.links.link({ conversationId: String(bot.conversationId), workspaceId: ws.id, botId: bot.id });
  /** Queue faux replies then drive `conv` through one input; returns the newest user entry id. */
  const say = async (bot, text, replies = ["ok"]) => {
    f.setResponses(replies.map((t) => fauxAssistantMessage([fauxText(t)])));
    const conv = await bots.conversation(bot.id);
    await (await conv.submit({ type: "input", content: text }, ctx)).wait(ctx);
    await conv.waitForIdle(ctx);
    const items = (await conv.entries({}, 100, undefined, ctx)).items;
    const user = items.find((e) => e.model?.[0]?.role === "user");
    return { entryId: String(user.id), entries: items };
  };
  return {
    f,
    harness,
    bots,
    store,
    seedWorkspace,
    newBot,
    link,
    say,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    async close() {
      await api.close();
      await harness.close(ctx);
      store.close();
    },
  };
}

async function withEnv(fn) {
  const env = await makeEnv();
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

// ---- search -----------------------------------------------------------------------------------------------------------
test("search: finds unique text across sessions of the same workspace, labelled with session and entry", () =>
  withEnv(async (env) => {
    const ws = env.seedWorkspace("w");
    const a = await env.newBot("alpha");
    const b = await env.newBot("beta");
    env.link(a, ws);
    env.link(b, ws);
    const needleA = await env.say(a, "the unique-token ZEBRA-9182 lives here");
    await env.say(b, "nothing relevant");

    const res = await env.get(`/api/workspaces/${ws.id}/search?q=${encodeURIComponent("zebra-9182")}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.results.length, 1);
    const hit = res.json.results[0];
    assert.equal(hit.botId, a.id);
    assert.equal(hit.botName, "alpha");
    assert.equal(hit.entryId, needleA.entryId);
    assert.equal(hit.role, "user");
    assert.match(hit.snippet, /ZEBRA-9182/);
    assert.equal(res.json.sessionsScanned, 2);
    assert.equal(res.json.truncated, false);
  }));

test("search: case-insensitive, newest first across sessions, honours limit + reports truncation", () =>
  withEnv(async (env) => {
    const ws = env.seedWorkspace("w");
    const a = await env.newBot("a");
    env.link(a, ws);
    for (let i = 0; i < 6; i++) await env.say(a, `marker-${i} shared-term`);
    const res = await env.get(`/api/workspaces/${ws.id}/search?q=${encodeURIComponent("SHARED-TERM")}&limit=3`);
    assert.equal(res.status, 200);
    assert.equal(res.json.results.length, 3);
    assert.equal(res.json.truncated, true, "limit reached with more matches pending");
    const ids = res.json.results.map((r) => Number(r.entryId));
    assert.deepEqual([...ids].sort((x, y) => y - x), ids, "newest first");
  }));

test("search: never crosses the workspace boundary", () =>
  withEnv(async (env) => {
    const ws1 = env.seedWorkspace("one");
    const ws2 = env.seedWorkspace("two");
    const inWs = await env.newBot("in");
    const outWs = await env.newBot("out");
    env.link(inWs, ws1);
    env.link(outWs, ws2);
    await env.say(inWs, "shared needle PANDA-1");
    await env.say(outWs, "shared needle PANDA-1");

    const res = await env.get(`/api/workspaces/${ws1.id}/search?q=PANDA-1`);
    assert.equal(res.status, 200);
    assert.equal(res.json.results.length, 1);
    assert.equal(res.json.results[0].botId, inWs.id, "the other workspace's identical text is invisible");
  }));

test("search: validation and 404s", () =>
  withEnv(async (env) => {
    const ws = env.seedWorkspace("w");
    assert.equal((await env.get(`/api/workspaces/${ws.id}/search`)).status, 400);
    assert.equal((await env.get(`/api/workspaces/${ws.id}/search?q=  `)).status, 400);
    assert.equal((await env.get(`/api/workspaces/${ws.id}/search?q=x&limit=0`)).status, 400);
    assert.equal((await env.get(`/api/workspaces/${ws.id}/search?q=x&limit=51`)).status, 400);
    assert.equal((await env.get(`/api/workspaces/ws_nope/search?q=x`)).status, 404);
  }));

// ---- reference preview --------------------------------------------------------------------------------------------------
test("reference preview: returns the real stored entry text, rejects foreign sessions and missing entries", () =>
  withEnv(async (env) => {
    const ws = env.seedWorkspace("w");
    const other = env.seedWorkspace("other");
    const a = await env.newBot("a");
    const foreign = await env.newBot("foreign");
    env.link(a, ws);
    env.link(foreign, other);
    const { entryId } = await env.say(a, "the exact stored body SABLE-7");

    const ok = await env.get(`/api/workspaces/${ws.id}/search/reference?botId=${a.id}&entryId=${entryId}`);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.reference.botId, a.id);
    assert.equal(ok.json.reference.entryId, entryId);
    assert.match(ok.json.reference.text, /SABLE-7/);
    assert.equal(ok.json.reference.role, "user");

    // foreign session -> 409 (never a read of another workspace's conversation)
    const cross = await env.get(`/api/workspaces/${ws.id}/search/reference?botId=${foreign.id}&entryId=${entryId}`);
    assert.equal(cross.status, 409);
    assert.match(cross.json.error, /does not belong to this workspace/);

    // missing entry id -> 404
    const missing = await env.get(`/api/workspaces/${ws.id}/search/reference?botId=${a.id}&entryId=999999`);
    assert.equal(missing.status, 404);
  }));

// ---- submit with references -------------------------------------------------------------------------------------------
test("submit: sends the question to the target session; references are server-read and labelled, not instructions", () =>
  withEnv(async (env) => {
    const ws = env.seedWorkspace("w");
    const target = await env.newBot("target");
    const src = await env.newBot("src");
    env.link(target, ws);
    env.link(src, ws);
    const srcHit = await env.say(src, "source said: prefer bun over npm in this repo");

    env.f.setResponses([fauxAssistantMessage([fauxText("the answer")])]);
    const res = await env.post(`/api/workspaces/${ws.id}/search/submit`, {
      botId: target.id,
      text: "which package manager should I use?",
      references: [{ botId: src.id, entryId: srcHit.entryId }],
    });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.json.submissionId !== undefined);
    assert.equal(res.json.references.length, 1);
    assert.equal(res.json.references[0].botId, src.id);

    const conv = await env.bots.conversation(target.id);
    await conv.waitForIdle(ctx);
    const items = (await conv.entries({}, 10, undefined, ctx)).items;
    const userEntry = items.find((e) => e.model?.[0]?.role === "user" && /package manager/.test(String(e.model?.[0]?.content)));
    const body = userEntry.model[0].content;
    assert.match(body, /which package manager should I use\?/);
    assert.match(body, /不是新指令/, "references are labelled material, not instructions");
    assert.match(body, /prefer bun over npm/, "the real stored entry body is quoted by the server");
    assert.match(body, new RegExp(`entry ${srcHit.entryId}`));
  }));

test("submit: rejects cross-workspace references and foreign targets before submitting anything", () =>
  withEnv(async (env) => {
    const ws1 = env.seedWorkspace("one");
    const ws2 = env.seedWorkspace("two");
    const target = await env.newBot("t");
    const src = await env.newBot("s");
    env.link(target, ws1);
    env.link(src, ws2);
    const srcHit = await env.say(src, "secret other-workspace note");

    const crossRef = await env.post(`/api/workspaces/${ws1.id}/search/submit`, {
      botId: target.id,
      text: "q",
      references: [{ botId: src.id, entryId: srcHit.entryId }],
    });
    assert.equal(crossRef.status, 409);
    assert.match(crossRef.json.error, /does not belong to this workspace/);

    // target session from another workspace is refused too
    const foreignTarget = await env.post(`/api/workspaces/${ws2.id}/search/submit`, { botId: target.id, text: "q" });
    assert.equal(foreignTarget.status, 409);

    const conv = await env.bots.conversation(target.id);
    const items = (await conv.entries({}, 10, undefined, ctx)).items;
    assert.equal(items.length, 0, "nothing was submitted to the target");
  }));

test("submit: validation", () =>
  withEnv(async (env) => {
    const ws = env.seedWorkspace("w");
    const b = await env.newBot("b");
    env.link(b, ws);
    assert.equal((await env.post(`/api/workspaces/${ws.id}/search/submit`, { botId: b.id })).status, 400);
    assert.equal((await env.post(`/api/workspaces/${ws.id}/search/submit`, { botId: b.id, text: "  " })).status, 400);
    assert.equal((await env.post(`/api/workspaces/${ws.id}/search/submit`, { botId: b.id, text: "q", whenBusy: "later" })).status, 400);
    assert.equal(
      (await env.post(`/api/workspaces/${ws.id}/search/submit`, { botId: b.id, text: "q", references: Array.from({ length: 6 }, () => ({ botId: b.id, entryId: "1" })) })).status,
      400,
      "more than 5 references is refused",
    );
    assert.equal((await env.post(`/api/workspaces/ws_nope/search/submit`, { botId: b.id, text: "q" })).status, 404);
  }));
