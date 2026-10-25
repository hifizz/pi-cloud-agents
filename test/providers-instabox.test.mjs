// Offline tests for src/providers/instabox.mjs: the M1 provider contract (ensure/init/bash/status/list/release)
// against a fake fetch that mimics the instabox.sh REST surface (same fake shape as test/instabox.test.mjs).
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const { createInstaboxProvider } = await import("../src/providers/instabox.mjs");

const KEY = "ib_SECRETKEY1234567890";
const GH = "ghp_SECRETTOKEN1234567890";

const respond = (status, json) => ({
  status,
  ok: status >= 200 && status < 300,
  statusText: "",
  text: async () => (json === undefined ? "" : JSON.stringify(json)),
});
const ok = (json) => respond(200, json);
const apiFail = (status, code, message = "boom") => respond(status, { error: { code, message } });

const machine = (name, extra = {}) => ({ id: `id-${name}`, name, state: "running", metadata: { app: "pi-cloud-agents", ws: "w1" }, ...extra });

/**
 * Fake world. `world.machines`: name -> machine object (null value = deleted). Scripted extras:
 *   world.getError[name]: error thrown by GET for that name (undefined = normal lookup)
 *   world.createError: thrown by POST /v1/machines | world.createResult: operation state for create
 *   world.deleteResult: operation state for delete (default succeeded)
 */
function makeWorld() {
  const world = { machines: new Map(), calls: [], getError: {}, createError: null, createResult: "succeeded", deleteResult: "succeeded", opSeq: 0, execResults: new Map() };
  world.fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    world.calls.push({ method, path: u.pathname + u.search, headers: init.headers ?? {}, body });
    const enc = encodeURIComponent;
    if (u.pathname === "/v1/templates" && method === "GET") {
      return ok({ templates: [{ id: "agent-browser", version: "1" }, { id: "universal", version: "2" }] });
    }
    if (u.pathname === "/v1/machines" && method === "GET") {
      const meta = u.searchParams.getAll("metadata");
      const rows = [...world.machines.values()].filter((m) => meta.every((kv) => { const [k, v] = kv.split(":"); return m.metadata?.[k] === v; }));
      return ok({ machines: rows, cursor: null });
    }
    if (u.pathname === "/v1/machines" && method === "POST") {
      if (world.createError) {
        const e = world.createError;
        world.createError = null;
        if (e instanceof Error) throw e;
        return apiFail(e.status, e.code, e.message ?? "boom");
      }
      world.opSeq += 1;
      const op = { id: `op-${world.opSeq}`, machineId: `id-${body.name}`, type: "create", state: "running" };
      world.latestCreateOp = { op, state: world.createResult, name: body.name };
      if (world.createResult === "succeeded") world.machines.set(body.name, machine(body.name));
      return respond(202, op);
    }
    let m = /^\/v1\/machines\/([^/]+)$/.exec(u.pathname);
    if (m && method === "GET") {
      const name = decodeURIComponent(m[1]);
      const err = world.getError[name];
      if (err) {
        delete world.getError[name];
        if (err instanceof Error) throw err;
        return apiFail(err.status, err.code, err.message ?? "boom");
      }
      const found = [...world.machines.values()].find((x) => x.name === name || x.id === name);
      return found ? ok(found) : apiFail(404, "not_found", `no machine ${name}`);
    }
    m = /^\/v1\/machines\/([^/]+)$/.exec(u.pathname);
    if (m && method === "DELETE") {
      const name = decodeURIComponent(m[1]);
      const found = [...world.machines.values()].find((x) => x.name === name || x.id === name);
      if (!found) return apiFail(404, "not_found", "gone");
      world.machines.delete(found.name);
      world.opSeq += 1;
      world.latestDeleteOp = { id: `op-${world.opSeq}`, type: "delete", state: world.deleteResult };
      return respond(202, world.latestDeleteOp);
    }
    if (/\/exec$/.test(u.pathname) && method === "POST") {
      const seg = decodeURIComponent(u.pathname.split("/")[3]);
      const owner = [...world.machines.values()].find((x) => x.id === seg || x.name === seg);
      const scripted = owner && (world.execResults.get(seg) ?? world.execResults.get(owner.name));
      if (scripted) return ok(scripted); // stays for every exec until the test clears it
      // Undo the primitive's `exec /bin/sh -c '...'` wrapper so the git-config patterns see clean quoting.
      const wrapped = /^exec \/bin\/sh -c '(.*)'$/.exec(String(body.cmd).trim());
      const cmd = wrapped ? wrapped[1].replaceAll("'\\''", "'") : String(body.cmd);
      world.gitState ??= {};
      if (/^command -v gh/.test(cmd)) return ok({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false });
      const getAll = /^git config --global --get-all '([^']+)'$/.exec(cmd);
      if (getAll) {
        const v = world.gitState[getAll[1]];
        return ok({ stdout: v ?? "", stderr: "", exitCode: v === undefined ? 1 : 0, timedOut: false, truncated: false });
      }
      const set = /git config --global '([^']+)' '(.+)'$/.exec(cmd);
      if (set) {
        world.gitState[set[1]] = set[2];
        return ok({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false });
      }
      if (/^git config --global --unset-all/.test(cmd)) return ok({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false });
      return ok({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false });
    }
    if (/^\/v1\/operations\//.test(u.pathname) && method === "GET") {
      await new Promise((r) => setTimeout(r, 1));
      if (world.latestCreateOp && u.pathname.endsWith(world.latestCreateOp.op.id)) {
        const { op, state, name } = world.latestCreateOp;
        world.latestCreateOp = null;
        if (state === "succeeded") return ok({ ...op, state, machine: world.machines.get(name) });
        return ok({ ...op, state, error: { code: "create_failed", message: "no capacity" } });
      }
      if (world.latestDeleteOp && u.pathname.endsWith(world.latestDeleteOp.id)) {
        const op = { ...world.latestDeleteOp, state: "succeeded" };
        world.latestDeleteOp = null;
        return ok(op);
      }
      return ok({ id: u.pathname.split("/").pop(), state: "succeeded" });
    }
    throw new Error(`fake fetch: unhandled ${method} ${u.pathname}`);
  };
  return world;
}

