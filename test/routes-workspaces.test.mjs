// M1-08: workspace / GitHub / fork routes. Everything is offline: a real control store (in memory), the real workspace
// service with a fake Sprite provider and runner, the real GitHub client on top of a fake `fetch`, and a real HTTP server
// (createApi) so status codes (202 included) are the ones a browser sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createHash } from "node:crypto";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { createGithubClient } from "../src/github.mjs";
import { createWorkspaceService } from "../src/workspaces.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { ctx, openHarness } from "../src/harness.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { Search } from "../src/ext/search.mjs";
import { History } from "../src/ext/history.mjs";
import { register as registerGithub } from "../src/routes/github.mjs";
import { register as registerWorkspaces } from "../src/routes/workspaces.mjs";
import { register as registerFork } from "../src/routes/fork.mjs";

const TOKEN = "ghp_FAKEtoken0123456789abcdefghijklmnop";
const FAUX = { provider: "faux", modelId: "faux-1" };
const SHA = "a".repeat(40);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ---- fakes ------------------------------------------------------------------------------------------------------------
/** A tiny GitHub REST double (repos, branches, pulls) behind the real client. */
function fakeGithubApi() {
  const st = {
    repos: [{ full_name: "acme/app", default_branch: "main", private: false }],
    branches: { "acme/app": { main: SHA } },
    pulls: [],
    calls: [],
    fail: null, // { status, message } for every request
    loseNextPosts: 0, // create the PR, then fail the response with a network error
  };
  const reply = (status, data) => ({ status, headers: { get: () => null }, text: async () => (data === undefined ? "" : JSON.stringify(data)) });
  const fetch = async (url, init) => {
    const u = new URL(url);
    const method = init.method;
    st.calls.push(`${method} ${u.pathname}`);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    if (st.fail) return reply(st.fail.status, { message: st.fail.message });
    let m;
    if (u.pathname === "/user/repos") return reply(200, st.repos);
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/branches$/.exec(u.pathname))) {
      const b = st.branches[m[1]];
      return b ? reply(200, Object.entries(b).map(([name, sha]) => ({ name, commit: { sha } }))) : reply(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/.exec(u.pathname))) {
      const sha = st.branches[m[1]]?.[decodeURIComponent(m[2])];
      return sha ? reply(200, { name: decodeURIComponent(m[2]), commit: { sha } }) : reply(404, { message: "Branch not found" });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(u.pathname))) {
      if (method === "GET") {
        const head = (u.searchParams.get("head") ?? "").split(":")[1];
        return reply(200, st.pulls.filter((p) => p.repo === m[1] && p.head.ref === head));
      }
      const payload = JSON.parse(init.body);
      const pull = {
        repo: m[1],
        number: st.pulls.length + 1,
        html_url: `https://github.com/${m[1]}/pull/${st.pulls.length + 1}`,
        state: "open",
        merged: false,
        head: { ref: payload.head },
        base: { ref: payload.base },
        title: payload.title,
        body: payload.body,
      };
      st.pulls.push(pull);
      if (st.loseNextPosts > 0) {
        st.loseNextPosts--;
        throw new TypeError(`fetch failed (Authorization: Bearer ${TOKEN})`);
      }
      return reply(201, pull);
    }
    return reply(404, { message: "Not Found" });
  };
  return { st, fetch };
}

function fakeProvider() {
  const p = {
    kind: "sprites",
    home: "/home/sprite",
    ensures: 0,
    ensureError: null,
    runtimeName: (rid) => `pca-${sha256(rid).slice(0, 10)}`,
    async ensure({ requestId }) {
      p.ensures++;
      if (p.ensureError) throw p.ensureError;
      return { runtimeId: p.runtimeName(requestId), created: true };
    },
    async init() {},
    bash() {
      throw new Error("bash must not be used when runnerFor is injected");
    },
  };
  return p;
}

const fakeRunner = () => ({
  async install() {},
  async prepare() {},
  async start() {},
  async wait({ from }) {
    return { state: "exited", exit: 0, offset: from, data: "" };
  },
  async status() {
    return { state: "exited", exit: 0 };
  },
  async kill() {
    return { killed: "not-found" };
  },
});

