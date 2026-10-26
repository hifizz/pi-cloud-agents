// Shared runner-attempt helpers (src/runner/attempt.mjs): the exactly-once command flow used by the workspace service and by
// rebuild, the per-runtime client cache, and the sanitizer. Offline: fake store / runner, no Sprite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunnerCache, definite, isUncertain, makeSanitizer, runAttempt, uncertain } from "../src/runner/attempt.mjs";
import { createRunnerClient } from "../src/runner/client.mjs";
import { openControlStore } from "../src/control/store.mjs";

test("createRunnerCache: one client per runtime, getSync needs a factory, forget drops it", async () => {
  const made = [];
  const cache = createRunnerCache({ createClient: ({ bash }) => (made.push(bash), { bash }) });
  const provider = { bash: (id) => `bash:${id}` };
  const a1 = cache.getSync("pca-a", provider);
  assert.equal(cache.getSync("pca-a", provider), a1, "cached");
  assert.equal(await cache.get("pca-a", provider), a1, "get() shares the same entry");
  cache.getSync("pca-b", provider);
  assert.equal(cache.size, 2);
  assert.equal(cache.forget("pca-a"), true);
  assert.equal(cache.size, 1);
  assert.notEqual(cache.getSync("pca-a", provider), a1, "a forgotten runtime gets a fresh client");

  assert.throws(() => createRunnerCache().getSync("pca-x", provider), /no createClient/);
  const injected = createRunnerCache({ runnerFor: (id) => ({ id }) });
  assert.deepEqual(injected.getSync("pca-q"), { id: "pca-q" });
  assert.equal(injected.size, 0, "an injected runnerFor is not cached here");
});

test("makeSanitizer: secrets, credential shapes, URL userinfo / query and server paths are removed", () => {
  const sanitize = makeSanitizer(["supersecretvalue"]);
  const out = sanitize(
    "x supersecretvalue ghp_abcdefghijklmnopqrstuv https://u:p@host/p?token=abc Bearer abcdefgh12345678 /Users/me/proj/file.txt",
  );
  for (const bad of ["supersecretvalue", "ghp_abc", "u:p@", "token=abc", "abcdefgh12345678", "/Users/me"]) {
    assert.ok(!out.includes(bad), `${bad} leaked: ${out}`);
  }
  assert.equal(sanitize("a".repeat(700), 10).length, 11, "truncated with an ellipsis");
  assert.equal(sanitize(undefined), "");
});

test("isUncertain / definite / uncertain", () => {
  assert.equal(isUncertain(uncertain("x")), true);
  assert.equal(isUncertain(definite("x")), false);
  assert.equal(isUncertain({ statusCode: 503 }), true);
  assert.equal(isUncertain({ statusCode: 404 }), false);
  assert.equal(isUncertain(Object.assign(new Error("x"), { code: "ECONNRESET" })), true);
  assert.equal(isUncertain(new Error("Sprite exec connection ended, command may or may not have run")), true);
  assert.equal(isUncertain(new Error("exit 3")), false);
});

// ---- runAttempt ---------------------------------------------------------------------------------------------------------

function world(over = {}) {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "o/r", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({ requestId: "r", projectId: project.id, name: "n", baseBranch: "main", branch: "b", cwd: "/w", model: { provider: "p", modelId: "m" } });
  const calls = [];
  const runner = {
    prepare: async (a) => (calls.push(["prepare", a.id]), { prepared: "new" }),
    start: async (id) => (calls.push(["start", id]), {}),
    status: async (id) => (calls.push(["status", id]), { state: "running" }),
    wait: async () => ({ state: "exited", exit: 0, offset: 3, size: 3, text: "ok\n", done: true }),
    ...over,
  };
  const deps = { store, runner, sanitize: makeSanitizer(), now: () => Date.now(), sleep: async () => {}, stepTimeoutMs: 5_000, waitSeconds: 1, waitRetries: 2, retryDelayMs: 1 };
  const args = { workspaceId: workspace.id, keyPrefix: `ws:${workspace.id}:rt:code`, kind: "workspace.code", cwd: "/w", command: "true" };
  return { store, calls, deps, args };
}