const provider = (world, extra = {}) =>
  createInstaboxProvider({ fetchImpl: world.fetchImpl, apiKey: KEY, ghToken: GH, gitEmail: "bot@example.com", ...extra });
const rid = "req-1";
const NAME = "pca-" + sha256(rid).slice(0, 10); // runtimeName(rid), computed like the provider does

test("runtimeName is pca- + first 10 hex of sha256(requestId), same rule as sprites", async () => {
  const p = provider(makeWorld());
  assert.equal(p.runtimeName("abc"), "pca-ba7816bf8f");
  assert.equal(p.runtimeName("abc"), p.runtimeName("abc"));
  assert.notEqual(p.runtimeName("abc"), p.runtimeName("abd"));
  assert.throws(() => p.runtimeName(""), TypeError);
});

test("isManaged: prefix and (when known) metadata; the legacy shared machine name is never managed", async () => {
  const p = provider(makeWorld());
  assert.equal(p.isManaged("pca-aaaaaaaaaa"), true); // metadata unknown: name rule only
  assert.equal(p.isManaged("pca-aaaaaaaaaa", { app: "pi-cloud-agents" }), true);
  assert.equal(p.isManaged("pca-aaaaaaaaaa", { app: "other" }), false);
  assert.equal(p.isManaged("pca-aaaaaaaaaa", {}), false);
  assert.equal(p.isManaged("pi-cloud-agents", { app: "pi-cloud-agents" }), false);
  assert.equal(p.isManaged("other-machine"), false);
});

test("ensure creates with templateId + metadata and is idempotent (one create for two calls)", async () => {
  const world = makeWorld();
  const p = provider(world);
  const first = await p.ensure({ requestId: rid, workspaceId: "w1" });
  assert.deepEqual(first, { runtimeId: NAME, created: true });
  const second = await p.ensure({ requestId: rid, workspaceId: "w1" });
  assert.deepEqual(second, { runtimeId: NAME, created: false });
  const creates = world.calls.filter((c) => c.method === "POST" && c.path === "/v1/machines");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].body.templateId, "agent-browser"); // free-plan default picked from GET /v1/templates
  assert.deepEqual(creates[0].body.metadata, { app: "pi-cloud-agents", ws: "w1" });
  assert.match(creates[0].headers["idempotency-key"] ?? "", /^[\da-f-]{36}$/);
});