function fakeBots() {
  const list = [];
  const submits = [];
  return {
    submits,
    list: () => [...list],
    get: (id) => list.find((b) => b.id === id || b.name === id),
    async createBot({ name, model, cwd, instructions }) {
      const bot = { id: `bot${list.length + 1}`, name, conversationId: 1000 + list.length, model, cwd, instructions };
      list.push(bot);
      return bot;
    },
    async conversation() {
      return {
        async submit(input) {
          submits.push(input);
          return {};
        },
      };
    },
  };
}

/** One wired world: store + service + github + HTTP server. */
async function makeEnv({ routes = [registerGithub, registerWorkspaces] } = {}) {
  const store = openControlStore({ path: null });
  const gh = fakeGithubApi();
  const github = createGithubClient({ token: TOKEN, fetch: gh.fetch });
  const provider = fakeProvider();
  const bots = fakeBots();
  const svc = createWorkspaceService({
    store,
    github,
    providers: { sprites: provider },
    bots,
    ctx: {},
    runnerFor: () => fakeRunner(),
    cloneUrl: (repo) => `/nonexistent/${repo}`,
    defaultModel: () => FAUX,
    waitSeconds: 1,
    retryDelayMs: 1,
  });
  const inject = (app) => Object.assign(app.ctx, { workspaces: svc, github, control: store });
  const api = createApi({ harness: {}, bots, routes: [inject, ...routes] });
  const { port } = await api.listen(0);

  const call = async (method, path, body, { raw } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined && raw === undefined ? undefined : { "content-type": "application/json" },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    // no response may ever carry a token or a server-side absolute path
    assert.ok(!text.includes(TOKEN), `response leaks the token: ${text.slice(0, 200)}`);
    assert.ok(!text.includes("ghp_"), "response carries a GitHub token shape");
    assert.ok(!text.includes(tmpdir()), "response carries a server temp path");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  const seed = ({ branch, status = "ready", task = "Fix the thing\nwith details", repo = "acme/app" }) => {
    const project = store.projects.upsert({ repo, defaultBranch: "main" });
    const { workspace } = store.workspaces.create({
      requestId: `seed-${branch}`,
      projectId: project.id,
      name: "seeded",
      baseBranch: "main",
      branch,
      cwd: "/home/sprite/workspace/app",
      model: FAUX,
      task,
    });
    return store.workspaces.update(workspace.id, { status });
  };
  return {
    store,
    gh,
    github,
    svc,
    provider,
    bots,
    call,
    seed,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    async close() {
      await svc.idle();
      await api.close();
      store.close();
    },
  };
}

async function withEnv(fn, opts) {
  const env = await makeEnv(opts);
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

// ---- wiring -----------------------------------------------------------------------------------------------------------
test("routes are not registered (one warning) without the injected dependencies", () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    for (const ctxObj of [{}, {}, { workspaces: {}, github: {} }, { github: {}, control: {} }]) {
      const routes = [];
      const app = { ctx: ctxObj, get: (p) => routes.push(`GET ${p}`), post: (p) => routes.push(`POST ${p}`) };
      registerGithub(app);
      registerWorkspaces(app);
      if (ctxObj.github) assert.ok(routes.some((r) => r.includes("/api/github/")), "github routes need only github");
      else assert.deepEqual(routes, []);
      assert.ok(!routes.some((r) => r.includes("/api/workspaces")), `workspace routes registered with ${Object.keys(ctxObj)}`);
    }
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warnings.length >= 1 && warnings.length <= 2, `expected a single warning per module, got ${warnings.length}`);
});

// ---- GitHub routes ----------------------------------------------------------------------------------------------------
test("GET /api/github/repos and /branches", () =>
  withEnv(async (env) => {
    const repos = await env.get("/api/github/repos");
    assert.equal(repos.status, 200);
    assert.deepEqual(repos.json, [{ fullName: "acme/app", defaultBranch: "main", private: false }]);

    const branches = await env.get("/api/github/branches?repo=acme/app");
    assert.equal(branches.status, 200);
    assert.deepEqual(branches.json, [{ name: "main", sha: SHA }]);

    assert.equal((await env.get("/api/github/branches")).status, 400);
    assert.equal((await env.get("/api/github/branches?repo=not-a-repo")).status, 400);
    assert.equal((await env.get("/api/github/branches?repo=acme/missing")).status, 404);
  }));

