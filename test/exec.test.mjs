// Tests for src/ext/exec.mjs (M1-06): the runner-backed, replay-safe `bash` tool.
//
// Everything is offline. The "sandbox" is a local /bin/sh running src/runner/runner.sh under a temp PCA_HOME (same technique as
// test/runner.test.mjs: on macOS a fake /proc and a perl setsid shim are injected, runner.sh itself is unchanged). The Harness is
// the real pi-durable 1.4.0 with fauxProvider. Cases that need a crash re-run this same file as a child process
// (EXEC_TEST_CHILD=1), SIGKILL it while the command runs, then re-open the same sqlite files in a second child.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openControlStore } from "../src/control/store.mjs";
import { shellQuote } from "../src/env.mjs";
import { ApprovalCenter, createApproval } from "../src/ext/approval.mjs";
import { Exec, createExec, setExecResolver } from "../src/ext/exec.mjs";
import { ctx, openHarness } from "../src/harness.mjs";
import { RunnerError, commandHash, createRunnerClient, runIdFor } from "../src/runner/client.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(SELF, "..", "..");
const CHILD = process.env.EXEC_TEST_CHILD === "1";
const RUNNER_SH = new URL("../src/runner/runner.sh", import.meta.url);
const HAS_PROC = process.platform === "linux" && existsSync("/proc/self/stat") && existsSync("/proc/sys/kernel/random/boot_id");
const HAS_PERL = existsSync("/usr/bin/perl") || existsSync("/usr/local/bin/perl") || existsSync("/opt/homebrew/bin/perl");
const DASH = ["/bin/dash", "/usr/bin/dash"].find((p) => existsSync(p));
const MAIN_SHELL = process.env.PCA_TEST_SHELL || DASH || "/bin/sh";
const CAN_RUN = HAS_PROC || HAS_PERL;

