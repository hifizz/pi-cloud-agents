// Startup wiring (M1-13): order of the pieces in src/server.mjs `assemble()` and the one property it exists for,
// "an interrupted tool call re-enters AFTER the Exec resolver is installed". No network, no real Sprite, no real model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const dataDir = mkdtempSync(join(tmpdir(), "pca-startup-"));
process.env.TARSBOT_NO_DOTENV = "1";
process.env.TARSBOT_DATA_DIR = dataDir; // nothing in this file may touch the repository's data/
const { assemble, assertStartupConfig, loadRoutes } = await import("../src/server.mjs");
const { ctx } = await import("../src/harness.mjs");
const { sha256Hex } = await import("../src/runner/client.mjs");
const { setExecResolver } = await import("../src/ext/exec.mjs");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const FAUX = { provider: "faux", modelId: "faux-1" };
const noopBash = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
const fakeProviders = () => ({ sprites: { kind: "sprites", home: "/home/sprite", bash: () => noopBash } });

/** In-memory runner shared by every `assemble()` of one test, like a Sprite that outlives the server process. */
function fakeRunnerWorld() {
  const runs = new Map();
  const calls = { prepare: 0, start: 0, kill: 0 };
  const world = {
    calls,
    runs,
    released: false,
    runnerFor: () => ({
      async prepare({ id, command }) {
        calls.prepare++;
        if (runs.has(id)) return { prepared: "existing" };
        runs.set(id, { command, started: false });
        return { prepared: "new", state: "claimed" };
      },
      async start(id) {
        calls.start++;
        runs.get(id).started = true;
        return { started: "yes", state: "running" };
      },
      async status(id) {
        const r = runs.get(id);
        if (!r) return { state: "missing" };
        return { state: world.released ? "exited" : "running", cmdSha256: sha256Hex(r.command) };
      },
      async wait({ id, from }) {
        const r = runs.get(id);
        if (!r) return { state: "missing", offset: from, size: 0, text: "", done: false };
        if (!world.released) {
          await new Promise((res) => setTimeout(res, 40));
          return { state: "running", offset: from, size: from, text: "" };
        }
        const out = "hello-from-runner\n";
        return { state: "exited", exit: 0, offset: out.length, size: out.length, text: out.slice(from), done: true };
      },
      async kill() {
        calls.kill++;
        return { killed: "confirmed" };
      },
    }),
  };
  return world;
}

async function openStorage(dir) {
  return openNodeSqliteStorage(join(dir, "alice.sqlite"));
}

async function waitFor(fn, ms = 15_000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, step));
  }
}

function seedReadyWorkspace(store, bot) {
  const project = store.projects.upsert({ repo: "o/r", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "startup-test",
    projectId: project.id,
    name: "w",
    baseBranch: "main",
    branch: "tarsbot/w-abc123",
    cwd: "/home/sprite/workspace/r",
    model: FAUX,
    task: null,
  });
  store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-test000001" });
  store.workspaces.update(workspace.id, { status: "ready" });
  store.links.link({ conversationId: String(bot.conversationId), workspaceId: workspace.id, botId: bot.id });
  return workspace;
}

test("assertStartupConfig: a missing SPRITES_TOKEN fails with a clear message that contains no values", () => {
  assert.throws(() => assertStartupConfig({}), /SPRITES_TOKEN/);
  assert.doesNotThrow(() => assertStartupConfig({ SPRITES_TOKEN: "x" }));
});

test("assemble on an empty data dir: control db created, harness resumed only after workspaces.resumePending", async () => {
  const dir = mkdtempSync(join(dataDir, "empty-"));
  const events = [];
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  const parts = await assemble({
    controlDbPath: join(dir, "control.sqlite"),
    checkpointDir: join(dir, "checkpoints"),
    botsPath: join(dir, "bots.json"),
    github: {},
    providers: fakeProviders(),
    runnerFor: fakeRunnerWorld().runnerFor,
    harnessOptions: { storage: await openStorage(dir), models },
    hooks: {
      afterHarnessOpen: ({ harness }) => {
        events.push("harness-open");
        const original = harness.resume.bind(harness);
        harness.resume = (...a) => {
          events.push("harness-resume");
          return original(...a);
        };
      },
      beforeResume: () => events.push("resume-pending-done"),
    },
  });
  let namespace;
  try {
    namespace = parts.store.meta.get("namespace");
    assert.deepEqual(events, ["harness-open", "resume-pending-done", "harness-resume"]);
    assert.ok(existsSync(join(dir, "control.sqlite")));
    assert.equal(typeof parts.store.meta.get("namespace"), "string");
    assert.equal(parts.store.meta.get("generation"), 1);
    assert.equal(parts.bots.list().length, 0, "no default bot is created any more");
    for (const key of ["workspaces", "github", "control", "checkpoints", "rebuild", "runtimeBash"]) {
      assert.ok(parts.ctxForApi[key], `ctxForApi.${key}`);
    }
  } finally {
    await parts.close();
  }
  // namespace survives a restart (run ids stay stable)
  const again = await assemble({
    controlDbPath: join(dir, "control.sqlite"),
    checkpointDir: join(dir, "checkpoints"),
    botsPath: join(dir, "bots.json"),
    github: {},
    providers: fakeProviders(),
    runnerFor: fakeRunnerWorld().runnerFor,
    harnessOptions: { storage: await openStorage(dir), models },
  });
  try {
    assert.equal(again.store.meta.get("namespace"), namespace);
  } finally {
    await again.close();
  }
});