test("GithubError mapping: 401 -> 502 without credentials text, 429, 404; the token never appears", () =>
  withEnv(async (env) => {
    env.gh.st.fail = { status: 401, message: `Bad credentials ${TOKEN}` };
    const unauthorized = await env.get("/api/github/repos");
    assert.equal(unauthorized.status, 502);
    assert.match(unauthorized.json.error, /GitHub 凭据不可用/);

    env.gh.st.fail = { status: 429, message: `slow down ${TOKEN}` };
    assert.equal((await env.get("/api/github/repos")).status, 429);

    env.gh.st.fail = { status: 404, message: "Not Found" };
    assert.equal((await env.get("/api/github/branches?repo=acme/app")).status, 404);

    env.gh.st.fail = { status: 500, message: `boom ${TOKEN}` };
    const unknown = await env.get("/api/github/repos");
    assert.equal(unknown.status, 502);
  }));

// ---- POST /api/workspaces ---------------------------------------------------------------------------------------------
test("POST /api/workspaces: validation", () =>
  withEnv(async (env) => {
    assert.equal((await env.post("/api/workspaces")).status, 400); // no body
    assert.equal((await env.post("/api/workspaces", [])).status, 400);
    assert.equal((await env.call("POST", "/api/workspaces", undefined, { raw: "{nope" })).status, 400);
    assert.equal((await env.post("/api/workspaces", { repo: "acme/app" })).status, 400);
    assert.equal((await env.post("/api/workspaces", { requestId: "r1" })).status, 400);
    assert.equal((await env.post("/api/workspaces", { requestId: "r1", repo: "bad repo" })).status, 400);
    assert.equal((await env.post("/api/workspaces", { requestId: "r1", repo: "acme" })).status, 400);
    assert.equal((await env.post("/api/workspaces", { requestId: 7, repo: "acme/app" })).status, 400);
    assert.equal((await env.post("/api/workspaces", { requestId: "r1", repo: "acme/app", task: 5 })).status, 400);
    assert.equal(env.store.workspaces.list().length, 0);
    assert.equal(env.provider.ensures, 0);
  }));