test("ensure with an explicit templateId never calls GET /v1/templates", async () => {
  const world = makeWorld();
  await provider(world, { templateId: "universal" }).ensure({ requestId: rid, workspaceId: "w1" });
  assert.ok(!world.calls.some((c) => c.path === "/v1/templates"));
  assert.equal(world.calls.find((c) => c.method === "POST" && c.path === "/v1/machines").body.templateId, "universal");
});

test("ensure does not create when getMachine fails with a network error or 5xx, and keeps status/apiCode", async () => {
  for (const err of [Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }), { status: 500, code: "internal" }]) {
    const world = makeWorld();
    world.getError[NAME] = err;
    const p = provider(world);
    await assert.rejects(
      () => p.ensure({ requestId: rid, workspaceId: "w1" }),
      (e) => (err.status ? e.status === 500 : /unreachable/i.test(e.message)),
    );
    assert.ok(!world.calls.some((c) => c.method === "POST" && c.path === "/v1/machines"), "must not create on doubt");
  }
});

test("ensure treats a create 409 as success after confirming metadata", async () => {
  const world = makeWorld();
  const name = NAME;
  world.createError = { status: 409, code: "operation_conflict" };
  // the concurrent creator made it with our labels
  world.machines.set(name, machine(name));
  const r = await provider(world).ensure({ requestId: rid, workspaceId: "w1" });
  assert.deepEqual(r, { runtimeId: name, created: false });
});

test("ensure refuses a same-named machine without our metadata (existing path and 409 path)", async () => {
  const name = NAME;
  const world = makeWorld();
  world.machines.set(name, machine(name, { metadata: { app: "someone-else" } }));
  await assert.rejects(() => provider(world).ensure({ requestId: rid, workspaceId: "w1" }), /refusing to use it/);

  const world2 = makeWorld();
  world2.createError = { status: 409, code: "operation_conflict" };
  world2.machines.set(name, machine(name, { metadata: {} }));
  await assert.rejects(() => provider(world2).ensure({ requestId: rid, workspaceId: "w1" }), /refusing to use it/);
});

test("ensure surfaces a failed create operation's message", async () => {
  const world = makeWorld();
  world.createResult = "failed";
  await assert.rejects(() => provider(world).ensure({ requestId: rid, workspaceId: "w1" }), /no capacity/);
});

test("status: available / missing (404) / unknown (5xx); suspended counts as available (bash wakes it)", async () => {
  const name = NAME;
  const world = makeWorld();
  const p = provider(world);
  world.machines.set(name, machine(name, { state: "suspended" }));
  assert.deepEqual(await p.status(name), { state: "available", raw: "suspended" });
  world.machines.delete(name);
  assert.deepEqual(await p.status(name), { state: "missing" });
  world.getError[name] = { status: 503, code: "no_capacity" };
  const unknown = await p.status(name);
  assert.equal(unknown.state, "unknown");
});

test("list returns only managed machines (metadata filter + client-side check)", async () => {
  const world = makeWorld();
  const mine = machine("pca-mine0000000000", { metadata: { app: "pi-cloud-agents", ws: "w9" } });
  world.machines.set("pca-mine0000000000", mine);
  world.machines.set("pca-notours000000", machine("pca-notours000000", { metadata: { app: "other" } }));
  world.machines.set("unrelated", machine("unrelated", { metadata: { app: "pi-cloud-agents" } })); // filtered by name rule
  const rows = await provider(world).list();
  assert.deepEqual(rows, [{ runtimeId: "pca-mine0000000000", labels: ["app:pi-cloud-agents", "ws:w9"] }]);
  const listCall = world.calls.find((c) => c.method === "GET" && c.path.startsWith("/v1/machines?"));
  assert.match(listCall.path, /metadata=app%3Api-cloud-agents/);
});