const FAUX = { provider: "faux", modelId: "faux-1" };
const q = (s) => shellQuote([s]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeoutMs = 15_000, everyMs = 25, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function bounded(promise, what, ms = 60_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`TIMEOUT: ${what} (${ms}ms)`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Local sandbox (copy of the approach in test/runner.test.mjs)
// ---------------------------------------------------------------------------------------------------------------------

const SETSID_SHIM = String.raw`#!/bin/sh
exec perl -MPOSIX -e '
POSIX::setsid() or die "setsid: $!";
my $dir = "$ENV{PCA_PROC_ROOT}/$$";
mkdir $dir;
my @f = ($$, "(w) S 9 (x y)", "S", 1, $$, $$, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, 1000000 + $$);
push @f, (0) x 30;
open(my $fh, ">", "$dir/stat") or die "stat: $!";
print $fh join(" ", @f), "\n";
close $fh;
exec(@ARGV) or die "exec: $!";
' "$@"
`;

/** Local stand-in for a provider `bash` primitive. `baseEnv` plays the role of the exec environment (GH_TOKEN lives there). */
function makeBash(baseEnv, calls = []) {
  return (command, { timeoutMs = 120_000, env } = {}) =>
    new Promise((resolve, reject) => {
      calls.push({ command, envNames: env ? Object.keys(env) : null });
      const child = spawn("/bin/sh", ["-c", command], { env: { ...baseEnv, ...(env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
      const out = [];
      const err = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), exitCode: code ?? -1, timedOut });
      });
    });
}

class Sandbox {
  constructor({ shell = MAIN_SHELL, extraEnv = {} } = {}) {
    this.root = mkdtempSync(join(tmpdir(), "pca-exec-test-"));
    this.home = join(this.root, "pca");
    this.work = join(this.root, "work");
    mkdirSync(this.work);
    this.calls = [];
    const src = readFileSync(RUNNER_SH, "utf8").replace(/^#!.*\n/, `#!${shell}\n`);
    this.runnerSource = join(this.root, "runner-under-test.sh");
    writeFileSync(this.runnerSource, src);
    this.env = { ...process.env, PCA_SH: shell, ...extraEnv };
    delete this.env.PCA_HOME;
    delete this.env.NODE_TEST_CONTEXT;
    if (!HAS_PROC) {
      const procRoot = join(this.root, "proc");
      mkdirSync(join(procRoot, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(procRoot, "sys/kernel/random/boot_id"), "11111111-2222-3333-4444-555555555555\n");
      const shim = join(this.root, "setsid-shim");
      writeFileSync(shim, SETSID_SHIM);
      chmodSync(shim, 0o755);
      this.env.PCA_PROC_ROOT = procRoot;
      this.env.PCA_SETSID = shim;
    }
    this.bash = makeBash(this.env, this.calls);
    this.bash.supportsEnv = true;
  }

  client(over = {}) {
    return createRunnerClient({ bash: this.bash, home: this.home, runnerSource: this.runnerSource, retryDelayMs: 5, ...over });
  }

  runDir(id) {
    return join(this.home, "runs", id);
  }

  walk(dir = this.home) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...this.walk(p));
      else out.push(p);
    }
    return out;
  }

  cleanup() {
    const runs = join(this.home, "runs");
    if (existsSync(runs)) {
      for (const id of readdirSync(runs)) {
        const dir = join(runs, id);
        if (existsSync(join(dir, "exit")) || !existsSync(join(dir, "ident"))) continue;
        const m = /^pid=(\d+)$/m.exec(readFileSync(join(dir, "ident"), "utf8"));
        const pid = m ? Number(m[1]) : 0;
        if (pid > 1 && pid !== process.pid && pid !== process.ppid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // gone
          }
        }
      }
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** A runner whose every call is logged (`log.push`), delegating to a real client. Never passes through `env`. */
function recordingRunner(client, log, runtime = "rt") {
  const summarize = (op, args) => {
    const a = args[0];
    if (op === "prepare") return { id: a.id, cwd: a.cwd, keys: Object.keys(a).sort() };
    if (op === "wait") return { id: a.id, from: a.from };
    return { id: typeof a === "string" ? a : a?.id };
  };
  const runner = {};
  for (const op of ["install", "prepare", "start", "wait", "status", "kill"]) {
    runner[op] = async (...args) => {
      log.push({ runtime, op, ...summarize(op, args) });
      return client[op](...args);
    };
  }
  return runner;
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------------------------------------------------

/** Control-store fixture: namespace / generation, one ready workspace with an active binding. */
function seed(store, { cwd, runtimeId = "rt-1", namespace } = {}) {
  store.meta.ensure("namespace", () => namespace ?? `ns-${randomBytes(6).toString("hex")}`);
  store.meta.ensure("generation", () => 1);
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "req-exec",
    projectId: project.id,
    name: "w",
    baseBranch: "main",
    branch: "tarsbot/w-abc123",
    cwd,
    model: FAUX,
    task: null,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  store.bindings.bind(workspace.id, { provider: "fake", runtimeId });
  return store.workspaces.get(workspace.id);
}

const call = (name, args, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const answer = (text) => fauxAssistantMessage([fauxText(text)]);

function fauxModels(responses) {
  const f = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  return models;
}

/** An ExecutionEnv whose exec must never be used (Exec has no fallback to api.env.exec). */
function makeThrowingEnv(counter) {
  return (target) => ({
    cwd: target?.cwd ?? "/",
    exec: async () => {
      counter.execCalls++;
      throw new Error("api.env.exec must not be used by the runner-backed bash");
    },
  });
}

async function toolResults(conv) {
  const page = await conv.entries({ order: "ascending" }, 100, undefined, ctx);
  return page.items
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => {
      const m = e.model[0];
      const items = m.content.filter((c) => c.type === "text").map((c) => c.text);
      return {
        toolName: m.toolName,
        isError: m.isError === true,
        details: m.details,
        output: items.filter((t) => !t.startsWith("<harness>")).join(""),
        harness: items.filter((t) => t.startsWith("<harness>")).join("\n"),
        text: items.join("\n"),
      };
    });
}

/**
 * One Harness + control store + real local runner. `runnerFor` hands out a recording runner (log in `world.log`).
 * @param {object} o
 * @param {Sandbox} o.sb
 * @param {any[]} o.responses faux model script
 * @param {boolean} [o.link] link the conversation to the workspace (default true)
 * @param {(x: {exec: any}) => any[]} [o.build] extension list (default [CodingTools, Exec])
 * @param {any} [o.execOptions]
 * @param {boolean} [o.defaultExec] use the exported `Exec` + setExecResolver instead of createExec
 */
async function openWorld({ sb, responses, link = true, build, execOptions = {}, defaultExec = false, storage, store, cwd }) {
  const log = [];
  const counter = { execCalls: 0 };
  const theStore = store ?? openControlStore({ path: null });
  const workspace = theStore.workspaces.list()[0] ?? seed(theStore, { cwd: cwd ?? sb.work });
  const client = sb.client();
  const runnerFor = ({ binding }) => recordingRunner(client, log, binding.runtimeId);
  const exec = defaultExec ? Exec : createExec({ store: theStore, runnerFor, waitSeconds: 1, ...execOptions });
  if (defaultExec) {
    setExecResolver(({ conversationId }) => {
      const ws = theStore.links.workspaceOf(String(conversationId));
      if (!ws) return undefined;
      const binding = theStore.bindings.current(ws.id);
      return { store: theStore, workspace: ws, binding, runner: recordingRunner(client, log, binding.runtimeId) };
    });
  }
  const extensions = build ? build({ exec }) : [CodingTools, exec];
  const { harness } = await openHarness({
    storage: storage ?? new MemoryStorage(),
    models: fauxModels(responses),
    extensions,
    env: makeThrowingEnv(counter),
    settings: { progress: { partialIntervalMs: 20, outputIntervalMs: 20 } },
  });
  const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: FAUX, cwd: cwd ?? sb.work } }, ctx);
  if (link) theStore.links.link({ conversationId: String(conv.id), workspaceId: workspace.id });
  return {
    harness,
    conv,
    store: theStore,
    workspace,
    log,
    counter,
    client,
    async submit(content = "go") {
      return conv.submit({ type: "input", content }, ctx);
    },
    async run(content = "go") {
      const sub = await conv.submit({ type: "input", content }, ctx);
      await bounded(sub.wait(ctx), "submission settle");
      await bounded(conv.waitForIdle(ctx), "idle");
      return toolResults(conv);
    },
    async close() {
      await bounded(harness.close(ctx), "harness close", 10_000);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Direct-call fixtures: drive `execute` with a hand-made ToolExecutionApi (state matrix, failure injection)
// ---------------------------------------------------------------------------------------------------------------------

function fakeRunner(overrides = {}) {
  const calls = [];
  const defaults = {
    prepare: async () => ({ prepared: "new", state: "claimed" }),
    start: async () => ({ started: "new", state: "running" }),
    status: async () => ({ state: "running", cmdSha256: undefined }),
    wait: async ({ from }) => {
      await sleep(20);
      return { state: "running", offset: from, size: from, bytes: Buffer.alloc(0), text: "", done: false };
    },
    kill: async () => ({ killed: "confirmed" }),
  };
  const runner = { calls };
  for (const op of Object.keys(defaults)) {
    const impl = overrides[op] ?? defaults[op];
    runner[op] = async (...args) => {
      calls.push([op, ...args]);
      return impl(...args);
    };
  }
  runner.ops = () => calls.map((c) => c[0]);
  return runner;
}

function directWorld(sb) {
  const store = openControlStore({ path: null });
  const workspace = seed(store, { cwd: sb.work });
  store.links.link({ conversationId: "conv-direct", workspaceId: workspace.id });
  const binding = store.bindings.current(workspace.id);
  const namespace = store.meta.get("namespace");
  return {
    store,
    workspace,
    binding,
    runIdOf: (taskId) => runIdFor({ namespace, generation: 1, taskId }),
    preclaim({ taskId, command, cwd = sb.work }) {
      return store.executions.claim({
        runId: runIdFor({ namespace, generation: 1, taskId }),
        workspaceId: workspace.id,
        runtimeId: binding.runtimeId,
        bindingVersion: binding.version,
        cwd,
        commandHash: commandHash(command, cwd),
      });
    },
  };
}

function directApi({ taskId, cwd, memos = new Map(), abortRequested = false }) {
  const out = [];
  const diagnostics = [];
  const details = [];
  const api = {
    taskId,
    conversationId: "conv-direct",
    callId: "call-direct",
    now: () => Date.now(),
    output: (c) => out.push(String(c)),
    diagnostic: (d) => diagnostics.push(d),
    details: async (v) => {
      details.push(JSON.parse(JSON.stringify(v)));
    },
    memo: async (name, ...rest) => {
      if (rest.length === 1) return memos.get(name);
      if (!memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
    agent: async () => ({ cwd }),
    getTask: async () => ({ abortRequested }),
  };
  return { api, out, diagnostics, details, memos };
}

async function callDirect(d, { command, timeout, taskId, runner, cwd, memos, abortRequested, abortAfterMs, execOptions = {} }) {
  const ext = createExec({
    store: d.store,
    runnerFor: () => runner,
    waitSeconds: 1,
    retryBudgetMs: 150,
    sleep: () => sleep(5),
    ...execOptions,
  });
  const fake = directApi({ taskId, cwd, memos, abortRequested });
  const controller = new AbortController();
  const context = withAbortSignal(controller.signal, ctx);
  if (abortAfterMs !== undefined) setTimeout(() => controller.abort(), abortAfterMs);
  try {
    const result = await bounded(ext.tools[0].execute({ command, timeout }, fake.api, context), "direct execute", 30_000);
    return { result, ...fake };
  } catch (error) {
    return { error, ...fake };
  }
}

const isUnconfirmed = (result) =>
  result?.isError === true && result.diagnostics?.some((x) => x.code === "result_unconfirmed" && /结果待确认/.test(x.message));

// ---------------------------------------------------------------------------------------------------------------------
// Child process (crash-recovery cases)
// ---------------------------------------------------------------------------------------------------------------------

async function childMain() {
  setTimeout(() => process.exit(124), 120_000).unref();
  const dir = process.env.EXEC_DIR;
  const phase = process.env.EXEC_PHASE;
  const work = process.env.EXEC_WORK;
  const logFile = join(dir, `runner-${phase}.jsonl`);
  const log = { push: (e) => appendFileSync(logFile, `${JSON.stringify(e)}\n`) };
  const counter = { execCalls: 0 };
  const client = createRunnerClient({ bash: Object.assign(makeBash(process.env), { supportsEnv: true }), home: process.env.EXEC_RUNNER_HOME, retryDelayMs: 5 });
  const store = openControlStore({ path: join(dir, "control.sqlite") });
  const workspace = phase === "first" ? seed(store, { cwd: work }) : store.workspaces.list()[0];
  const exec = createExec({
    store,
    runnerFor: ({ binding }) => recordingRunner(client, log, binding.runtimeId),
    waitSeconds: 2,
  });
  const responses = phase === "first" ? [call("bash", { command: process.env.EXEC_COMMAND }), answer("done")] : [answer("recovered")];
  const { harness } = await openHarness({
    storage: await openNodeSqliteStorage(join(dir, "db.sqlite")),
    models: fauxModels(responses),
    extensions: [CodingTools, exec],
    env: makeThrowingEnv(counter),
    settings: { progress: { partialIntervalMs: 20, outputIntervalMs: 20 } },
    resume: false,
  });
  if (phase === "first") {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: FAUX, cwd: work } }, ctx);
    store.links.link({ conversationId: String(conv.id), workspaceId: workspace.id });
    writeFileSync(join(dir, "conv"), String(conv.id));
    harness.resume();
    await conv.submit({ type: "input", content: "go" }, ctx);
    await new Promise(() => {}); // killed from outside, never closed
  } else {
    const conv = await harness.conversation(readFileSync(join(dir, "conv"), "utf8"), ctx);
    harness.resume();
    await bounded(conv.waitForIdle(ctx), "recovered idle", 90_000);
    const results = await toolResults(conv);
    process.stdout.write(`RESULT ${JSON.stringify({ results, execCalls: counter.execCalls })}\n`);
    await harness.close(ctx);
    store.close();
    process.exit(0);
  }
}

function spawnChild(sb, dir, phase, command) {
  const env = {
    ...sb.env,
    TARSBOT_NO_DOTENV: "1",
    EXEC_TEST_CHILD: "1",
    EXEC_DIR: dir,
    EXEC_PHASE: phase,
    EXEC_WORK: sb.work,
    EXEC_RUNNER_HOME: sb.home,
    EXEC_COMMAND: command,
  };
  const p = spawn(process.execPath, [SELF], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  p.stdout.on("data", (b) => (stdout += b));
  p.stderr.on("data", (b) => (stderr += b));
  const done = new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { p, done };
}

function readJsonl(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** SIGKILL the control process while the command runs; re-open the same sqlite files; return what the recovered task did. */
async function crashAndRecover({ rebuild = false }) {
  const sb = new Sandbox();
  const dir = mkdtempSync(join(tmpdir(), "pca-exec-crash-"));
  let first;
  let second;
  try {
    await sb.client().install();
    const counter = join(sb.work, "counter");
    const command = `echo begin; echo run; echo run >> ${q(counter)}; sleep 1; echo end`;
    first = spawnChild(sb, dir, "first", command);
    await until(() => existsSync(counter), { timeoutMs: 40_000, what: "command started" });
    first.p.kill("SIGKILL");
    const killed = await first.done;
    assert.equal(killed.signal, "SIGKILL", `first child: ${JSON.stringify(killed).slice(0, 500)}`);
    if (rebuild) {
      const s = openControlStore({ path: join(dir, "control.sqlite") });
      s.bindings.bind(s.workspaces.list()[0].id, { provider: "fake", runtimeId: "rt-2" });
      s.close();
    }
    second = spawnChild(sb, dir, "second", command);
    const r = await second.done;
    const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `second child failed: code=${r.code} signal=${r.signal}\n${r.stdout.slice(-800)}\n${r.stderr.slice(-800)}`);
    const result = JSON.parse(line.slice(7));
    const control = openControlStore({ path: join(dir, "control.sqlite") });
    const executions = control.executions;
    const summary = {
      result,
      counterLines: readFileSync(counter, "utf8").trim().split("\n").length,
      log1: readJsonl(join(dir, "runner-first.jsonl")),
      log2: readJsonl(join(dir, "runner-second.jsonl")),
      execution: result.results[0]?.details?.runId ? executions.get(result.results[0].details.runId) : undefined,
    };
    control.close();
    return summary;
  } finally {
    for (const c of [first, second]) {
      if (c && c.p.exitCode === null && c.p.signalCode === null) c.p.kill("SIGKILL");
      if (c) await c.done;
    }
    sb.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

// =====================================================================================================================
if (CHILD) {
  await childMain();
} else {
  const skip = CAN_RUN ? false : "needs /proc (Linux) or perl (macOS emulation of setsid + /proc)";

  // -------------------------------------------------------------------------------------------------------------------
  describe("Exec: registration and resolution", () => {
    it("exports the extension, the resolver setter and the factory; tool is bash, replay safe, command/timeout params", () => {
      assert.equal(Exec.name, "tarsbot.exec");
      assert.equal(typeof setExecResolver, "function");
      assert.equal(typeof createExec, "function");
      const tool = Exec.tools[0];
      assert.equal(tool.name, "bash");
      assert.equal(tool.replay, "safe");
      assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["command", "timeout"]);
      assert.deepEqual(tool.parameters.required, ["command"]);
    });

    it("[CodingTools, Exec] override the built-in bash: one bash offered to the model, replay safe, read/write/edit stay built-in", { skip }, async () => {
      const sb = new Sandbox();
      const offered = [];
      let world;
      try {
        world = await openWorld({
          sb,
          responses: [
            (context) => {
              offered.push(context.messages.filter((m) => m.role === "system").flatMap((m) => m.toolsAdded ?? []));
              return answer("ok");
            },
          ],
        });
        const agent = await world.conv.agent(ctx);
        const bashTools = agent.tools.filter((t) => t.name === "bash");
        const exec = createExec({ resolve: () => undefined });
        assert.equal(bashTools.length, 1, "exactly one bash in the agent's tool list");
        assert.equal(bashTools[0].replay, "safe");
        const builtinDescription = CodingTools.tools.find((t) => t.name === "bash").description;
        assert.ok(bashTools[0].description.startsWith(builtinDescription.slice(0, -1)), "equivalent to the built-in description for the model");
        assert.notEqual(bashTools[0].description, builtinDescription, "the description is this extension's own");
        assert.equal(bashTools[0].description, exec.tools[0].description);
        for (const name of ["read", "write", "edit"]) {
          assert.equal(agent.tools.find((t) => t.name === name), CodingTools.tools.find((t) => t.name === name), `${name} is still the built-in one`);
        }
        await world.run("hi");
        assert.equal(offered[0]?.filter((t) => t.name === "bash").length, 1, "the model is offered a single bash");
        assert.match(offered[0].find((t) => t.name === "bash").description, /Execute a bash command/);
        assert.match(offered[0].find((t) => t.name === "bash").description, /unconfirmed/i);
      } finally {
        await world?.close();
        sb.cleanup();
      }
    });

    it("no workspace for the conversation: clear error, and api.env.exec is never called", { skip }, async () => {
      const sb = new Sandbox();
      let world;
      try {
        // (a) createExec with the store resolver, conversation not linked
        world = await openWorld({ sb, link: false, responses: [call("bash", { command: "touch should-not-exist" }), answer("end")] });
        const [r] = await world.run();
        assert.equal(r.isError, true);
        assert.match(r.text, /没有关联工作区/);
        assert.equal(world.counter.execCalls, 0, "no fallback to api.env.exec");
        assert.equal(world.log.length, 0, "the runner was not touched");
        assert.ok(!existsSync(join(sb.work, "should-not-exist")));
        await world.close();
        world = undefined;

        // (b) the exported Exec with a resolver that finds nothing
        world = await openWorld({ sb, link: true, defaultExec: true, responses: [call("bash", { command: "touch nope" }), answer("end")] });
        setExecResolver(() => undefined);
        const [r2] = await world.run();
        assert.equal(r2.isError, true);
        assert.match(r2.text, /没有关联工作区/);
        assert.equal(world.counter.execCalls, 0);
        await world.close();
        world = undefined;

        // (c) the exported Exec before any resolver was installed
        setExecResolver(undefined);
        world = await openWorld({ sb, link: true, defaultExec: true, responses: [call("bash", { command: "touch nope2" }), answer("end")] });
        setExecResolver(undefined);
        const [r3] = await world.run();
        assert.equal(r3.isError, true);
        assert.match(r3.text, /解析器尚未设置/);
        assert.equal(world.counter.execCalls, 0);
        assert.ok(!existsSync(join(sb.work, "nope")) && !existsSync(join(sb.work, "nope2")));
      } finally {
        setExecResolver(undefined);
        await world?.close();
        sb.cleanup();
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("Exec: running commands through the real runner", { skip }, () => {
    /** @type {Sandbox} */
    let sb;
    before(async () => {
      sb = new Sandbox();
      await sb.client().install();
    });
    after(() => {
      setExecResolver(undefined);
      sb?.cleanup();
    });

    it("runs a command: output, exit 0, details are runId/state/exit/offset only, execution recorded (default Exec + setExecResolver)", async () => {
      const world = await openWorld({ sb, defaultExec: true, responses: [call("bash", { command: "echo hello; echo world >&2; pwd -P" }), answer("done")] });
      try {
        const [r] = await world.run();
        assert.equal(r.isError, false, r.text);
        const { realpathSync } = await import("node:fs");
        assert.equal(r.output, `hello\nworld\n${realpathSync(sb.work)}\n`, "stdout and stderr merged, cwd = the agent cwd");
        assert.deepEqual(Object.keys(r.details).sort(), ["exit", "offset", "runId", "state"]);
        assert.match(r.details.runId, /^[0-9a-f]{24}$/);
        assert.equal(r.details.state, "exited");
        assert.equal(r.details.exit, 0);
        assert.equal(r.details.offset, Buffer.byteLength(r.output));
        const row = world.store.executions.get(r.details.runId);
        assert.equal(row.state, "exited");
        assert.deepEqual(row.exit, { code: 0 });
        assert.equal(row.workspaceId, world.workspace.id);
        assert.equal(row.runtimeId, "rt-1");
        assert.equal(row.bindingVersion, 1);
        assert.equal(world.counter.execCalls, 0);
        const ops = world.log.map((e) => e.op);
        assert.equal(ops.filter((o) => o === "prepare").length, 1);
        assert.equal(ops.filter((o) => o === "start").length, 1);
        assert.ok(ops.indexOf("prepare") < ops.indexOf("start"));
        const prep = world.log.find((e) => e.op === "prepare");
        assert.ok(!prep.keys.includes("env"), "env is never passed to prepare");
        assert.equal(world.log.find((e) => e.op === "wait").from, 0);
      } finally {
        await world.close();
      }
    });

    it("non-zero exit is an error result carrying the output and the exit code (like the built-in bash)", async () => {
      const world = await openWorld({ sb, responses: [call("bash", { command: "echo partial; exit 7" }), answer("done")] });
      try {
        const [r] = await world.run();
        assert.equal(r.isError, true);
        assert.equal(r.output, "partial\n");
        assert.match(r.harness, /Command exited with code 7/);
        assert.equal(r.details.exit, 7);
        assert.deepEqual(world.store.executions.get(r.details.runId).exit, { code: 7 });
      } finally {
        await world.close();
      }
    });

    it("timeout: the command is killed (process group) and the result says it was stopped", async () => {
      const world = await openWorld({ sb, responses: [call("bash", { command: "echo before; sleep 60", timeout: 1 }), answer("done")] });
      try {
        const t0 = Date.now();
        const [r] = await world.run();
        assert.ok(Date.now() - t0 < 20_000, "did not wait for the sleep");
        assert.equal(r.isError, true);
        assert.match(r.text, /timed out after 1 seconds/);
        assert.match(r.text, /已停止/);
        assert.doesNotMatch(r.text, /停止待确认/);
        assert.ok(r.output.startsWith("before\n"), r.output); // the shell may append its own "Terminated" notice
        const st = await sb.client().status(r.details.runId);
        assert.equal(st.state, "exited");
        assert.equal(st.exit, 143, "SIGTERM to the group");
        assert.equal(world.store.executions.get(r.details.runId).state, "exited");
      } finally {
        await world.close();
      }
    });

    it("user abort: the process group is killed before the tool returns", async () => {
      const marker = join(sb.work, `abort-${randomBytes(3).toString("hex")}`);
      const world = await openWorld({ sb, responses: [call("bash", { command: `echo started; touch ${q(marker)}; sleep 60` }), answer("done")] });
      try {
        const sub = await world.submit();
        await until(() => existsSync(marker), { what: "command running" });
        const [open] = world.store.executions.listOpen();
        assert.ok(open, "execution is recorded while running");
        await bounded(world.conv.abort(ctx), "abort");
        await sub.wait(ctx).catch(() => undefined);
        await bounded(world.conv.waitForIdle(ctx), "idle");
        const st = await sb.client().status(open.runId);
        assert.equal(st.state, "exited", "the command is gone");
        assert.equal(st.exit, 143);
        const row = world.store.executions.get(open.runId);
        assert.equal(row.state, "exited");
        assert.deepEqual(row.exit, { killed: "abort" });
        const [r] = await toolResults(world.conv);
        assert.equal(r.isError, true);
        assert.match(r.text, /abort/i);
      } finally {
        await world.close();
      }
    });

    it("closing the Harness (restart/shutdown) does NOT kill the command: it keeps running to be re-attached", async () => {
      const marker = join(sb.work, `close-${randomBytes(3).toString("hex")}`);
      const world = await openWorld({ sb, responses: [call("bash", { command: `touch ${q(marker)}; sleep 30` }), answer("done")] });
      let runId;
      try {
        await world.submit();
        await until(() => existsSync(marker), { what: "command running" });
        runId = world.store.executions.listOpen()[0].runId;
        await world.close();
        const st = await sb.client().status(runId);
        assert.equal(st.state, "running", "still running after the control process closed");
        assert.ok(!world.log.some((e) => e.op === "kill"), "no kill was issued");
        assert.equal(world.store.executions.get(runId).state, "started");
      } finally {
        if (runId) await sb.client().kill(runId, { graceSeconds: 1 }).catch(() => undefined);
      }
    });

    it("the same callId used twice in one conversation gives two different runIds and two executions", async () => {
      const counter = join(sb.work, `callid-${randomBytes(3).toString("hex")}`);
      const world = await openWorld({
        sb,
        responses: [
          call("bash", { command: `echo A >> ${q(counter)}; echo first` }, "c1"),
          call("bash", { command: `echo B >> ${q(counter)}; echo second` }, "c1"),
          answer("end"),
        ],
      });
      try {
        const results = await world.run();
        assert.equal(results.length, 2);
        assert.deepEqual(results.map((r) => r.output), ["first\n", "second\n"]);
        assert.notEqual(results[0].details.runId, results[1].details.runId);
        assert.equal(readFileSync(counter, "utf8"), "A\nB\n", "each command ran exactly once");
        assert.equal(world.log.filter((e) => e.op === "start").length, 2);
      } finally {
        await world.close();
      }
    });

    it("with Approval installed after Exec, a dangerous command still stops at approval and nothing reaches the runner", async () => {
      const victim = join(sb.work, `victim-${randomBytes(3).toString("hex")}`);
      for (const approve of [false, true]) {
        mkdirSync(victim, { recursive: true });
        writeFileSync(join(victim, "f"), "x");
        const center = new ApprovalCenter();
        const world = await openWorld({
          sb,
          build: ({ exec }) => [CodingTools, exec, createApproval({ center })],
          responses: [call("bash", { command: `rm -rf ${q(victim)}` }), answer("end")],
        });
        try {
          const sub = await world.submit();
          await until(() => center.list().length === 1, { what: "pending approval" });
          assert.equal(center.list()[0].toolName, "bash");
          assert.equal(world.log.length, 0, "nothing was prepared / started before the verdict");
          assert.ok(existsSync(victim), "not deleted yet");
          center.resolve(center.list()[0].taskId, approve);
          await bounded(sub.wait(ctx), "settle");
          await bounded(world.conv.waitForIdle(ctx), "idle");
          const [r] = await toolResults(world.conv);
          if (approve) {
            assert.equal(r.isError, false, r.text);
            assert.ok(!existsSync(victim), "approved: executed through the runner");
            assert.equal(world.log.filter((e) => e.op === "start").length, 1);
          } else {
            assert.equal(r.isError, true);
            assert.match(r.text, /User denied/);
            assert.ok(existsSync(victim), "denied: still there");
            assert.equal(world.log.length, 0, "denied: runner untouched");
          }
        } finally {
          await world.close();
          rmSync(victim, { recursive: true, force: true });
        }
      }
      // a harmless command needs no approval
      const center = new ApprovalCenter();
      const world = await openWorld({ sb, build: ({ exec }) => [CodingTools, exec, createApproval({ center })], responses: [call("bash", { command: "echo fine" }), answer("end")] });
      try {
        const [r] = await world.run();
        assert.equal(r.output, "fine\n");
        assert.equal(center.list().length, 0);
      } finally {
        await world.close();
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("Exec: secrets", { skip }, () => {
    it("an injected fake token never shows up in output, errors, details, memo, the control store or the runner state; env is never passed to the runner", async () => {
      const TOKEN = `ghp_${randomBytes(18).toString("hex")}`;
      const needles = [TOKEN, Buffer.from(TOKEN).toString("base64"), Buffer.from(TOKEN).toString("hex"), encodeURIComponent(TOKEN)];
      const sb = new Sandbox({ extraEnv: { GH_TOKEN: TOKEN } });
      const dir = mkdtempSync(join(tmpdir(), "pca-exec-secret-"));
      let world;
      try {
        await sb.client().install();
        const store = openControlStore({ path: join(dir, "control.sqlite") });
        world = await openWorld({
          sb,
          store,
          storage: await openNodeSqliteStorage(join(dir, "db.sqlite")),
          responses: [
            call("bash", { command: '[ -n "$GH_TOKEN" ] && echo token-inherited' }, "c1"),
            call("bash", { command: "echo oops >&2; exit 3" }, "c2"),
            call("bash", { command: "echo late", timeout: 30 }, "c3"),
            answer("end"),
          ],
        });
        const results = await world.run();
        assert.equal(results[0].output, "token-inherited\n", "the command did see the token through the provider bash environment");
        assert.equal(results[1].isError, true);
        const everything = JSON.stringify(results);
        for (const n of needles) assert.ok(!everything.includes(n), "token in tool results");
        assert.ok(sb.calls.length > 0);
        assert.ok(sb.calls.every((c) => c.envNames === null), "no call to the provider bash carried per-call env");
        for (const c of sb.calls) for (const n of needles) assert.ok(!c.command.includes(n), "token in a command line");
        assert.ok(world.log.filter((e) => e.op === "prepare").every((e) => !e.keys.includes("env")));
        await world.close();
        world = undefined;
        store.close();
        const files = [...sb.walk(sb.home), ...readdirSync(dir).map((f) => join(dir, f))];
        assert.ok(files.length > 5);
        for (const f of files) {
          const bytes = readFileSync(f).toString("latin1");
          for (const n of needles) assert.ok(!bytes.includes(n), `${f} contains the token`);
        }
        // control: the scan would have caught it
        const planted = join(dir, "planted");
        writeFileSync(planted, `x${TOKEN}y`);
        assert.ok(readFileSync(planted).toString("latin1").includes(TOKEN));
      } finally {
        await world?.close();
        sb.cleanup();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("Exec: re-entry decisions (hand-driven execute, real local runner)", { skip }, () => {
    /** @type {Sandbox} */
    let sb;
    before(async () => {
      sb = new Sandbox();
      await sb.client().install();
    });
    after(() => sb?.cleanup());

    const launchAs = async (client, runId, command) => {
      await client.prepare({ id: runId, cwd: sb.work, command });
      await client.start(runId);
    };
    const finish = async (client, runId) => {
      await until(async () => (await client.status(runId)).state === "exited", { what: "command exit" });
    };

    it("already finished before re-entry: full log from offset 0, exit code reported, nothing prepared / started", async () => {
      for (const [code, isError] of [[0, false], [3, true]]) {
        const d = directWorld(sb);
        const client = sb.client();
        const command = `echo one; echo two; exit ${code}`;
        const runId = d.runIdOf(11);
        await launchAs(client, runId, command);
        await finish(client, runId);
        d.preclaim({ taskId: 11, command });
        const log = [];
        const { result, out, error } = await callDirect(d, { command, taskId: 11, runner: recordingRunner(client, log) });
        assert.ifError(error);
        assert.equal(Boolean(result.isError), isError);
        assert.equal(out.join(""), "one\ntwo\n");
        assert.deepEqual(log.map((e) => e.op).filter((o) => o === "prepare" || o === "start" || o === "kill"), []);
        assert.equal(log.find((e) => e.op === "wait").from, 0);
        assert.equal(d.store.executions.get(runId).state, "exited");
      }
    });

    it("still running at re-entry: re-attaches, follows the log from offset 0 to the end, no second start", async () => {
      const d = directWorld(sb);
      const client = sb.client();
      const counter = join(sb.work, `reattach-${randomBytes(3).toString("hex")}`);
      const command = `echo begin; echo x >> ${q(counter)}; sleep 1; echo end`;
      const runId = d.runIdOf(12);
      await launchAs(client, runId, command);
      d.preclaim({ taskId: 12, command });
      const log = [];
      const { result, out, details, error } = await callDirect(d, { command, taskId: 12, runner: recordingRunner(client, log) });
      assert.ifError(error);
      assert.ok(!result.isError);
      assert.equal(out.join(""), "begin\nend\n");
      assert.equal(readFileSync(counter, "utf8"), "x\n");
      assert.ok(!log.some((e) => e.op === "prepare" || e.op === "start" || e.op === "kill"));
      assert.equal(details.at(-1).exit, 0);
    });

    it("claimed (prepared, never started): result unconfirmed, never started", async () => {
      const d = directWorld(sb);
      const client = sb.client();
      const marker = join(sb.work, `claimed-${randomBytes(3).toString("hex")}`);
      const command = `touch ${q(marker)}`;
      const runId = d.runIdOf(13);
      await client.prepare({ id: runId, cwd: sb.work, command });
      d.preclaim({ taskId: 13, command });
      const log = [];
      const { result, error } = await callDirect(d, { command, taskId: 13, runner: recordingRunner(client, log) });
      assert.ifError(error);
      assert.ok(isUnconfirmed(result), JSON.stringify(result));
      assert.ok(!log.some((e) => ["prepare", "start", "kill"].includes(e.op)), JSON.stringify(log));
      await sleep(600);
      assert.ok(!existsSync(marker), "the command never ran");
      assert.equal((await client.status(runId)).state, "claimed");
      assert.equal(d.store.executions.get(runId).state, "unknown");
    });

    it("lost (process gone, no exit code): result unconfirmed, never restarted", async () => {
      const d = directWorld(sb);
      const client = sb.client();
      const counter = join(sb.work, `lost-${randomBytes(3).toString("hex")}`);
      const command = `echo x >> ${q(counter)}`;
      const runId = d.runIdOf(14);
      await launchAs(client, runId, command);
      await finish(client, runId);
      unlinkSync(join(sb.runDir(runId), "exit"));
      assert.equal((await client.status(runId)).state, "lost");
      d.preclaim({ taskId: 14, command });
      const log = [];
      const { result, error } = await callDirect(d, { command, taskId: 14, runner: recordingRunner(client, log) });
      assert.ifError(error);
      assert.ok(isUnconfirmed(result));
      assert.ok(!log.some((e) => ["prepare", "start", "kill"].includes(e.op)));
      await sleep(300);
      assert.equal(readFileSync(counter, "utf8"), "x\n", "still one execution");
      assert.equal(d.store.executions.get(runId).state, "lost");
    });

    it("missing (claimed in the control store, unknown to the runner): result unconfirmed, never started", async () => {
      const d = directWorld(sb);
      const client = sb.client();
      const marker = join(sb.work, `missing-${randomBytes(3).toString("hex")}`);
      const command = `touch ${q(marker)}`;
      d.preclaim({ taskId: 15, command });
      const log = [];
      const { result, error } = await callDirect(d, { command, taskId: 15, runner: recordingRunner(client, log) });
      assert.ifError(error);
      assert.ok(isUnconfirmed(result));
      assert.ok(!log.some((e) => ["prepare", "start", "kill"].includes(e.op)));
      await sleep(300);
      assert.ok(!existsSync(marker));
      assert.equal(existsSync(sb.runDir(d.runIdOf(15))), false, "nothing created on the runner");
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("Exec: pinned intent and failure injection (fake runner)", { skip }, () => {
    /** @type {Sandbox} */
    let sb;
    before(() => {
      sb = new Sandbox();
    });
    after(() => sb?.cleanup());

    it("memo pins {runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash} before the remote is touched", async () => {
      const d = directWorld(sb);
      const runner = fakeRunner({
        wait: async () => ({ state: "exited", exit: 0, offset: 3, size: 3, bytes: Buffer.from("hi\n"), text: "hi\n", done: true }),
      });
      const memos = new Map();
      const { result, error, out } = await callDirect(d, { command: "echo hi", taskId: 21, runner, memos });
      assert.ifError(error);
      assert.ok(!result.isError);
      assert.equal(out.join(""), "hi\n");
      assert.deepEqual(memos.get("exec"), {
        runId: d.runIdOf(21),
        workspaceId: d.workspace.id,
        runtimeId: "rt-1",
        bindingVersion: 1,
        cwd: sb.work,
        commandHash: commandHash("echo hi", sb.work),
      });
      assert.deepEqual(runner.ops().slice(0, 2), ["prepare", "start"]);
      assert.equal(runner.calls[0][1].id, d.runIdOf(21));
      assert.ok(!("env" in runner.calls[0][1]));
    });

    it("binding changed since the intent was pinned (rebuild): result unconfirmed, no runner call at all", async () => {
      const d = directWorld(sb);
      const memos = new Map();
      memos.set("exec", {
        runId: d.runIdOf(22),
        workspaceId: d.workspace.id,
        runtimeId: "rt-1",
        bindingVersion: 1,
        cwd: sb.work,
        commandHash: commandHash("echo hi", sb.work),
      });
      d.store.bindings.bind(d.workspace.id, { provider: "fake", runtimeId: "rt-2" });
      const runner = fakeRunner();
      const { result, error } = await callDirect(d, { command: "echo hi", taskId: 22, runner, memos });
      assert.ifError(error);
      assert.ok(isUnconfirmed(result));
      assert.match(result.diagnostics[0].message, /v1.*v2/);
      assert.deepEqual(runner.ops(), [], "no prepare / start / kill / status / wait on any runtime");
      assert.equal(d.store.executions.get(d.runIdOf(22)), undefined, "nothing claimed either");
    });

    it("same runtime id but a newer binding version also counts as changed", async () => {
      const d = directWorld(sb);
      const memos = new Map();
      memos.set("exec", { runId: d.runIdOf(23), workspaceId: d.workspace.id, runtimeId: "rt-1", bindingVersion: 1, cwd: sb.work, commandHash: commandHash("echo hi", sb.work) });
      d.store.bindings.bind(d.workspace.id, { provider: "fake", runtimeId: "rt-1" }); // v2, same runtime id
      const runner = fakeRunner();
      const { result } = await callDirect(d, { command: "echo hi", taskId: 23, runner, memos });
      assert.ok(isUnconfirmed(result));
      assert.deepEqual(runner.ops(), []);
    });

    it("command differs from the pinned hash on re-entry: result unconfirmed, no runner call", async () => {
      const d = directWorld(sb);
      const memos = new Map();
      memos.set("exec", { runId: d.runIdOf(24), workspaceId: d.workspace.id, runtimeId: "rt-1", bindingVersion: 1, cwd: sb.work, commandHash: commandHash("echo ORIGINAL", sb.work) });
      const runner = fakeRunner();
      const { result } = await callDirect(d, { command: "echo CHANGED", taskId: 24, runner, memos });
      assert.ok(isUnconfirmed(result));
      assert.deepEqual(runner.ops(), []);
    });

    it("later decisions use the memo's cwd, not a newly computed one", async () => {
      const d = directWorld(sb);
      const memos = new Map();
      memos.set("exec", { runId: d.runIdOf(25), workspaceId: d.workspace.id, runtimeId: "rt-1", bindingVersion: 1, cwd: "/pinned/cwd", commandHash: commandHash("echo hi", "/pinned/cwd") });
      const runner = fakeRunner({ wait: async () => ({ state: "exited", exit: 0, offset: 0, size: 0, bytes: Buffer.alloc(0), text: "", done: true }) });
      const { result, error } = await callDirect(d, { command: "echo hi", taskId: 25, runner, memos, cwd: "/somewhere/else" });
      assert.ifError(error);
      assert.ok(!result.isError);
      assert.equal(runner.calls[0][1].cwd, "/pinned/cwd");
    });

    it("prepare dies with a connection error: result unconfirmed, prepare tried once, start never", async () => {
      const d = directWorld(sb);
      const runner = fakeRunner({ prepare: async () => { throw new Error("Sprite exec connection ended; command may have run"); } });
      const { result, error } = await callDirect(d, { command: "echo hi", taskId: 31, runner });
      assert.ifError(error);
      assert.ok(isUnconfirmed(result));
      assert.deepEqual(runner.ops(), ["prepare"]);
      assert.equal(d.store.executions.get(d.runIdOf(31)).state, "unknown");
    });

    it("start dies with a connection error / timeout: result unconfirmed, start tried once, no kill, no second prepare", async () => {
      for (const failure of [new Error("connection reset"), new RunnerError("RUNNER_TIMEOUT", "runner start timed out", { outcomeUnknown: true })]) {
        const d = directWorld(sb);
        const runner = fakeRunner({ start: async () => { throw failure; } });
        const { result, error } = await callDirect(d, { command: "echo hi", taskId: 32, runner });
        assert.ifError(error);
        assert.ok(isUnconfirmed(result));
        assert.deepEqual(runner.ops(), ["prepare", "start"]);
      }
    });

    it("a definite runner refusal (bad upload) is a plain error: nothing ran, nothing to confirm", async () => {
      const d = directWorld(sb);
      const runner = fakeRunner({ prepare: async () => { throw new RunnerError("sha-mismatch", "runner prepare failed: sha-mismatch"); } });
      const { error, result } = await callDirect(d, { command: "echo hi", taskId: 33, runner });
      assert.equal(result, undefined);
      assert.match(error.message, /bash 未执行/);
      assert.deepEqual(runner.ops(), ["prepare"]);
    });

    it("an already-claimed run is only queried (status), never prepared or started again", async () => {
      const d = directWorld(sb);
      d.preclaim({ taskId: 34, command: "echo hi" });
      const runner = fakeRunner({
        status: async () => ({ state: "exited", exit: 0 }),
        wait: async () => ({ state: "exited", exit: 0, offset: 3, size: 3, bytes: Buffer.from("hi\n"), text: "hi\n", done: true }),
      });
      const { result, out } = await callDirect(d, { command: "echo hi", taskId: 34, runner });
      assert.ok(!result.isError);
      assert.equal(out.join(""), "hi\n");
      assert.deepEqual(runner.ops(), ["status", "wait"]);
    });

    it("wait unreachable for the whole retry budget: result unconfirmed, the command is NOT killed or restarted", async () => {
      const d = directWorld(sb);
      let n = 0;
      const runner = fakeRunner({ wait: async () => { n++; throw new Error("Sprite unreachable"); } });
      const { result, error } = await callDirect(d, { command: "sleep 100", taskId: 35, runner, execOptions: { retryBudgetMs: 120 } });
      assert.ifError(error);
      assert.ok(isUnconfirmed(result));
      assert.match(result.diagnostics[0].message, /仍可能在运行/);
      assert.ok(n >= 2, "retried with backoff before giving up");
      assert.deepEqual(runner.ops().filter((o) => o !== "wait"), ["prepare", "start"]);
    });

    it("a transient wait failure is retried and the run completes", async () => {
      const d = directWorld(sb);
      let n = 0;
      const runner = fakeRunner({
        wait: async ({ from }) => {
          n++;
          if (n <= 2) throw new Error("flaky");
          return { state: "exited", exit: 0, offset: from + 3, size: from + 3, bytes: Buffer.from("ok\n"), text: "ok\n", done: true };
        },
      });
      const { result, out } = await callDirect(d, { command: "echo ok", taskId: 36, runner });
      assert.ok(!result.isError);
      assert.equal(out.join(""), "ok\n");
    });

    it("lost / claimed / missing reported by wait while following: result unconfirmed, no restart", async () => {
      for (const state of ["lost", "claimed", "missing"]) {
        const d = directWorld(sb);
        const runner = fakeRunner({ wait: async () => ({ state, offset: 0, size: 0, bytes: Buffer.alloc(0), text: "", done: false }) });
        const { result, error } = await callDirect(d, { command: "echo hi", taskId: 37, runner });
        assert.ifError(error);
        assert.ok(isUnconfirmed(result), state);
        assert.deepEqual(runner.ops().filter((o) => o === "start" || o === "kill" || o === "prepare"), ["prepare", "start"], `${state}: only the initial prepare/start`);
      }
    });

    it("timeout with an unconfirmed kill says 'stop unconfirmed', never 'stopped'; with a confirmed kill says stopped", async () => {
      for (const [killed, statusState] of [["unconfirmed", "running"], ["confirmed", "exited"]]) {
        const d = directWorld(sb);
        const runner = fakeRunner({ kill: async () => ({ killed }), status: async () => ({ state: statusState }) });
        const { error } = await callDirect(d, { command: "sleep 100", timeout: 0.15, taskId: 38, runner });
        assert.match(error.message, /timed out after 0\.15 seconds/);
        if (killed === "unconfirmed") {
          assert.match(error.message, /停止待确认/);
          assert.doesNotMatch(error.message, /已停止/);
          assert.equal(d.store.executions.get(d.runIdOf(38)).state, "unknown");
        } else {
          assert.match(error.message, /已停止/);
          assert.doesNotMatch(error.message, /停止待确认/);
        }
        assert.equal(runner.ops().filter((o) => o === "kill").length, 1);
      }
    });

    it("kill whose call fails but whose status shows the run exited counts as stopped", async () => {
      const d = directWorld(sb);
      const runner = fakeRunner({ kill: async () => { throw new Error("network"); }, status: async () => ({ state: "exited", exit: 143 }) });
      const { error } = await callDirect(d, { command: "sleep 100", timeout: 0.1, taskId: 39, runner });
      assert.match(error.message, /已停止/);
    });

    it("user abort with an unconfirmed kill is reported as 'stop unconfirmed'; a Harness shutdown (no abort mark) kills nothing", async () => {
      {
        const d = directWorld(sb);
        const runner = fakeRunner({ kill: async () => ({ killed: "unconfirmed" }), status: async () => ({ state: "running" }) });
        const { error, diagnostics } = await callDirect(d, { command: "sleep 100", taskId: 41, runner, abortRequested: true, abortAfterMs: 80 });
        assert.ok(error, "the tool still ends as aborted");
        assert.equal(runner.ops().filter((o) => o === "kill").length, 1);
        assert.ok(diagnostics.some((x) => x.code === "stop_unconfirmed" && /停止待确认/.test(x.message)));
        assert.ok(!diagnostics.some((x) => /已停止/.test(x.message)));
      }
      {
        const d = directWorld(sb);
        const runner = fakeRunner();
        const { error } = await callDirect(d, { command: "sleep 100", taskId: 42, runner, abortRequested: false, abortAfterMs: 80 });
        assert.ok(error);
        assert.ok(!runner.ops().includes("kill"), "closing the Harness must leave the command running");
      }
    });

    it("rejects an invalid timeout before touching anything", async () => {
      const d = directWorld(sb);
      for (const timeout of [0, -1, Number.NaN]) {
        const runner = fakeRunner();
        const { error } = await callDirect(d, { command: "echo hi", timeout, taskId: 43, runner });
        assert.match(error.message, /Invalid timeout/);
        assert.deepEqual(runner.ops(), []);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("Exec: crash recovery (control process SIGKILLed while the command runs)", { skip }, () => {
    it("safe replay with the runner, 10 times: command ran once, log replayed from offset 0 in full, exit code correct", { timeout: 600_000 }, async () => {
      const runs = Array.from({ length: 10 }, (_, i) => i);
      const summaries = [];
      for (let i = 0; i < runs.length; i += 5) {
        summaries.push(...(await Promise.all(runs.slice(i, i + 5).map(() => crashAndRecover({})))));
      }
      summaries.forEach((s, i) => {
        const tag = `rep ${i + 1}`;
        assert.equal(s.counterLines, 1, `${tag}: the command must not run twice`);
        assert.equal(s.result.results.length, 1, tag);
        const r = s.result.results[0];
        assert.equal(r.isError, false, `${tag}: ${r.text}`);
        assert.equal(r.output, "begin\nrun\nend\n", `${tag}: complete log from offset 0`);
        assert.equal(r.details.state, "exited", tag);
        assert.equal(r.details.exit, 0, tag);
        assert.equal(r.details.offset, Buffer.byteLength("begin\nrun\nend\n"), tag);
        assert.equal(s.result.execCalls, 0, `${tag}: api.env.exec never used`);
        assert.ok(s.log1.some((e) => e.op === "prepare") && s.log1.some((e) => e.op === "start"), `${tag}: the first run started it`);
        assert.ok(s.log2.length > 0, tag);
        assert.deepEqual(s.log2.filter((e) => ["prepare", "start", "kill"].includes(e.op)), [], `${tag}: the replay only reads`);
        assert.equal(s.log2.find((e) => e.op === "wait").from, 0, `${tag}: waits start at offset 0`);
        assert.equal(s.execution?.state, "exited", tag);
        assert.deepEqual(s.execution?.exit, { code: 0 }, tag);
      });
    });

    it("rebuild between crash and replay (binding version +1): result unconfirmed, the new binding's runner is never touched", { timeout: 180_000 }, async () => {
      const summaries = await Promise.all([0, 1, 2].map(() => crashAndRecover({ rebuild: true })));
      summaries.forEach((s, i) => {
        const tag = `rebuild ${i + 1}`;
        const r = s.result.results[0];
        assert.equal(r.isError, true, tag);
        assert.match(r.harness, /结果待确认/, tag);
        assert.match(r.harness, /v1.*v2/, tag);
        assert.equal(s.counterLines, 1, `${tag}: no second execution`);
        assert.deepEqual(s.log2, [], `${tag}: zero prepare/start/kill/status/wait on either runtime`);
        assert.equal(s.result.execCalls, 0, tag);
      });
    });
  });
}