test("POST /api/workspaces -> 202; the workspace becomes ready with steps, botId and binding summary", () =>
  withEnv(async (env) => {
    const res = await env.post("/api/workspaces", { requestId: "req-1", repo: "acme/app", task: "Add a README", name: "readme" });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.repo, "acme/app");
    assert.equal(res.json.name, "readme");
    assert.equal(res.json.baseBranch, "main");
    assert.match(res.json.branch, /^tarsbot\/add-a-readme-[0-9a-f]{6}$/);
    assert.ok(Array.isArray(res.json.steps) && res.json.steps.length === 5);
    const id = res.json.id;

    await env.svc.idle();
    const detail = await env.get(`/api/workspaces/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.status, "ready", detail.text);
    assert.deepEqual(detail.json.steps.map((s) => [s.step, s.state]), [
      ["runtime", "done"],
      ["init", "done"],
      ["code", "done"],
      ["deps", "done"],
      ["agent", "done"],
    ]);
    const bot = env.bots.list()[0];
    assert.equal(detail.json.botId, bot.id);
    assert.equal(detail.json.binding.provider, "sprites");
    assert.equal(detail.json.binding.version, 1);
    assert.equal(detail.json.binding.runtimeId, env.provider.runtimeName("req-1"));
    assert.deepEqual(Object.keys(detail.json.binding).sort(), ["provider", "runtimeId", "version"]);
    assert.equal(env.bots.submits.length, 1, "the first task was submitted once");

    const list = await env.get("/api/workspaces");
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].id, id);
    assert.equal(list.json[0].botId, bot.id);
    assert.equal(list.json[0].steps.length, 5);
    assert.equal(list.json[0].binding.runtimeId, detail.json.binding.runtimeId);

    assert.equal((await env.get("/api/workspaces/ws_nope")).status, 404);
  }));

test("POST /api/workspaces: same requestId and content -> the same workspace; different content -> 409", () =>
  withEnv(async (env) => {
    const body = { requestId: "req-dup", repo: "acme/app", task: "do it" };
    const a = await env.post("/api/workspaces", body);
    const b = await env.post("/api/workspaces", { ...body });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal(b.json.id, a.json.id);
    await env.svc.idle();
    assert.equal(env.store.workspaces.list().length, 1);
    assert.equal(env.provider.ensures, 1, "one Sprite for one request");

    for (const changed of [{ task: "do something else" }, { repo: "acme/other" }, { name: "x" }, { installCommand: "npm i" }]) {
      const c = await env.post("/api/workspaces", { ...body, ...changed });
      assert.equal(c.status, 409, c.text);
      assert.match(c.json.error, /请求编号已被不同内容使用/);
    }
    assert.equal(env.store.workspaces.list().length, 1);
    assert.equal(env.provider.ensures, 1);
  }));

// ---- retry ------------------------------------------------------------------------------------------------------------
test("POST /api/workspaces/:id/retry: failed step, then unknown ('结果待确认') step", () =>
  withEnv(async (env) => {
    assert.equal((await env.post("/api/workspaces/ws_nope/retry", {})).status, 404);

    // definite failure
    env.provider.ensureError = Object.assign(new Error("quota exceeded"), { uncertain: false });
    const created = await env.post("/api/workspaces", { requestId: "req-f", repo: "acme/app" });
    await env.svc.idle();
    let ws = (await env.get(`/api/workspaces/${created.json.id}`)).json;
    assert.equal(ws.status, "failed");
    assert.equal(ws.steps.find((s) => s.step === "runtime").state, "failed");
    assert.equal(ws.botId, null);
    assert.equal(ws.binding, null);

    env.provider.ensureError = Object.assign(new Error("gateway timeout"), { uncertain: true });
    const retried = await env.post(`/api/workspaces/${created.json.id}/retry`, {});
    assert.equal(retried.status, 200);
    await env.svc.idle();
    ws = (await env.get(`/api/workspaces/${created.json.id}`)).json;
    assert.equal(ws.status, "preparing", "an unknown step keeps the workspace preparing");
    const step = ws.steps.find((s) => s.step === "runtime");
    assert.equal(step.state, "unknown");
    assert.match(step.error, /结果待确认/);

    env.provider.ensureError = null;
    assert.equal((await env.post(`/api/workspaces/${created.json.id}/retry`)).status, 200);
    await env.svc.idle();
    ws = (await env.get(`/api/workspaces/${created.json.id}`)).json;
    assert.equal(ws.status, "ready", JSON.stringify(ws.steps));
    assert.ok(ws.botId);
    assert.equal(env.bots.list().length, 1);
  }));

// ---- POST /api/workspaces/:id/pr --------------------------------------------------------------------------------------
test("POST /pr: validation, not found, not ready, branch not pushed", () =>
  withEnv(async (env) => {
    const ws = env.seed({ branch: "tarsbot/work-aaaaaa" });
    const url = `/api/workspaces/${ws.id}/pr`;
    assert.equal((await env.post(url)).status, 400);
    assert.equal((await env.post(url, [])).status, 400);
    assert.equal((await env.post(url, {})).status, 400);
    assert.equal((await env.post(url, { requestId: "p1", title: 5 })).status, 400);
    assert.equal((await env.post("/api/workspaces/ws_nope/pr", { requestId: "p1" })).status, 404);

    const preparing = env.seed({ branch: "tarsbot/prep-bbbbbb", status: "preparing" });
    const notReady = await env.post(`/api/workspaces/${preparing.id}/pr`, { requestId: "p1" });
    assert.equal(notReady.status, 409);
    assert.match(notReady.json.error, /not ready/);

    const unpushed = await env.post(url, { requestId: "p1" });
    assert.equal(unpushed.status, 409);
    assert.match(unpushed.json.error, /git push/);
    assert.equal(env.gh.st.pulls.length, 0, "the server never creates a PR (nor pushes) for an unpushed branch");
    assert.ok(!env.gh.st.calls.some((c) => c.startsWith("POST")));
  }));

test("POST /pr: creates the PR (defaults, footer), a repeated requestId returns the same one", () =>
  withEnv(async (env) => {
    const ws = env.seed({ branch: "tarsbot/work-cccccc" });
    env.gh.st.branches["acme/app"][ws.branch] = "b".repeat(40);
    const url = `/api/workspaces/${ws.id}/pr`;

    const first = await env.post(url, { requestId: "p-1", body: "Details here" });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.created, true);
    assert.equal(first.json.pull.number, 1);
    const pr = env.gh.st.pulls[0];
    assert.equal(pr.head.ref, ws.branch);
    assert.equal(pr.base.ref, "main");
    assert.equal(pr.title, "Fix the thing", "title defaults to the task's first line");
    assert.equal(pr.body, "Details here\n\nOpened by TARSBot");

    const again = await env.post(url, { requestId: "p-1", body: "Details here" });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, first.json, "same requestId, same answer (including created)");
    assert.equal(env.gh.st.pulls.length, 1);

    // another requestId for the same branch finds the PR instead of opening a second one
    const other = await env.post(url, { requestId: "p-2", title: "ignored, PR exists" });
    assert.equal(other.status, 200);
    assert.equal(other.json.created, false);
    assert.equal(other.json.pull.number, 1);
    assert.equal(env.gh.st.pulls.length, 1);

    // explicit base / title, no body -> footer only
    const ws2 = env.seed({ branch: "tarsbot/work-dddddd", task: null });
    env.gh.st.branches["acme/app"][ws2.branch] = "c".repeat(40);
    const custom = await env.post(`/api/workspaces/${ws2.id}/pr`, { requestId: "p-3", base: "develop", title: "My title" });
    assert.equal(custom.status, 200, custom.text);
    const pr2 = env.gh.st.pulls.find((p) => p.head.ref === ws2.branch);
    assert.equal(pr2.base.ref, "develop");
    assert.equal(pr2.title, "My title");
    assert.equal(pr2.body, "Opened by TARSBot");
    const noTask = env.seed({ branch: "tarsbot/work-eeeeee", task: null });
    env.gh.st.branches["acme/app"][noTask.branch] = "d".repeat(40);
    await env.post(`/api/workspaces/${noTask.id}/pr`, { requestId: "p-4" });
    assert.equal(env.gh.st.pulls.find((p) => p.head.ref === noTask.branch).title, noTask.branch, "no task: branch name");
  }));

test("FT-M1-2: the PR response is lost, the retry with the same requestId gets the same PR (x10)", () =>
  withEnv(async (env) => {
    for (let i = 0; i < 10; i++) {
      const ws = env.seed({ branch: `tarsbot/lost-${i}-ffffff` });
      env.gh.st.branches["acme/app"][ws.branch] = "e".repeat(40);
      const url = `/api/workspaces/${ws.id}/pr`;
      const rid = `lost-${i}`;

      env.gh.st.loseNextPosts = 1; // GitHub creates the PR, the response never arrives
      const first = await env.post(url, { requestId: rid });
      assert.equal(first.status, 200, first.text);
      const retry = await env.post(url, { requestId: rid });
      assert.equal(retry.status, 200);
      assert.equal(retry.json.pull.number, first.json.pull.number, `round ${i}`);
      assert.equal(retry.json.created, first.json.created);
      assert.equal(env.gh.st.pulls.filter((p) => p.head.ref === ws.branch).length, 1, `round ${i}: exactly one PR`);
    }
    assert.equal(env.gh.st.pulls.length, 10);
  }));

test("POST /pr: a merged or closed PR for the branch -> 409", () =>
  withEnv(async (env) => {
    for (const [i, patch] of [{ merged: true, state: "closed" }, { merged: false, state: "closed" }].entries()) {
      const ws = env.seed({ branch: `tarsbot/done-${i}-111111` });
      env.gh.st.branches["acme/app"][ws.branch] = "f".repeat(40);
      env.gh.st.pulls.push({
        repo: "acme/app",
        number: 100 + i,
        html_url: `https://github.com/acme/app/pull/${100 + i}`,
        head: { ref: ws.branch },
        base: { ref: "main" },
        ...patch,
      });
      const res = await env.post(`/api/workspaces/${ws.id}/pr`, { requestId: `done-${i}` });
      assert.equal(res.status, 409, res.text);
      assert.match(res.json.error, /new branch or new work/);
    }
    assert.equal(env.gh.st.pulls.length, 2, "nothing new was created");
  }));