test("release: refuses unprefixed names and machines without our metadata; never deletes them", async () => {
  const world = makeWorld();
  const p = provider(world);
  world.machines.set("pi-cloud-agents", machine("pi-cloud-agents"));
  world.machines.set("pca-notours000000", machine("pca-notours000000", { metadata: { app: "other" } }));
  await assert.rejects(() => p.release("pi-cloud-agents"), /not a managed InstaBox machine/);
  await assert.rejects(() => p.release("pca-notours000000"), /missing metadata/);
  assert.equal(world.calls.filter((c) => c.method === "DELETE").length, 0);
});

test("release deletes a managed machine; 404 before the delete counts as already gone", async () => {
  const name = "pca-gone0000000000";
  const world = makeWorld();
  const p = provider(world);
  world.machines.set(name, machine(name));
  assert.deepEqual(await p.release(name), { released: true });
  assert.equal(world.machines.has(name), false);
  assert.deepEqual(await p.release(name), { released: false }); // now 404 on the read
});

test("bash(runtimeId) is cached per name, runs through the exec endpoint and carries GH_TOKEN in exec envs", async () => {
  const name = NAME;
  const world = makeWorld();
  world.machines.set(name, machine(name));
  const p = provider(world);
  const b = p.bash(name);
  assert.equal(p.bash(name), b);
  const r = await b("echo hi");
  assert.equal(r.exitCode, 0);
  const exec = world.calls.find((c) => c.method === "POST" && c.path.endsWith("/exec"));
  assert.equal(new URL(`http://x${exec.path}`).pathname, `/v1/machines/id-${name}/exec`); // bash resolves name -> machine id
  assert.equal(exec.body.envs.GH_TOKEN, GH);
  assert.ok(!exec.body.cmd.includes(GH));
});

test("init: gh + git steps over the exec endpoint, idempotent; no network-policy step on InstaBox", async () => {
  const name = NAME;
  const world = makeWorld();
  world.machines.set(name, machine(name));
  const p = provider(world);
  const { steps } = await p.init(name);
  assert.deepEqual(steps.map((s) => s.step), ["gh", "git"]); // no "network" step
  const cmds = world.calls.filter((c) => c.path.endsWith("/exec")).map((c) => c.body.cmd);
  assert.ok(cmds.some((c) => /command -v gh/.test(c)));
  assert.ok(cmds.some((c) => /git config --global/.test(c)));
  // idempotent second run: probes again, sets nothing new (config already equal -> one get per key, no set)
  const execBefore = world.calls.filter((c) => c.path.endsWith("/exec")).length;
  await p.init(name);
  const newCmds = world.calls.filter((c) => c.path.endsWith("/exec")).slice(execBefore).map((c) => c.body.cmd);
  assert.ok(newCmds.every((c) => !/--global --unset-all/.test(c) && !/gh_/.test(c) || /command -v gh/.test(c)));
});

test("init failure message is redacted and does not leak the token", async () => {
  const name = NAME;
  const world = makeWorld();
  world.machines.set(name, machine(name));
  world.execResults.set(name, { stdout: "", stderr: `fatal: bad credential ${GH}`, exitCode: 128, timedOut: false, truncated: false });
  await assert.rejects(
    () => provider(world).init(name),
    (e) => /instabox init step/.test(e.message) && !e.message.includes(GH),
  );
});

test("errors keep status/apiCode and are redacted (key never in messages)", async () => {
  const world = makeWorld();
  world.getError[NAME] = { status: 500, code: "internal", message: `upstream said ${KEY}` };
  await assert.rejects(
    () => provider(world).ensure({ requestId: rid, workspaceId: "w1" }),
    (e) => e.status === 500 && e.apiCode === "internal" && !e.message.includes(KEY),
  );
});

test("factory requires an API key", () => {
  assert.throws(() => createInstaboxProvider({ fetchImpl: async () => {} }), /INSTABOX_API_KEY/);
});

test("provider exposes kind/home for the workspace env", () => {
  const p = provider(makeWorld());
  assert.equal(p.kind, "instabox");
  assert.equal(p.home, "/data/home");
});
