// Offline tests for src/github.mjs: a fake GitHub (injected `fetch`) with failure injection. No network.
import { test } from "node:test";
import assert from "node:assert/strict";

const { createGithubClient, GithubError } = await import("../src/github.mjs");

const TOKEN = "ghp_SECRETTOKEN1234567890abcdef";
const REPO = "acme/widgets";

const json = (status, body, headers = {}) =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** In-memory GitHub: pulls + branches + repos, with hooks to inject failures around each request. */
function fakeGithub({ pulls = [], branches = [], repos = [] } = {}) {
  const state = { pulls: [...pulls], branches, repos, calls: [], nextNumber: 100 };
  const hooks = { beforePost: null, afterPost: null, onRequest: null };

  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    state.calls.push({ method, path: u.pathname, search: u.search, headers: init.headers, body: init.body });
    if (hooks.onRequest) {
      const r = hooks.onRequest({ method, u, init });
      if (r) return r;
    }
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(.*)$/);

    if (method === "GET" && u.pathname === "/user/repos") {
      const per = Number(u.searchParams.get("per_page"));
      const page = Number(u.searchParams.get("page"));
      return json(200, state.repos.slice((page - 1) * per, page * per));
    }
    if (m && method === "GET" && m[2] === "branches") {
      const per = Number(u.searchParams.get("per_page"));
      const page = Number(u.searchParams.get("page"));
      return json(200, state.branches.slice((page - 1) * per, page * per).map((b) => ({ name: b.name, commit: { sha: b.sha } })));
    }
    if (m && method === "GET" && m[2].startsWith("branches/")) {
      const name = decodeURIComponent(m[2].slice("branches/".length));
      const b = state.branches.find((x) => x.name === name);
      return b ? json(200, { name: b.name, commit: { sha: b.sha } }) : json(404, { message: "Branch not found" });
    }
    if (m && method === "GET" && m[2] === "pulls") {
      const head = u.searchParams.get("head");
      const [owner, ref] = head.split(":");
      const hits = state.pulls.filter((p) => p.head.ref === ref && m[1].startsWith(`${owner}/`));
      return json(200, hits);
    }
    if (m && method === "POST" && m[2] === "pulls") {
      const body = JSON.parse(init.body);
      if (hooks.beforePost) await hooks.beforePost(body);
      if (state.pulls.some((p) => p.head.ref === body.head && p.state === "open")) {
        return json(422, { message: "Validation Failed", errors: [{ message: `A pull request already exists for acme:${body.head}.` }] });
      }
      const number = state.nextNumber++;
      const pr = {
        number,
        html_url: `https://github.com/${m[1]}/pull/${number}`,
        state: "open",
        merged: false,
        head: { ref: body.head },
        base: { ref: body.base },
        title: body.title,
      };
      state.pulls.push(pr);
      if (hooks.afterPost) await hooks.afterPost(body, pr);
      return json(201, pr);
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch, state, hooks };
}

/** Intents store stub with the same begin/settle shape as the control store. */
function fakeIntents() {
  const rows = new Map();
  return {
    rows,
    begin({ requestId, kind, target }) {
      const existing = rows.get(requestId);
      if (existing) return { intent: existing, created: false };
      const intent = { requestId, kind, target, state: "planned", evidence: null };
      rows.set(requestId, intent);
      return { intent, created: true };
    },
    markSent(requestId) {
      const r = rows.get(requestId);
      if (r && r.state === "planned") r.state = "sent";
    },
    settle(requestId, { state, evidence }) {
      const r = rows.get(requestId);
      r.state = state;
      r.evidence = evidence ?? null;
    },
  };
}

const client = (fake, extra = {}) => createGithubClient({ token: TOKEN, fetch: fake.fetch, apiBase: "http://gh.test", ...extra });
const prArgs = { repo: REPO, head: "feat/x", base: "main", title: "T", body: "B" };

// ---------------------------------------------------------------- basics