test("a tool call interrupted by a restart re-enters after the resolver is installed and re-attaches (one start)", async () => {
  const dir = mkdtempSync(join(dataDir, "restart-"));
  const world = fakeRunnerWorld();
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello-from-runner" }, { id: "c1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("all done")]),
  ]);
  const common = {
    controlDbPath: join(dir, "control.sqlite"),
    checkpointDir: join(dir, "checkpoints"),
    botsPath: join(dir, "bots.json"),
    github: {},
    providers: fakeProviders(),
    runnerFor: world.runnerFor,
  };

  // --- process 1: start a command, then stop while it is still running -----------------------------------------------
  const first = await assemble({ ...common, harnessOptions: { storage: await openStorage(dir), models } });
  const bot = await first.bots.createBot({ name: "w", model: FAUX, cwd: "/home/sprite/workspace/r" });
  seedReadyWorkspace(first.store, bot);
  const conv = await first.bots.conversation(bot.id);
  await conv.submit({ type: "input", content: "run it", requestId: "r1" }, ctx);
  await waitFor(() => world.calls.start === 1);
  await first.close(); // the command keeps running in the "Sprite"
  assert.equal(world.calls.start, 1);

  // --- process 2: same files; the interrupted call must find its resolver the moment the harness resumes ------------
  world.released = true;
  setExecResolver(undefined); // a fresh process starts with no resolver
  const second = await assemble({ ...common, harnessOptions: { storage: await openStorage(dir), models } });
  try {
    const conv2 = await second.bots.conversation(bot.id);
    const text = await waitFor(async () => {
      const page = await conv2.entries({}, 50, undefined, ctx);
      const s = JSON.stringify(page.items);
      return s.includes("hello-from-runner") && s.includes("all done") ? s : null;
    });
    assert.ok(text.includes("hello-from-runner"));
    assert.ok(!text.includes("没有关联工作区"), "the resolver was ready before the interrupted call re-entered");
    assert.ok(!text.includes("执行解析器尚未设置"));
    assert.equal(world.calls.start, 1, "the command was started exactly once across the restart");
    assert.equal(world.calls.prepare, 1);
    assert.equal(world.calls.kill, 0);
  } finally {
    await second.close();
  }
});

test("loadRoutes + ctxForApi register every M1 route (rebuild included)", async () => {
  const dir = mkdtempSync(join(dataDir, "routes-"));
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  const parts = await assemble({
    controlDbPath: join(dir, "control.sqlite"),
    checkpointDir: join(dir, "checkpoints"),
    botsPath: join(dir, "bots.json"),
    github: {},
    providers: fakeProviders(),
    runnerFor: fakeRunnerWorld().runnerFor,
    harnessOptions: { storage: await openStorage(dir), models },
  });
  try {
    const seen = [];
    const app = {
      ctx: { harness: parts.harness, bots: parts.bots, ...parts.ctxForApi },
      guard() {},
      get: (p) => seen.push(`GET ${p}`),
      post: (p) => seen.push(`POST ${p}`),
      ws() {},
    };
    for (const register of await loadRoutes()) register(app);
    for (const want of [
      "POST /api/workspaces",
      "GET /api/workspaces",
      "POST /api/workspaces/:id/retry",
      "POST /api/workspaces/:id/pr",
      "POST /api/workspaces/:id/checkpoint",
      "GET /api/workspaces/:id/checkpoints",
      "POST /api/workspaces/:id/rebuild",
      "GET /api/github/repos",
      "POST /api/bots/:id/fork",
    ]) {
      assert.ok(seen.includes(want), `route missing: ${want}`);
    }
    assert.ok(!seen.includes("POST /api/bots"));
  } finally {
    await parts.close();
  }
});