test("POST /pr: GitHub errors map to HTTP without leaking the token", () =>
  withEnv(async (env) => {
    const ws = env.seed({ branch: "tarsbot/err-222222" });
    const url = `/api/workspaces/${ws.id}/pr`;
    env.gh.st.fail = { status: 401, message: `Bad credentials ${TOKEN}` };
    const res = await env.post(url, { requestId: "e1" });
    assert.equal(res.status, 502);
    assert.match(res.json.error, /GitHub 凭据不可用/);
    env.gh.st.fail = { status: 429, message: "rate limit exceeded" };
    assert.equal((await env.post(url, { requestId: "e2" })).status, 429);
  }));

// ---- fork -------------------------------------------------------------------------------------------------------------
async function forkEnv(fn, { withControl = true } = {}) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses([fauxAssistantMessage([fauxText("hello")]), fauxAssistantMessage([fauxText("again")])]);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble, CodingTools, Search, History] });
  const bots = new BotRegistry(harness, { path: null });
  const store = openControlStore({ path: null });
  const api = createApi({
    harness,
    bots,
    routes: [
      (app) => {
        if (withControl) app.ctx.control = store;
      },
      registerFork,
    ],
  });
  const { port } = await api.listen(0);
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  try {
    const parent = await bots.createBot({ name: "parent", model: FAUX });
    const conv = await bots.conversation(parent.id);
    await (await conv.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    await conv.waitForIdle(ctx);
    const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
    const { workspace } = store.workspaces.create({
      requestId: "fork-ws",
      projectId: project.id,
      name: "ws",
      baseBranch: "main",
      branch: "tarsbot/fork-333333",
      cwd: "/home/sprite/workspace/app",
      model: FAUX,
    });
    await fn({ bots, store, post, parent, workspace });
  } finally {
    await api.close();
    await harness.close(ctx);
    store.close();
  }
}