test("token missing: constructing is fine, calling throws unauthorized", async () => {
  const fake = fakeGithub();
  const gh = createGithubClient({ token: "", fetch: fake.fetch, apiBase: "http://gh.test" });
  await assert.rejects(gh.listRepos(), (e) => e instanceof GithubError && e.code === "unauthorized");
  assert.equal(fake.state.calls.length, 0);
});

test("requests carry User-Agent, API version and bearer auth", async () => {
  const fake = fakeGithub({ repos: [] });
  await client(fake).listRepos();
  const h = fake.state.calls[0].headers;
  assert.ok(h["User-Agent"]);
  assert.ok(h["X-GitHub-Api-Version"]);
  assert.equal(h.Authorization, `Bearer ${TOKEN}`);
  assert.match(fake.state.calls[0].search, /sort=pushed/);
});

test("listRepos maps fields and paginates up to limit", async () => {
  const repos = Array.from({ length: 250 }, (_, i) => ({ full_name: `acme/r${i}`, default_branch: "main", private: i % 2 === 0 }));
  const fake = fakeGithub({ repos });
  const gh = client(fake);

  const first = await gh.listRepos({ limit: 150 });
  assert.equal(first.length, 150);
  assert.deepEqual(first[0], { fullName: "acme/r0", defaultBranch: "main", private: true });
  assert.equal(fake.state.calls.length, 2); // two pages, no third

  fake.state.calls.length = 0;
  const dflt = await gh.listRepos();
  assert.equal(dflt.length, 100);

  const all = await gh.listRepos({ limit: 1000 });
  assert.equal(all.length, 250); // stops on the short page
});

test("listBranches paginates up to 300 by default", async () => {
  const branches = Array.from({ length: 450 }, (_, i) => ({ name: `b${i}`, sha: `sha${i}` }));
  const fake = fakeGithub({ branches });
  const gh = client(fake);
  const got = await gh.listBranches(REPO);
  assert.equal(got.length, 300);
  assert.deepEqual(got[299], { name: "b299", sha: "sha299" });
  assert.equal((await gh.listBranches(REPO, { limit: 5 })).length, 5);
});

test("getBranch returns {name, sha} or null on 404; other 404s on pulls are not_found", async () => {
  const fake = fakeGithub({ branches: [{ name: "feat/x", sha: "abc" }] });
  const gh = client(fake);
  assert.deepEqual(await gh.getBranch(REPO, "feat/x"), { name: "feat/x", sha: "abc" });
  assert.equal(await gh.getBranch(REPO, "nope"), null);
  await assert.rejects(gh.listBranches("not-a-repo"), (e) => e.code === "not_found");
});

// ---------------------------------------------------------------- HTTP error mapping

test("error mapping: 401, 403 (rate limit vs forbidden), 404, 422 already exists", async () => {
  const fake = fakeGithub();
  const gh = client(fake);
  const respond = (res) => {
    fake.hooks.onRequest = () => res();
  };

  respond(() => json(401, { message: "Bad credentials" }));
  await assert.rejects(gh.listRepos(), (e) => e.code === "unauthorized" && e.status === 401);

  respond(() => json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }));
  await assert.rejects(gh.listRepos(), (e) => e.code === "rate_limited" && e.status === 403);

  respond(() => json(403, { message: "Resource not accessible" }, { "x-ratelimit-remaining": "4999" }));
  await assert.rejects(gh.listRepos(), (e) => e.code === "unauthorized" && e.status === 403);

  respond(() => json(404, { message: "Not Found" }));
  await assert.rejects(gh.listBranches(REPO), (e) => e.code === "not_found");

  respond(() => json(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:x." }] }));
  await assert.rejects(gh.createPull(REPO, { head: "x", base: "main", title: "t" }), (e) => e.code === "conflict" && e.status === 422);

  respond(() => json(422, { message: "Validation Failed", errors: [{ message: "No commits between main and x" }] }));
  await assert.rejects(gh.createPull(REPO, { head: "x", base: "main", title: "t" }), (e) => e.code === "unknown" && e.status === 422);

  respond(() => json(500, { message: "boom" }));
  await assert.rejects(gh.listRepos(), (e) => e.code === "unknown" && e.status === 500);
});

