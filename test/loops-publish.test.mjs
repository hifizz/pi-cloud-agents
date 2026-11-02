// Loop publish route (Issue14 Phase2 fix): draft→publish creates a FRESH worktree+branch from the pinned
// sha, a fresh session with the confirmed task verbatim, and NEVER copies the run's loopRun permission
// context. Session-authenticated route; worktree setup goes through a fake runtimeBash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { createLoopStore } from "../src/loops/store.mjs";
import { createLoopQueue } from "../src/loops/queue.mjs";
import { register as registerAuth } from "../src/routes/auth.mjs";
import { register as registerLoops } from "../src/routes/loops.mjs";
import { openAuthStore } from "../src/auth.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WS_MODEL = { provider: "faux", modelId: "faux-1" };
const EMAIL = "a@x.com";
const PASSWORD = "correct horse battery";
const PINNED = "a".repeat(40);

async function makeEnv() {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "w1", projectId: project.id, name: "w", baseBranch: "main", branch: "b", cwd: "/x", model: WS_MODEL,
  });
  const loopStore = createLoopStore({ store });
  const queue = createLoopQueue({ store, runOne: async () => {}, maxConcurrent: 3 });
  const bashCalls = [];
  const created = [];
  const bots = {
    get: (id) => created.find((b) => b.id === id),
    list: () => created,
    createBot: async (spec) => {
      const bot = { id: `pub-${created.length}`, conversationId: `conv-${created.length}`, name: spec.name, ...spec };
      created.push(bot);
      return bot;
    },
    conversation: async (id) => ({
      submit: async () => ({}),
    }),
  };
  const runtimeBash = async () => async (cmd) => {
    bashCalls.push(cmd);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const dir = mkdtempSync(join(tmpdir(), "loops-publish-"));
  const authStore = openAuthStore({ dataDir: dir });
  await authStore.setPassword(EMAIL, PASSWORD);
  authStore.close();
  const api = createApi({
    harness: {},
    bots,
    routes: [
      (app) => registerAuth(app, { env: { TARSBOT_ALLOWED_EMAILS: EMAIL, TARSBOT_HOST: "127.0.0.1" }, dataDir: dir }),
      (app) => {
        Object.assign(app.ctx, { control: store, loops: { store: loopStore, queue }, bots, runtimeBash, homeDir: () => "/home/sprite" });
        registerLoops(app);
      },
    ],
  });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const req = (method, path, { body, cookie } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { origin: "http://127.0.0.1:8090", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async () => (await req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } })).headers.get("set-cookie").split(";")[0];
  return { store, ws: workspace, loopStore, queue, bashCalls, created, req, login, close: async () => { await api.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("publish: fresh worktree+branch from pinnedSha, fresh session, no loopRun context on the new bot", async () => {
  const env = await makeEnv();
  try {
    const { loop } = await env.loopStore.create(env.ws.id, {
      name: "rw", instructions: "i", trigger: { kind: "manual" },
      capabilities: { code: "readwrite", github: { openPr: true } },
    });
    const { run } = env.store.loopRuns.enqueue({
      loopId: loop.id, loopVersion: 1, workspaceId: env.ws.id,
      triggerKind: "manual", triggerKey: `manual:${Date.now()}`,
      payload: { suggestedTask: { task: "fix the flaky test" }, pinnedSha: PINNED },
      entityRef: "issue:9",
    });
    env.store.loopRuns.update(run.id, { botId: "srcbot", branch: `loops/rw/${run.id}`, status: "succeeded", endedAt: new Date().toISOString() });
    // The source bot carries loopRun metadata — the publish must NOT copy it.
    env.created.push({ id: "srcbot", conversationId: "conv-src", name: "src", loopRun: { loopId: loop.id, runId: run.id, dir: "/home/sprite/loops/w/ro-x", pinnedSha: PINNED, branch: `loops/rw/${run.id}`, capabilities: { code: "readwrite" } } });

    const cookie = await env.login();
    const res = await env.req("POST", `/api/loop-runs/${run.id}/publish`, { body: {}, cookie });
    assert.equal(res.status, 200, await res.clone().text());
    const j = await res.json();
    const ex = j.execution;

    // Fresh worktree + branch — NOT the run's loops/rw/<id> branch or its dir.
    assert.match(ex.branch, /^loops\/publish\//, "new publish branch, not the run branch");
    assert.notEqual(ex.branch, `loops/rw/${run.id}`);
    assert.match(ex.dir, /publish-/, "fresh publish worktree");
    assert.match(env.bashCalls[0], /worktree add -b 'loops\/publish\//, "worktree created from scratch");
    assert.match(env.bashCalls[0], new RegExp(PINNED), "cut at the run's pinnedSha");

    // Fresh session: publishedFrom provenance, NO loopRun (no inherited permission context).
    const pub = env.created.find((b) => b.id === ex.botId);
    assert.ok(pub.publishedFrom, "provenance recorded for the compose panel");
    assert.equal(pub.publishedFrom.runId, run.id);
    assert.equal(pub.loopRun, undefined, "no loop capability context copied");
    assert.match(String(pub.instructions), /按用户任务执行/);
  } finally {
    await env.close();
  }
});

test("publish: empty task 400; over-limit task 400 (rejected, not truncated); draft task used when body absent", async () => {
  const env = await makeEnv();
  try {
    const { loop } = await env.loopStore.create(env.ws.id, { name: "rw", instructions: "i", trigger: { kind: "manual" }, capabilities: { code: "readwrite" } });
    const { run } = env.store.loopRuns.enqueue({
      loopId: loop.id, loopVersion: 1, workspaceId: env.ws.id,
      triggerKind: "manual", triggerKey: `manual:${Date.now()}x`,
      payload: { pinnedSha: PINNED, suggestedTask: { task: "drafted" } },
    });
    env.store.loopRuns.update(run.id, { status: "succeeded" });
    env.created.push({ id: "b0", conversationId: "c0", name: "b0", loopRun: { runId: run.id, pinnedSha: PINNED, dir: "/d", branch: "loops/x/1" } });
    env.store.loopRuns.update(run.id, { botId: "b0" });
    const cookie = await env.login();
    // empty task
    let res = await env.req("POST", `/api/loop-runs/${run.id}/publish`, { body: { task: "   " }, cookie });
    assert.equal(res.status, 400);
    // over-limit
    res = await env.req("POST", `/api/loop-runs/${run.id}/publish`, { body: { task: "x".repeat(4001) }, cookie });
    assert.equal(res.status, 400, "over-limit rejected, not truncated");
    // draft fallback works
    res = await env.req("POST", `/api/loop-runs/${run.id}/publish`, { body: {}, cookie });
    assert.equal(res.status, 200, await res.clone().text());
  } finally {
    await env.close();
  }
});