test("fork: a writable fork is refused with 409 and creates no conversation", () =>
  forkEnv(async ({ bots, store, post, parent, workspace }) => {
    store.links.link({ conversationId: String(parent.conversationId), workspaceId: workspace.id, botId: parent.id });
    const before = bots.list().length;
    for (const body of [{ name: "w" }, { name: "w", readOnly: false }]) {
      const res = await post(`/api/bots/${parent.id}/fork`, body);
      assert.equal(res.status, 409, JSON.stringify(res.json));
      assert.match(res.json.error, /同一工作区暂不支持第二个可写会话，写锁将在后续阶段提供/);
    }
    assert.equal(bots.list().length, before);
    assert.equal(bots.get("w"), undefined);
    assert.equal(store.links.conversationsOf(workspace.id).length, 1);
  }));

test("fork: a read-only fork inherits the parent's workspace link", () =>
  forkEnv(async ({ bots, store, post, parent, workspace }) => {
    store.links.link({ conversationId: String(parent.conversationId), workspaceId: workspace.id, botId: parent.id });
    const res = await post(`/api/bots/${parent.id}/fork`, { name: "reader", readOnly: true });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.readOnly, true);
    assert.equal(store.links.workspaceOf(String(res.json.conversationId))?.id, workspace.id);
    const links = store.links.conversationsOf(workspace.id);
    assert.equal(links.length, 2);
    assert.equal(links.find((l) => l.conversationId === String(res.json.conversationId)).botId, res.json.id);
    assert.equal(bots.get("reader").id, res.json.id);
    // validation still comes first
    assert.equal((await post(`/api/bots/${parent.id}/fork`, { readOnly: true })).status, 400);
    assert.equal((await post(`/api/bots/${parent.id}/fork`, { name: "reader", readOnly: true })).status, 409);
  }));

test("fork: a parent without a workspace link is refused with 409", () =>
  forkEnv(async ({ bots, post, parent }) => {
    const before = bots.list().length;
    const res = await post(`/api/bots/${parent.id}/fork`, { name: "orphan", readOnly: true });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(bots.list().length, before);
  }));

test("fork: without an injected control store the old behaviour is unchanged", () =>
  forkEnv(
    async ({ bots, post, parent }) => {
      const res = await post(`/api/bots/${parent.id}/fork`, { name: "free" });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.ok(bots.get("free"));
    },
    { withControl: false },
  ));