// ---------------------------------------------------------------- findPullByHead

test("findPullByHead: none -> null; prefers open over closed; reports merged; uses owner:branch and state=all", async () => {
  const mk = (number, state, merged, ref = "feat/x") => ({
    number,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    state,
    merged_at: merged ? "2026-01-01T00:00:00Z" : null,
    head: { ref },
    base: { ref: "main" },
  });
  const fake = fakeGithub({ pulls: [mk(1, "closed", true), mk(2, "open", false), mk(3, "closed", false, "other")] });
  const gh = client(fake);

  const open = await gh.findPullByHead(REPO, "feat/x");
  assert.equal(open.number, 2);
  assert.equal(open.state, "open");
  assert.equal(open.merged, false);
  const call = fake.state.calls[0];
  assert.match(call.search, /head=acme%3Afeat%2Fx/);
  assert.match(call.search, /state=all/);

  assert.equal(await gh.findPullByHead(REPO, "missing"), null);

  const fake2 = fakeGithub({ pulls: [mk(1, "closed", true)] });
  const merged = await client(fake2).findPullByHead(REPO, "feat/x");
  assert.deepEqual(merged, { number: 1, url: `https://github.com/${REPO}/pull/1`, state: "closed", merged: true, headRef: "feat/x", baseRef: "main" });
});

// ---------------------------------------------------------------- ensurePull

test("ensurePull: normal creation settles confirmed with number and url", async () => {
  const fake = fakeGithub();
  const intents = fakeIntents();
  const { pull, created } = await client(fake).ensurePull(prArgs, { intents, requestId: "req-1" });
  assert.equal(created, true);
  assert.equal(pull.number, 100);
  assert.equal(fake.state.pulls.length, 1);
  const row = intents.rows.get("req-1");
  assert.equal(row.kind, "github.pr");
  assert.equal(row.target, `${REPO}#feat/x`);
  assert.equal(row.state, "confirmed");
  assert.deepEqual(row.evidence, { number: 100, url: pull.url });
  const post = fake.state.calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post.body), { title: "T", head: "feat/x", base: "main", body: "B" });
});

test("ensurePull: existing open PR is reused, created=false, no POST", async () => {
  const fake = fakeGithub();
  const gh = client(fake);
  await gh.ensurePull(prArgs, { intents: fakeIntents(), requestId: "req-a" });
  const again = await gh.ensurePull(prArgs, { intents: fakeIntents(), requestId: "req-b" });
  assert.equal(again.created, false);
  assert.equal(fake.state.pulls.length, 1);
  assert.equal(fake.state.calls.filter((c) => c.method === "POST").length, 1);
});

test("ensurePull: retrying the same requestId after success does not unsettle the intent", async () => {
  const fake = fakeGithub();
  const intents = fakeIntents();
  const gh = client(fake);
  await gh.ensurePull(prArgs, { intents, requestId: "req-1" });
  const again = await gh.ensurePull(prArgs, { intents, requestId: "req-1" });
  assert.equal(again.created, false);
  assert.equal(intents.rows.get("req-1").state, "confirmed");
});

for (const merged of [true, false]) {
  test(`ensurePull: ${merged ? "merged" : "closed"} PR -> conflict, nothing created`, async () => {
    const fake = fakeGithub({
      pulls: [
        {
          number: 7,
          html_url: `https://github.com/${REPO}/pull/7`,
          state: "closed",
          merged_at: merged ? "2026-01-01T00:00:00Z" : null,
          head: { ref: "feat/x" },
          base: { ref: "main" },
        },
      ],
    });
    const intents = fakeIntents();
    await assert.rejects(client(fake).ensurePull(prArgs, { intents, requestId: "req-1" }), (e) => {
      assert.ok(e instanceof GithubError);
      assert.equal(e.code, "conflict");
      assert.match(e.message, /new branch|new work/);
      return true;
    });
    assert.equal(fake.state.calls.filter((c) => c.method === "POST").length, 0);
    assert.equal(fake.state.pulls.length, 1);
    assert.equal(intents.rows.get("req-1").state, "failed");
  });
}