test("runAttempt: prepare, mark sent, start, follow the log, confirm; a repeat is reused without touching the runner", async () => {
  const w = world();
  const r = await runAttempt(w.deps, w.args);
  assert.equal(r.reused, false);
  assert.equal(r.tail, "ok\n");
  assert.deepEqual(w.calls.map((c) => c[0]), ["prepare", "start"]);
  const again = await runAttempt(w.deps, w.args);
  assert.equal(again.reused, true);
  assert.equal(w.calls.length, 2, "nothing was prepared or started a second time");
  w.store.close();
});

test("runAttempt: a non-zero exit fails definitively and the next call opens a new attempt", async () => {
  let n = 0;
  const w = world({ wait: async () => ({ state: "exited", exit: n++ === 0 ? 2 : 0, offset: 4, size: 4, text: "bad\n", done: true }) });
  await assert.rejects(runAttempt(w.deps, w.args), (e) => e.uncertain === false && /退出码 2/.test(e.message));
  const r = await runAttempt(w.deps, w.args);
  assert.equal(r.reused, false);
  assert.equal(w.calls.filter((c) => c[0] === "start").length, 2, "attempt 1 failed, attempt 2 ran");
  w.store.close();
});

test("runAttempt: start throws and the run is claimed / lost / missing -> unconfirmed, and it is never started again", async () => {
  for (const state of ["claimed", "lost", "missing"]) {
    const w = world({ start: async () => { throw new Error("connection ended, command may or may not have run"); }, status: async () => ({ state }) });
    await assert.rejects(runAttempt(w.deps, w.args), (e) => e.uncertain === true && new RegExp(state).test(e.message));
    w.calls.length = 0;
    // retry: a new attempt, not a second start of the old run id
    w.deps.runner.start = async (id) => (w.calls.push(["start", id]), {});
    await runAttempt(w.deps, w.args);
    assert.equal(w.calls.filter((c) => c[0] === "start").length, 1);
    assert.equal(w.store.intents.list({ kind: "workspace.code" }).length, 2, "two attempts on record");
    w.store.close();
  }
});

test("runAttempt: a run that is still running after the deadline stays `sent` so a retry re-attaches (no second start)", async () => {
  let t = 0;
  const w = world({ wait: async () => ({ state: "running", offset: 0, size: 0, text: "" }) });
  w.deps.now = () => (t += 10_000);
  await assert.rejects(runAttempt(w.deps, w.args), (e) => e.uncertain === true && /仍在运行/.test(e.message));
  assert.equal(w.store.intents.list({ kind: "workspace.code" })[0].state, "sent");
  w.deps.runner.wait = async () => ({ state: "exited", exit: 0, offset: 1, size: 1, text: "x", done: true });
  w.deps.now = () => 0;
  w.calls.length = 0;
  const r = await runAttempt(w.deps, w.args);
  assert.equal(r.reused, false);
  assert.deepEqual(w.calls.map((c) => c[0]), ["status"], "re-attached by status only: no prepare, no start");
  w.store.close();
});

test("runAttempt: transient read errors are retried a bounded number of times", async () => {
  let n = 0;
  const w = world({
    wait: async () => {
      if (n++ < 2) throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
      return { state: "exited", exit: 0, offset: 1, size: 1, text: "k", done: true };
    },
  });
  assert.equal((await runAttempt(w.deps, w.args)).reused, false);
  const w2 = world({ wait: async () => { throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }); } });
  await assert.rejects(runAttempt(w2.deps, w2.args), /fetch failed/);
  w.store.close();
  w2.store.close();
});

// ---- runner client: the per-run decoder is released when the run ends -----------------------------------------------------

test("runner client wait(): a decoder kept for a split character is released when the run is lost / missing", async () => {
  const reply = (state, offset, size, bytes) => ({
    stdout: `state=${state}\noffset=${offset}\nsize=${size}\n\n--data--\n${Buffer.from(bytes).toString("base64")}`,
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });
  const script = [reply("running", 1, 3, [0xe4]), reply("missing", 1, 1, []), reply("running", 3, 3, [0xb8, 0xad])];
  const client = createRunnerClient({ bash: async () => script.shift(), readRetries: 0 });
  const first = await client.wait({ id: "r1", from: 0, maxSeconds: 0 });
  assert.equal(first.text, "", "half a character is held back");
  const gone = await client.wait({ id: "r1", from: 1, maxSeconds: 0 });
  assert.equal(gone.state, "missing");
  const later = await client.wait({ id: "r1", from: 1, maxSeconds: 0 });
  assert.notEqual(later.text, "中", "the old half character was dropped with the run, not carried into an unrelated read");
});