test("ensurePull: lost response AFTER the server created the PR -> found again, same PR, 10 times", async () => {
  for (let i = 0; i < 10; i++) {
    const fake = fakeGithub();
    fake.hooks.afterPost = () => {
      throw new TypeError("fetch failed: socket hang up");
    };
    const intents = fakeIntents();
    const { pull, created } = await client(fake).ensurePull(prArgs, { intents, requestId: `req-${i}` });
    assert.equal(fake.state.pulls.length, 1, `iteration ${i}`);
    assert.equal(pull.number, fake.state.pulls[0].number);
    assert.equal(created, true);
    assert.equal(intents.rows.get(`req-${i}`).state, "confirmed");
    assert.equal(fake.state.calls.filter((c) => c.method === "POST").length, 1, "must not re-POST");
  }
});

test("ensurePull: timeout/5xx AFTER creation also reconciled (AbortError, 502)", async () => {
  for (const fail of [
    () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
    () => null, // 502 returned instead of the real response
  ]) {
    const fake = fakeGithub();
    fake.hooks.afterPost = () => {
      const e = fail();
      if (e) throw e;
    };
    if (!fail()) {
      const orig = fake.fetch;
      const wrapped = async (url, init) => {
        const res = await orig(url, init);
        return init?.method === "POST" ? json(502, { message: "Bad Gateway" }) : res;
      };
      fake.fetch = wrapped;
    }
    const { pull } = await client(fake).ensurePull(prArgs, { intents: fakeIntents(), requestId: "r" });
    assert.equal(fake.state.pulls.length, 1);
    assert.equal(pull.number, fake.state.pulls[0].number);
  }
});

test("ensurePull: failure BEFORE the server acted -> error surfaces, intent unknown, no PR; retry then creates exactly one", async () => {
  for (let i = 0; i < 10; i++) {
    const fake = fakeGithub();
    let fail = true;
    fake.hooks.beforePost = () => {
      if (fail) throw new TypeError("fetch failed: ECONNRESET");
    };
    // The throw happens inside the fake server before it records the PR, which the client sees as a network error.
    const intents = fakeIntents();
    const gh = client(fake);
    await assert.rejects(gh.ensurePull(prArgs, { intents, requestId: `req-${i}` }), (e) => e instanceof GithubError && e.code === "unknown");
    assert.equal(fake.state.pulls.length, 0, `iteration ${i}`);
    assert.equal(intents.rows.get(`req-${i}`).state, "unknown");

    fail = false;
    const { pull, created } = await gh.ensurePull(prArgs, { intents, requestId: `req-${i}` });
    assert.equal(created, true);
    assert.equal(fake.state.pulls.length, 1);
    assert.equal(intents.rows.get(`req-${i}`).state, "confirmed");
    assert.equal(pull.number, fake.state.pulls[0].number);
  }
});

test("ensurePull: creation response lost AND verification lookup also fails -> error, intent unknown (never silently re-created)", async () => {
  const fake = fakeGithub();
  let posted = false;
  fake.hooks.afterPost = () => {
    posted = true;
    throw new TypeError("fetch failed");
  };
  fake.hooks.onRequest = ({ method }) => {
    if (method === "GET" && posted) throw new TypeError("fetch failed again");
    return null;
  };
  const intents = fakeIntents();
  await assert.rejects(client(fake).ensurePull(prArgs, { intents, requestId: "req-1" }), (e) => e.code === "unknown");
  assert.equal(fake.state.pulls.length, 1);
  assert.equal(intents.rows.get("req-1").state, "unknown");
});

test("ensurePull: concurrent create race (422 already exists) resolves to the existing PR", async () => {
  const fake = fakeGithub();
  // Someone else creates the PR between our lookup and our POST.
  fake.hooks.beforePost = () => {
    fake.hooks.beforePost = null;
    fake.state.pulls.push({
      number: 55,
      html_url: `https://github.com/${REPO}/pull/55`,
      state: "open",
      head: { ref: "feat/x" },
      base: { ref: "main" },
    });
  };
  const { pull, created } = await client(fake).ensurePull(prArgs, { intents: fakeIntents(), requestId: "r" });
  assert.equal(pull.number, 55);
  assert.equal(created, false);
  assert.equal(fake.state.pulls.length, 1);
});

test("ensurePull: definite rejection (401) is not retried and marks the intent failed", async () => {
  const fake = fakeGithub();
  fake.hooks.onRequest = ({ method }) => (method === "POST" ? json(401, { message: "Bad credentials" }) : null);
  const intents = fakeIntents();
  await assert.rejects(client(fake).ensurePull(prArgs, { intents, requestId: "r" }), (e) => e.code === "unauthorized");
  assert.equal(intents.rows.get("r").state, "failed");
  assert.equal(fake.state.calls.filter((c) => c.method === "GET").length, 1); // no verification lookup needed
});

test("ensurePull works with an intents store that has no markSent", async () => {
  const fake = fakeGithub();
  const intents = fakeIntents();
  delete intents.markSent;
  const { created } = await client(fake).ensurePull(prArgs, { intents, requestId: "r" });
  assert.equal(created, true);
});

// ---------------------------------------------------------------- redaction

test("the token never appears in error text, evidence, or return values", async () => {
  const leaks = [];
  const check = (label, value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, Object.getOwnPropertyNames(value ?? {}));
    if (text?.includes(TOKEN)) leaks.push(label);
  };

  // fetch errors that echo the Authorization header / token
  const noisy = fakeGithub();
  noisy.hooks.onRequest = ({ init }) => {
    throw new TypeError(`fetch failed: request to http://gh.test failed, headers=${JSON.stringify(init.headers)} token=${TOKEN}`);
  };
  const gh = client(noisy);
  for (const [label, fn] of [
    ["listRepos", () => gh.listRepos()],
    ["listBranches", () => gh.listBranches(REPO)],
    ["getBranch", () => gh.getBranch(REPO, "x")],
    ["findPullByHead", () => gh.findPullByHead(REPO, "x")],
    ["createPull", () => gh.createPull(REPO, { head: "x", base: "main", title: "t" })],
  ]) {
    try {
      await fn();
      leaks.push(`${label}: did not throw`);
    } catch (e) {
      check(label, e.message);
      check(`${label}.stack`, e.stack ?? "");
      assert.ok(!("cause" in e) || e.cause === undefined, "no cause carried");
    }
  }

  // HTTP error bodies that echo the token
  const echo = fakeGithub();
  echo.hooks.onRequest = () => json(401, { message: `Bad credentials for ${TOKEN}` });
  try {
    await client(echo).listRepos();
  } catch (e) {
    check("401 body", e.message);
  }

  // ensurePull: intent evidence and thrown error
  const intents = fakeIntents();
  const failing = fakeGithub();
  failing.hooks.onRequest = ({ method }) => {
    if (method === "POST") throw new TypeError(`socket closed (Bearer ${TOKEN})`);
    return null;
  };
  try {
    await client(failing).ensurePull(prArgs, { intents, requestId: "r" });
  } catch (e) {
    check("ensurePull error", e.message);
  }
  check("intent row", [...intents.rows.values()]);

  // success return values
  const ok = fakeGithub();
  const res = await client(ok).ensurePull(prArgs, { intents: fakeIntents(), requestId: "ok" });
  check("success", res);

  assert.deepEqual(leaks, []);
});

test("redaction also scrubs generic GitHub token shapes when the injected token differs", async () => {
  const fake = fakeGithub();
  fake.hooks.onRequest = () => json(400, { message: "leaked ghp_AnotherTokenValue123456 and github_pat_11ABCDEF_xyz" });
  await assert.rejects(client(fake).listRepos(), (e) => {
    assert.ok(!/ghp_Another|github_pat_11/.test(e.message), e.message);
    return true;
  });
});
