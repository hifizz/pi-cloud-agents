// Offline tests for src/workspace-rebuild.mjs (M1-10). No network, no real Sprite, no real model.
//  - "Sprites" are directories: the fake provider's bash / the local runner rewrite the Sprite home path (/home/sprite) to a
//    per-Sprite temp directory and run the command with the local sh and the local git against a local bare "origin".
//  - checkpoints: the real createCheckpointService over the real control store.
//  - The "rebuild does not replay old calls" proof (FT09, M1 version) uses a real Pi Durable harness on a sqlite FILE, a real
//    control store FILE, a child process that is SIGKILLed while a command runs, and a persistent fake runner that records
//    every call. See the note above `proofExec` for what stands in for src/ext/exec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, ToolResultEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openControlStore } from "../src/control/store.mjs";
import { createCheckpointService } from "../src/checkpoint.mjs";
import { ctx, openHarness } from "../src/harness.mjs";
import { commandHash, runIdFor } from "../src/runner/client.mjs";
import { register, RebuildError, rebuildWorkspace } from "../src/workspace-rebuild.mjs";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@example.invalid";

const SELF = fileURLToPath(import.meta.url);
const FAKE_HOME = "/home/sprite";
const FAUX = { provider: "faux", modelId: "faux-1" };
const OLD = "pca-old0000001";
const BRANCH = "tarsbot/fix-abc123";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = `ghp_${"a1B2c3".repeat(6)}`;

// ---- tiny local helpers -------------------------------------------------------------------------------------------------
const localSh = (command, { timeoutMs = 120_000, cwd } = {}) =>
  new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, timedOut: Boolean(error?.killed) });
    });
  });

async function sh(cwd, cmd) {
  const r = await localSh(cmd, { cwd });
  assert.equal(r.exitCode, 0, `${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}

const CHILD = process.argv[2] === "child:proof";

// ======================================================================================================================
// persistent fake runner (file backed, shared by the SIGKILLed child and the parent). Every call is appended to calls.jsonl.
// ======================================================================================================================
function fileRunner({ root, runtime, via, autoExit = false }) {
  const dir = join(root, "runtimes", runtime);
  mkdirSync(dir, { recursive: true });
  const rec = (op, id) => appendFileSync(join(root, "calls.jsonl"), `${JSON.stringify({ via, runtime, op, id })}\n`);
  const file = (id) => join(dir, `${id}.json`);
  const read = (id) => (existsSync(file(id)) ? JSON.parse(readFileSync(file(id), "utf8")) : undefined);
  return {
    async install() {
      rec("install", "-");
    },
    async prepare({ id, cwd, command }) {
      rec("prepare", id);
      if (!read(id)) writeFileSync(file(id), JSON.stringify({ state: "claimed", cwd, command }));
      return { state: read(id).state };
    },
    async start(id) {
      rec("start", id);
      const r = read(id);
      if (!r) throw new Error("start: unknown run");
      if (r.state !== "claimed") return { state: r.state };
      r.state = autoExit ? "exited" : "running";
      if (autoExit) r.exit = 0;
      writeFileSync(file(id), JSON.stringify(r));
      return { state: r.state };
    },
    async status(id) {
      rec("status", id);
      const r = read(id);
      return r ? { state: r.state, exit: r.exit } : { state: "missing" };
    },
    async wait({ id, from = 0 }) {
      rec("wait", id);
      await sleep(20);
      const r = read(id);
      if (!r) return { state: "missing", offset: from, size: from, text: "", done: false };
      return { state: r.state, exit: r.exit, offset: from, size: from, text: "", done: r.state === "exited" };
    },
    async kill(id) {
      rec("kill", id);
      return { killed: "not-found" };
    },
  };
}

const readCalls = (root) =>
  existsSync(join(root, "calls.jsonl")) ? readFileSync(join(root, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// ======================================================================================================================
// Stand-in for src/ext/exec.mjs (M1-06), written by another worker and not present when this file was written.
// It has the §4.5 semantics: pin {runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash} with api.memo as the first
// step, compare the pinned binding with store.bindings.current BEFORE touching the runner, and end with "结果待确认"
// (no prepare, no start, no status, no kill) when they differ. Everything else mirrors Exec (claim -> prepare -> start, or
// status when the claim already exists; wait loop; non-running states are "unconfirmed").
// ======================================================================================================================
const PENDING = "结果待确认";
const text = (t) => ({ output: [{ type: "text", text: t }] });

function proofExec({ store, runnerFor, logFile }) {
  return defineExtension({
    name: "test.proof-exec",
    tools: [
      defineTool({
        name: "bash",
        description: "stand-in for tarsbot.exec",
        parameters: Type.Object({ command: Type.String() }),
        replay: "safe",
        async execute(args, api, context) {
          appendFileSync(logFile, `${JSON.stringify({ ev: "execute", pid: process.pid })}\n`);
          const ws = store.links.workspaceOf(String(api.conversationId));
          if (!ws) throw new Error("conversation has no workspace");
          const cur = store.bindings.current(ws.id);
          const ns = store.meta.ensure("namespace", () => randomBytes(8).toString("hex"));
          const gen = store.meta.ensure("generation", () => 1);
          const runId = runIdFor({ namespace: ns, generation: gen, taskId: String(api.taskId) });
          const hash = commandHash(args.command, ws.cwd);
          const pinned = await api.memo(
            "exec",
            { runId, workspaceId: ws.id, runtimeId: cur.runtimeId, bindingVersion: cur.version, cwd: ws.cwd, commandHash: hash },
            context,
          );
          const now = store.bindings.current(pinned.workspaceId);
          if (!now || now.runtimeId !== pinned.runtimeId || now.version !== pinned.bindingVersion || hash !== pinned.commandHash) {
            return text(`${PENDING}：工作区运行环境已重建（绑定版本 ${pinned.bindingVersion} -> ${now?.version ?? "无"}），旧命令不会在新环境上重新执行`);
          }
          const runner = runnerFor(pinned.runtimeId);
          const { created } = store.executions.claim({
            runId,
            workspaceId: pinned.workspaceId,
            runtimeId: pinned.runtimeId,
            bindingVersion: pinned.bindingVersion,
            cwd: pinned.cwd,
            commandHash: pinned.commandHash,
          });
          if (created) {
            await runner.prepare({ id: runId, cwd: pinned.cwd, command: args.command });
            await runner.start(runId);
          } else {
            await runner.status(runId);
          }
          // bounded so that a regression (the binding check removed) fails the assertions below instead of hanging the suite
          for (let from = 0, spins = 0; ; spins++) {
            if (spins > 50) return text(`${PENDING}：test stand-in gave up waiting`);
            const r = await runner.wait({ id: runId, from, maxSeconds: 1 });
            if (r.text) api.output(r.text);
            from = r.offset;
            if (r.state === "exited") return text(`exit ${r.exit}`);
            if (r.state !== "running") return text(`${PENDING}：runner 状态 ${r.state}`);
          }
        },
      }),
    ],
  });
}

function fauxModels(responses) {
  const f = fauxProvider({ tokensPerSecond: 100000 });
  f.setResponses(responses);
  const models = createModels();
  models.setProvider(f.provider);
  return models;
}
const toolCall = (name, args, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const answer = (t) => fauxAssistantMessage([fauxText(t)]);
const textOf = (e) => (e?.model?.[0]?.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("");

// ---- child: starts a command through the stand-in and gets SIGKILLed while it runs ---------------------------------------
if (CHILD) {
  setTimeout(() => process.exit(124), 60_000).unref();
  const dir = process.argv[3];
  const store = openControlStore({ path: join(dir, "control.sqlite") });
  const ext = proofExec({
    store,
    runnerFor: (runtime) => fileRunner({ root: dir, runtime, via: "exec" }),
    logFile: join(dir, "executes.jsonl"),
  });
  const models = fauxModels([toolCall("bash", { command: "make slow-build" }), answer("done")]);
  const { harness } = await openHarness({
    storage: await openNodeSqliteStorage(join(dir, "alice.sqlite")),
    models,
    extensions: [ext],
    settings: { progress: { partialIntervalMs: 1, outputIntervalMs: 1 } },
    resume: false,
  });
  const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: FAUX } }, ctx);
  const wsId = store.workspaces.list()[0].id;
  store.links.link({ conversationId: String(conv.id), workspaceId: wsId, botId: null });
  writeFileSync(join(dir, "conv"), String(conv.id));
  harness.resume();
  await conv.submit({ type: "input", content: "go" }, ctx);
  await new Promise(() => {});
}

if (!CHILD) {
  const made = [];
  const tmp = (prefix) => {
    const d = mkdtempSync(join(tmpdir(), `pca-rb-${prefix}-`));
    made.push(d);
    return d;
  };
  const children = new Set();
  test.after(() => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  // ====================================================================================================================
  // world for the checkpoint / rebuild tests: local "Sprites", a local origin, real store + real checkpoint service
  // ====================================================================================================================
  function fakeProvider(root) {
    const p = {
      kind: "sprites",
      home: FAKE_HOME,
      sprites: new Set(),
      creates: [],
      ensures: 0,
      inits: [],
      released: [],
      ensureError: null,
      spriteDir: (name) => join(root, "sprites", name),
      runtimeName: (rid) => `pca-${sha256(rid).slice(0, 10)}`,
      isManaged: (name) => typeof name === "string" && name.startsWith("pca-"),
      async ensure({ requestId }) {
        p.ensures++;
        if (p.ensureError) throw p.ensureError;
        const name = p.runtimeName(requestId);
        const created = !p.sprites.has(name);
        if (created) {
          p.sprites.add(name);
          p.creates.push(name);
          mkdirSync(p.spriteDir(name), { recursive: true });
        }
        return { runtimeId: name, created };
      },
      async init(name) {
        p.inits.push(name);
      },
      bash(name) {
        const dir = p.spriteDir(name);
        mkdirSync(dir, { recursive: true });
        return (command, opts) => localSh(command.replaceAll(FAKE_HOME, dir), opts);
      },
      async release(name) {
        p.released.push(name);
        throw new Error("release must not be called in M1");
      },
    };
    return p;
  }

  function localRunner(provider, name, calls) {
    const dir = provider.spriteDir(name);
    const rw = (s) => s.replaceAll(FAKE_HOME, dir);
    const runs = new Map();
    const r = {
      installs: 0,
      async install() {
        r.installs++;
      },
      async prepare({ id, cwd, command, env }) {
        assert.equal(env, undefined, "rebuild must not pass env to the runner");
        calls.push(["prepare", name, id]);
        if (!runs.has(id)) runs.set(id, { cwd: rw(cwd), command: rw(command), state: "claimed", log: Buffer.alloc(0), exit: null });
        return { state: runs.get(id).state };
      },
      async start(id) {
        calls.push(["start", name, id]);
        const run = runs.get(id);
        if (!run) throw new Error("start: unknown run");
        if (run.state !== "claimed") return { state: run.state };
        mkdirSync(run.cwd, { recursive: true });
        const child = spawn("sh", ["-c", run.command], { cwd: run.cwd, stdio: ["ignore", "pipe", "pipe"] });
        run.state = "running";
        const add = (b) => {
          run.log = Buffer.concat([run.log, b]);
        };
        child.stdout.on("data", add);
        child.stderr.on("data", add);
        child.on("close", (code) => {
          run.exit = code ?? 1;
          run.state = "exited";
        });
        return { state: "running" };
      },
      async wait({ id, from, maxSeconds }) {
        const run = runs.get(id);
        if (!run) return { state: "missing", offset: from, text: "" };
        const deadline = Date.now() + maxSeconds * 1000;
        while (run.log.length <= from && run.state === "running" && Date.now() < deadline) await sleep(5);
        const chunk = run.log.subarray(from, from + 32768);
        return { state: run.state, exit: run.exit ?? undefined, offset: from + chunk.length, size: run.log.length, text: chunk.toString("utf8"), done: run.state === "exited" };
      },
      async status(id) {
        const run = runs.get(id);
        return run ? { state: run.state, exit: run.exit ?? undefined } : { state: "missing" };
      },
      async kill() {
        return { killed: "not-found" };
      },
    };
    return r;
  }

  const fingerprint = (dir, skip = []) => {
    const out = {};
    const walk = (rel) => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        if (rel === "" && (e.name === ".git" || skip.includes(e.name))) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else {
          const st = statSync(join(dir, r));
          out[r] = `${sha256(readFileSync(join(dir, r)))}:${st.mode & 0o111 ? "x" : "-"}`;
        }
      }
    };
    walk("");
    return out;
  };

  async function dirty(work) {
    writeFileSync(join(work, "local.txt"), "local commit\n");
    await sh(work, "git add local.txt && git commit -q -m local"); // unpushed commit
    writeFileSync(join(work, "a.txt"), "alpha changed\n"); // modified
    writeFileSync(join(work, "new.txt"), "brand new\n"); // added (untracked)
    mkdirSync(join(work, "sub/dir"), { recursive: true });
    writeFileSync(join(work, "sub/dir/bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0, 10, 13, 0])); // binary
    rmSync(join(work, "gone.txt")); // deleted
    chmodSync(join(work, "run.sh"), 0o644); // executable bit removed
    writeFileSync(join(work, "tool.sh"), "#!/bin/sh\n");
    chmodSync(join(work, "tool.sh"), 0o755); // new executable
    writeFileSync(join(work, "ignored.log"), "SECRET-IGNORED\n");
    mkdirSync(join(work, "node_modules/x"), { recursive: true });
    writeFileSync(join(work, "node_modules/x/i.js"), "x");
  }

  /** Workspace `ws` ready on the old Sprite OLD (binding v1), working copy dirty, one verified checkpoint. */
  async function setup({ dirtyWork = true } = {}) {
    const root = tmp("w");
    const origin = join(root, "origin.git");
    await sh(root, "git init -q --bare -b main origin.git");
    const seed = join(root, "seed");
    await sh(root, "git clone -q origin.git seed 2>/dev/null");
    await sh(seed, "git checkout -q -b main 2>/dev/null; true");
    writeFileSync(join(seed, "a.txt"), "alpha\n");
    writeFileSync(join(seed, "gone.txt"), "to delete\n");
    writeFileSync(join(seed, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(seed, "run.sh"), 0o755);
    writeFileSync(join(seed, ".gitignore"), "ignored.log\nnode_modules/\n");
    await sh(seed, "git add -A && git commit -q -m init && git push -q origin HEAD:main");
    const baseCommit = await sh(seed, "git rev-parse HEAD");

    const provider = fakeProvider(root);
    const store = openControlStore({ path: null });
    const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
    const { workspace } = store.workspaces.create({
      requestId: "req-1",
      projectId: project.id,
      name: "w",
      baseBranch: "main",
      branch: BRANCH,
      cwd: `${FAKE_HOME}/workspace/app`,
      model: FAUX,
    });
    store.workspaces.update(workspace.id, { baseCommit, status: "ready" });
    store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: OLD });
    provider.sprites.add(OLD);
    const oldBash = provider.bash(OLD);
    const c = await oldBash(`mkdir -p ${FAKE_HOME}/workspace && git clone -q '${origin}' ${FAKE_HOME}/workspace/app && cd ${FAKE_HOME}/workspace/app && git checkout -q -B ${BRANCH} ${baseCommit}`);
    assert.equal(c.exitCode, 0, c.stderr);
    const oldWork = join(provider.spriteDir(OLD), "workspace/app");
    if (dirtyWork) await dirty(oldWork);

    const cps = createCheckpointService({ store, dir: join(root, "ckpts") });
    const ws = store.workspaces.get(workspace.id);
    const checkpoint = await cps.save({ workspace: ws, bash: oldBash, bindingVersion: 1 });

    const calls = [];
    const runners = new Map();
    const logs = [];
    const world = {
      root,
      origin,
      seed,
      baseCommit,
      provider,
      store,
      cps,
      ws,
      checkpoint,
      oldWork,
      calls,
      logs,
      runner: (name) => {
        if (!runners.has(name)) runners.set(name, localRunner(provider, name, calls));
        return runners.get(name);
      },
      newWork: (name) => join(provider.spriteDir(name), "workspace/app"),
      deps: (extra = {}) => ({
        svc: { get: (id) => store.workspaces.get(id) },
        store,
        github: null,
        providers: { sprites: provider },
        cps,
        runnerFor: (name) => world.runner(name),
        cloneUrl: () => origin,
        log: (e) => logs.push(e),
        waitSeconds: 1,
        retryDelayMs: 1,
        secrets: [],
        ...extra,
      }),
      /** A new commit on origin/main after the checkpoint's base commit. */
      async advanceOrigin() {
        writeFileSync(join(seed, "later.txt"), "newer upstream work\n");
        await sh(seed, "git add -A && git commit -q -m later && git push -q origin HEAD:main");
        return sh(seed, "git rev-parse HEAD");
      },
    };
    return world;
  }

  const bindingStates = (store, id) => store.bindings.history(id).map((b) => `${b.version}:${b.runtimeId}:${b.state}`);

  // ====================================================================================================================
  test("success: new Sprite at the checkpoint's baseCommit, files identical (sha256, exec bit, new/changed/deleted/binary), binding v2, old Sprite untouched", async () => {
    const w = await setup();
    const newest = await w.advanceOrigin(); // origin moved on after the checkpoint
    const before = JSON.stringify(w.store.workspaces.get(w.ws.id));
    const beforeKeys = Object.keys(w.store.workspaces.get(w.ws.id)).sort();
    const oldFp = fingerprint(w.oldWork, ["ignored.log", "node_modules"]);
    const oldStatus = await sh(w.oldWork, "git status --porcelain");

    const binding = await rebuildWorkspace(w.deps(), { workspaceId: w.ws.id, checkpointId: w.checkpoint.id });

    // binding: version + 1, old one replaced, exactly one active
    assert.equal(binding.version, 2);
    assert.equal(binding.state, "active");
    assert.equal(binding.provider, "sprites");
    const newName = binding.runtimeId;
    assert.notEqual(newName, OLD);
    assert.match(newName, /^pca-[0-9a-f]{10}$/);
    assert.deepEqual(bindingStates(w.store, w.ws.id), [`1:${OLD}:replaced`, `2:${newName}:active`]);
    assert.equal(w.store.bindings.current(w.ws.id).runtimeId, newName);
    assert.deepEqual(w.provider.creates, [newName]);
    assert.deepEqual(w.provider.inits, [newName]);
    assert.equal(w.runner(newName).installs, 1);

    // workspace stays ready and gains no field (same keys; nothing but updatedAt may change)
    const after = w.store.workspaces.get(w.ws.id);
    assert.equal(after.status, "ready");
    assert.equal(after.error, null);
    assert.deepEqual(Object.keys(after).sort(), beforeKeys);
    assert.deepEqual({ ...after, updatedAt: 0 }, { ...JSON.parse(before), updatedAt: 0 });

    // files: byte-for-byte and exec-bit identical; ignored files are not part of a checkpoint
    const work = w.newWork(newName);
    const newFp = fingerprint(work);
    assert.deepEqual(newFp, oldFp);
    assert.ok(newFp["new.txt"] && newFp["sub/dir/bin.dat"] && newFp["local.txt"] && newFp["tool.sh"].endsWith(":x") && newFp["run.sh"].endsWith(":-"));
    assert.ok(!("gone.txt" in newFp), "deleted file stays deleted");
    assert.equal(readFileSync(join(work, "a.txt"), "utf8"), "alpha changed\n");
    assert.deepEqual([...readFileSync(join(work, "sub/dir/bin.dat"))], [0, 1, 2, 0, 255, 0, 10, 13, 0]);
    assert.ok(!existsSync(join(work, "ignored.log")) && !existsSync(join(work, "node_modules")));
    assert.equal(await sh(work, "git status --porcelain"), oldStatus);

    // git: branch + HEAD = the checkpoint's head (built on baseCommit), NOT the newest base branch
    assert.equal(await sh(work, "git rev-parse --abbrev-ref HEAD"), BRANCH);
    assert.equal(await sh(work, "git rev-parse HEAD"), w.checkpoint.headCommit);
    assert.equal((await localSh(`git merge-base --is-ancestor ${w.baseCommit} HEAD`, { cwd: work })).exitCode, 0);
    assert.notEqual((await localSh(`git merge-base --is-ancestor ${newest} HEAD`, { cwd: work })).exitCode, 0, "the newest origin commit must not be in the rebuilt branch");
    assert.ok(!existsSync(join(work, "later.txt")));
    assert.equal(await sh(work, "git for-each-ref refs/pca | wc -l | tr -d ' '"), "0");

    // the old runtime is never deleted or modified
    assert.deepEqual(w.provider.released, []);
    assert.deepEqual(fingerprint(w.oldWork, ["ignored.log", "node_modules"]), oldFp);
    assert.ok(existsSync(join(w.oldWork, "ignored.log")));

    // intent: kind workspace.rebuild with the evidence the task asks for
    const intent = w.store.intents.get(`${w.ws.id}:rebuild:2`);
    assert.equal(intent.kind, "workspace.rebuild");
    assert.equal(intent.state, "confirmed");
    assert.equal(intent.workspaceId, w.ws.id);
    assert.equal(intent.target, newName);
    assert.equal(intent.evidence.checkpointId, w.checkpoint.id);
    assert.equal(intent.evidence.fromVersion, 1);
    assert.equal(intent.evidence.toVersion, 2);

    // the clone went through the runner (restart-safe path)
    assert.ok(w.calls.some((c) => c[0] === "start" && c[1] === newName));
    assert.ok(w.calls.every((c) => c[1] === newName), "the old Sprite's runner is never used");

    // no server path / token anywhere a caller or an operator can read
    const everything = JSON.stringify([binding, w.store.intents.list(), w.logs]);
    assert.ok(!everything.includes(tmpdir()) && !everything.includes(w.root));
  });

  test("same requestId twice (sequential and concurrent): exactly one new Sprite, same binding, no version 3", async () => {
    const w = await setup({ dirtyWork: false });
    const deps = w.deps();
    const args = { workspaceId: w.ws.id, checkpointId: w.checkpoint.id, requestId: "rebuild-req-1" };
    const [a, b] = await Promise.all([rebuildWorkspace(deps, args), rebuildWorkspace(deps, args)]);
    assert.equal(a.version, 2);
    assert.deepEqual(b, a);
    const c = await rebuildWorkspace(w.deps(), args); // later, even through a different deps object
    assert.deepEqual(c, a);
    assert.equal(w.provider.creates.length, 1);
    assert.equal(w.provider.ensures, 1);
    assert.equal(w.store.bindings.history(w.ws.id).length, 2);
    assert.equal(w.calls.filter((x) => x[0] === "start").length, 1, "the clone ran once");
    assert.equal(w.store.intents.list({ kind: "workspace.rebuild" }).length, 1);
    assert.equal(w.store.intents.get("rebuild-req-1").state, "confirmed");

    // same requestId, another checkpoint's content or workspace: refused, not silently reused
    w.store.checkpoints.add({ workspaceId: w.ws.id, bindingVersion: 1, path: "x/y.bundle", sha256: "0".repeat(64), size: 1, baseCommit: w.baseCommit, headCommit: w.checkpoint.headCommit, treeHash: w.checkpoint.treeHash });
    const other = w.store.checkpoints.list(w.ws.id).find((x) => x.id !== w.checkpoint.id);
    await assert.rejects(rebuildWorkspace(w.deps(), { ...args, checkpointId: other.id }), (e) => e instanceof RebuildError && /integrity|conflict/.test(e.code));
  });

  test("a failed attempt can be retried with the same requestId: the same Sprite is reused, the clone is not repeated", async () => {
    const w = await setup();
    let applies = 0;
    const flaky = {
      ...w.cps,
      apply: async (args) => {
        if (applies++ === 0) throw new Error("transient restore failure");
        return w.cps.apply(args);
      },
    };
    const deps = w.deps({ cps: flaky });
    const args = { workspaceId: w.ws.id, checkpointId: w.checkpoint.id, requestId: "retry-1" };
    await assert.rejects(rebuildWorkspace(deps, args), (e) => e instanceof RebuildError && e.code === "failed");
    assert.equal(w.store.bindings.current(w.ws.id).version, 1);
    const binding = await rebuildWorkspace(deps, args);
    assert.equal(binding.version, 2);
    assert.equal(w.provider.creates.length, 1, "one Sprite across both attempts");
    assert.equal(w.calls.filter((c) => c[0] === "start").length, 1, "the clone ran once");
    assert.deepEqual(fingerprint(w.newWork(binding.runtimeId)), fingerprint(w.oldWork, ["ignored.log", "node_modules"]));
    assert.equal(w.store.intents.get("retry-1").state, "confirmed");
    assert.equal(applies, 2);
  });

  test("apply fails: the old binding stays active, the half-built Sprite is named in the intent and the error, nothing leaks", async () => {
    const w = await setup();
    const secret = "not-in-the-pattern-secret-value";
    const failing = {
      ...w.cps,
      apply: async () => {
        throw new Error(`restore failed at /Users/zilin/private/dir using ${TOKEN} and ${secret}`);
      },
    };
    const deps = w.deps({ cps: failing, secrets: [secret] });
    const wsBefore = JSON.stringify({ ...w.store.workspaces.get(w.ws.id), updatedAt: 0 });
    let err;
    await assert.rejects(rebuildWorkspace(deps, { workspaceId: w.ws.id, checkpointId: w.checkpoint.id }), (e) => {
      err = e;
      return e instanceof RebuildError && e.code === "failed";
    });
    const half = w.provider.creates[0];
    assert.ok(half && half !== OLD);
    assert.deepEqual(err.halfBuilt, [half]);
    assert.ok(err.message.includes(half), "the error lists the half-built Sprite by name");
    assert.equal(err.step, "apply");

    // old binding untouched and active; workspace unchanged (still ready)
    assert.deepEqual(bindingStates(w.store, w.ws.id), [`1:${OLD}:active`]);
    assert.equal(w.store.bindings.current(w.ws.id).runtimeId, OLD);
    assert.equal(JSON.stringify({ ...w.store.workspaces.get(w.ws.id), updatedAt: 0 }), wsBefore);
    assert.deepEqual(w.provider.released, []);
    assert.ok(existsSync(join(w.oldWork, "new.txt")));

    // the intent log records the failure and the half-built name
    const intent = w.store.intents.get(`${w.ws.id}:rebuild:2`);
    assert.equal(intent.kind, "workspace.rebuild");
    assert.equal(intent.state, "failed");
    assert.deepEqual(intent.evidence.halfBuilt, [half]);
    assert.equal(intent.evidence.checkpointId, w.checkpoint.id);
    assert.equal(intent.evidence.failedStep, "apply");

    // no token / secret / absolute path in the error, the intents, the logs
    const seen = JSON.stringify([err.message, w.store.intents.list(), w.logs]);
    for (const bad of [TOKEN, secret, "/Users/zilin", tmpdir(), w.root]) assert.ok(!seen.includes(bad), `leaked ${bad}`);
    assert.ok(w.logs.some((l) => l.ev === "rebuild.error"));
  });

  test("provider.ensure failures: a definite error leaves no half-built name, an uncertain one lists the deterministic name", async () => {
    const w = await setup({ dirtyWork: false });
    w.provider.ensureError = Object.assign(new Error("forbidden"), { statusCode: 403 });
    await assert.rejects(rebuildWorkspace(w.deps(), { workspaceId: w.ws.id, checkpointId: w.checkpoint.id, requestId: "e1" }), (e) => e.code === "failed" && e.halfBuilt.length === 0);
    assert.equal(w.store.intents.get("e1").state, "failed");

    w.provider.ensureError = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    let err;
    await assert.rejects(rebuildWorkspace(w.deps(), { workspaceId: w.ws.id, checkpointId: w.checkpoint.id, requestId: "e2" }), (e) => {
      err = e;
      return e.code === "uncertain";
    });
    const name = w.provider.runtimeName("e2");
    assert.deepEqual(err.halfBuilt, [name]);
    assert.ok(err.message.includes(name) && err.message.includes("结果待确认"));
    assert.equal(w.store.intents.get("e2").state, "unknown");
    assert.deepEqual(w.store.intents.get("e2").evidence.halfBuilt, [name]);
    assert.deepEqual(bindingStates(w.store, w.ws.id), [`1:${OLD}:active`]);
  });

  test("another workspace's checkpoint (or an unknown / tampered one) is refused before anything is created", async () => {
    const w = await setup({ dirtyWork: false });
    // a second workspace with its own checkpoint record
    const project = w.store.projects.getByRepo("acme/app");
    const { workspace: ws2 } = w.store.workspaces.create({ requestId: "req-2", projectId: project.id, name: "w2", baseBranch: "main", branch: "tarsbot/other-def456", cwd: `${FAKE_HOME}/workspace/other`, model: FAUX });
    w.store.workspaces.update(ws2.id, { baseCommit: w.baseCommit, status: "ready" });
    w.store.bindings.bind(ws2.id, { provider: "sprites", runtimeId: "pca-other00001" });
    const foreign = w.store.checkpoints.add({ workspaceId: ws2.id, bindingVersion: 1, path: `${ws2.id}/x.bundle`, sha256: "0".repeat(64), size: 1, baseCommit: w.baseCommit, headCommit: w.checkpoint.headCommit, treeHash: w.checkpoint.treeHash });

    const deps = w.deps();
    await assert.rejects(rebuildWorkspace(deps, { workspaceId: w.ws.id, checkpointId: foreign.id }), (e) => e instanceof RebuildError && e.code === "not_found");
    await assert.rejects(rebuildWorkspace(deps, { workspaceId: w.ws.id, checkpointId: "cp_doesnotexist" }), (e) => e.code === "not_found");
    await assert.rejects(rebuildWorkspace(deps, { workspaceId: "ws_nope", checkpointId: w.checkpoint.id }), (e) => e.code === "not_found");
    await assert.rejects(rebuildWorkspace(deps, { workspaceId: w.ws.id }), (e) => e.code === "invalid");

    // tampered bundle: cps.verify fails -> refused
    const bundle = join(w.root, "ckpts", w.checkpoint.path);
    appendFileSync(bundle, "x");
    await assert.rejects(rebuildWorkspace(deps, { workspaceId: w.ws.id, checkpointId: w.checkpoint.id }), (e) => e.code === "integrity");

    // not ready / no active binding
    w.store.workspaces.update(w.ws.id, { status: "failed" });
    await assert.rejects(rebuildWorkspace(deps, { workspaceId: w.ws.id, checkpointId: w.checkpoint.id }), (e) => e.code === "conflict");
    w.store.workspaces.update(w.ws.id, { status: "ready" });

    assert.equal(w.provider.ensures, 0, "no Sprite was created for any refused request");
    assert.deepEqual(w.provider.creates, []);
    assert.equal(w.store.intents.list({ kind: "workspace.rebuild" }).length, 0);
    assert.deepEqual(bindingStates(w.store, w.ws.id), [`1:${OLD}:active`]);
  });

  test("a workspace without an active binding cannot be rebuilt", async () => {
    const w = await setup({ dirtyWork: false });
    const project = w.store.projects.getByRepo("acme/app");
    const { workspace: ws3 } = w.store.workspaces.create({ requestId: "req-3", projectId: project.id, name: "w3", baseBranch: "main", branch: "tarsbot/third-aaa111", cwd: `${FAKE_HOME}/workspace/third`, model: FAUX });
    w.store.workspaces.update(ws3.id, { baseCommit: w.baseCommit, status: "ready" });
    const cp = w.store.checkpoints.add({ workspaceId: ws3.id, bindingVersion: null, path: "x", sha256: "0".repeat(64), size: 1, baseCommit: w.baseCommit, headCommit: w.checkpoint.headCommit, treeHash: w.checkpoint.treeHash });
    const verifying = { ...w.cps, verify: async () => true };
    await assert.rejects(rebuildWorkspace(w.deps({ cps: verifying }), { workspaceId: ws3.id, checkpointId: cp.id }), (e) => e.code === "conflict" && /active/.test(e.message));
    assert.equal(w.provider.ensures, 0);
  });

  // ====================================================================================================================
  test("routes: not registered without ctx.rebuild; POST validates, maps errors, returns a binding view without secrets", async () => {
    const routes = {};
    const mk = (c) => ({ ctx: c, get: (p, h) => (routes[`GET ${p}`] = h), post: (p, h) => (routes[`POST ${p}`] = h) });
    register(mk({}));
    assert.deepEqual(Object.keys(routes), []);

    const seen = [];
    const outcomes = {
      ok: () => ({ id: 7, workspaceId: "ws_1", provider: "sprites", runtimeId: "pca-1234567890", version: 2, state: "active", createdAt: "t", replacedAt: null }),
      notFound: () => {
        throw new RebuildError("not_found", "检查点不存在：cp_x");
      },
      conflict: () => {
        throw new RebuildError("conflict", "工作区不是 ready 状态");
      },
      uncertain: () => {
        throw new RebuildError("uncertain", "重建失败（init）：结果待确认");
      },
      boom: () => {
        throw new Error(`boom ${TOKEN} at /Users/zilin/private/x`);
      },
    };
    let which = "ok";
    register(mk({ rebuild: async (a) => (seen.push(a), outcomes[which]()) }));
    const post = routes["POST /api/workspaces/:id/rebuild"];
    assert.ok(post);

    const out = await post({}, {}, { params: { id: "ws_1" }, body: { checkpointId: " cp_1 ", requestId: " r-1 " } });
    assert.deepEqual(seen[0], { workspaceId: "ws_1", checkpointId: "cp_1", requestId: "r-1" });
    assert.equal(out.version, 2);
    assert.equal(out.runtimeId, "pca-1234567890");
    assert.deepEqual(Object.keys(out).sort(), ["createdAt", "id", "provider", "runtimeId", "state", "version", "workspaceId"]);
    await post({}, {}, { params: { id: "ws_1" }, body: { checkpointId: "cp_1" } });
    assert.ok(!("requestId" in seen[1]));

    for (const body of [undefined, null, [], "x", {}, { checkpointId: "" }, { checkpointId: 5 }, { checkpointId: "cp", requestId: 3 }]) {
      await assert.rejects(post({}, {}, { params: { id: "ws_1" }, body }), (e) => e.status === 400, JSON.stringify(body));
    }
    for (const [k, status] of [["notFound", 404], ["conflict", 409], ["uncertain", 502]]) {
      which = k;
      await assert.rejects(post({}, {}, { params: { id: "ws_1" }, body: { checkpointId: "cp_1" } }), (e) => e.status === status, k);
    }
    which = "boom";
    await assert.rejects(post({}, {}, { params: { id: "ws_1" }, body: { checkpointId: "cp_1" } }), (e) => {
      assert.equal(e.status, 500);
      assert.ok(!e.message.includes(TOKEN) && !e.message.includes("/Users/zilin"));
      return true;
    });
  });

  test("routes + real rebuild: success returns the new binding; a foreign checkpoint is a 404 and creates nothing", async () => {
    const w = await setup({ dirtyWork: false });
    const routes = {};
    register({ ctx: { rebuild: (a) => rebuildWorkspace(w.deps(), a) }, get() {}, post: (p, h) => (routes[p] = h) });
    const post = routes["/api/workspaces/:id/rebuild"];
    await assert.rejects(post({}, {}, { params: { id: w.ws.id }, body: { checkpointId: "cp_other" } }), (e) => e.status === 404);
    assert.equal(w.provider.ensures, 0);
    const out = await post({}, {}, { params: { id: w.ws.id }, body: { checkpointId: w.checkpoint.id, requestId: "route-1" } });
    assert.equal(out.version, 2);
    assert.equal(out.state, "active");
    assert.equal(out.runtimeId, w.store.bindings.current(w.ws.id).runtimeId);
    assert.ok(!JSON.stringify(out).includes(tmpdir()));
  });

  // ====================================================================================================================
  // FT09 (M1 version): after a rebuild, the old binding's unfinished command is NOT executed on the new machine.
  // ====================================================================================================================
  test("rebuild does not replay old calls: SIGKILL mid-command, rebuild (binding +1), reopen the same sqlite -> 结果待确认, 0 prepare/start on the new runner", async () => {
    const dir = tmp("proof");
    const NEW_BASE = "a".repeat(40);
    const RUN_OLD = "pca-proofold01";

    // --- control data written by the parent, then closed before the child opens the same file ---
    {
      const store = openControlStore({ path: join(dir, "control.sqlite") });
      const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
      const { workspace } = store.workspaces.create({ requestId: "req-p", projectId: project.id, name: "p", baseBranch: "main", branch: BRANCH, cwd: `${FAKE_HOME}/workspace/app`, model: FAUX });
      store.workspaces.update(workspace.id, { baseCommit: NEW_BASE, status: "ready" });
      store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: RUN_OLD });
      store.close();
    }

    // --- phase 1: the child starts `make slow-build` on the OLD runtime and is SIGKILLed while it runs ---
    const child = spawn(process.execPath, [SELF, "child:proof", dir], {
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, TARSBOT_NO_DOTENV: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let childErr = "";
    child.stderr.on("data", (b) => (childErr += b));
    const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    const until = Date.now() + 30_000;
    while (!readCalls(dir).some((c) => c.via === "exec" && c.op === "start")) {
      if (Date.now() > until || child.exitCode !== null) assert.fail(`child never started the command: ${childErr}`);
      await sleep(15);
    }
    await sleep(500); // let the tool's progress become durable
    child.kill("SIGKILL");
    assert.equal((await exited).signal, "SIGKILL");

    const phase1 = readCalls(dir);
    const execStarts = phase1.filter((c) => c.via === "exec" && c.op === "start");
    assert.equal(execStarts.length, 1);
    assert.equal(execStarts[0].runtime, RUN_OLD);
    const runId = execStarts[0].id;
    assert.equal(phase1.filter((c) => c.op === "prepare" && c.id === runId).length, 1);
    assert.equal(readFileSync(join(dir, "executes.jsonl"), "utf8").trim().split("\n").length, 1);

    // --- rebuild in the parent: the NEW runtime gets a runner that would happily accept a start ---
    const store = openControlStore({ path: join(dir, "control.sqlite") });
    const ws = store.workspaces.list()[0];
    assert.equal(store.bindings.current(ws.id).version, 1);
    assert.equal(store.executions.listOpen().length, 1);
    assert.equal(store.executions.listOpen()[0].runtimeId, RUN_OLD);
    const checkpoint = store.checkpoints.add({ workspaceId: ws.id, bindingVersion: 1, path: `${ws.id}/c.bundle`, sha256: "0".repeat(64), size: 1, baseCommit: NEW_BASE, headCommit: "b".repeat(40), treeHash: "c".repeat(40) });
    const provider = fakeProvider(dir);
    provider.sprites.add(RUN_OLD);
    const applied = [];
    const binding = await rebuildWorkspace(
      {
        svc: { get: (id) => store.workspaces.get(id) },
        store,
        github: null,
        providers: { sprites: provider },
        cps: { verify: async () => true, apply: async (a) => applied.push(a.checkpoint.id) },
        runnerFor: (runtime) => fileRunner({ root: dir, runtime, via: "rebuild", autoExit: true }),
        cloneUrl: () => "unused",
        waitSeconds: 1,
        retryDelayMs: 1,
      },
      { workspaceId: ws.id, checkpointId: checkpoint.id },
    );
    assert.equal(binding.version, 2);
    assert.notEqual(binding.runtimeId, RUN_OLD);
    assert.deepEqual(applied, [checkpoint.id]);
    assert.equal(store.bindings.current(ws.id).runtimeId, binding.runtimeId);
    assert.ok(readCalls(dir).some((c) => c.via === "rebuild" && c.runtime === binding.runtimeId && c.op === "start"), "the new runner was alive and used for the clone");
    const callsBeforeRestart = readCalls(dir).length;

    // --- phase 2: reopen the SAME sqlite; the interrupted tool call re-enters execute() ---
    const exec = proofExec({
      store,
      runnerFor: (runtime) => fileRunner({ root: dir, runtime, via: "exec" }),
      logFile: join(dir, "executes.jsonl"),
    });
    const { harness } = await openHarness({
      storage: await openNodeSqliteStorage(join(dir, "alice.sqlite")),
      models: fauxModels([answer("recovered")]),
      extensions: [exec],
      settings: { progress: { partialIntervalMs: 1, outputIntervalMs: 1 } },
      resume: false,
    });
    try {
      const conv = await harness.conversation(readFileSync(join(dir, "conv"), "utf8"), ctx);
      harness.resume();
      await Promise.race([conv.waitForIdle(ctx), sleep(20_000).then(() => assert.fail("recovered conversation never became idle"))]);
      const entries = (await conv.entries({}, 200, undefined, ctx)).items;
      const results = entries.filter((e) => ToolResultEntry.is(e));
      assert.equal(results.length, 1);
      assert.ok(textOf(results[0]).includes(PENDING), `tool result: ${textOf(results[0])}`);

      // the tool really re-entered after the restart (so the check above is about the replay, not about a missing replay)
      const executes = readFileSync(join(dir, "executes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(executes.length, 2);
      assert.notEqual(executes[0].pid, executes[1].pid);
    } finally {
      await Promise.race([harness.close(ctx).catch(() => {}), sleep(5000)]);
    }

    // --- the proof: nothing touched any runner on behalf of the replayed call ---
    const all = readCalls(dir);
    assert.equal(all.length, callsBeforeRestart, "the replayed call made no runner call at all (no prepare, start, status, wait or kill)");
    assert.equal(all.filter((c) => c.runtime === binding.runtimeId && c.via === "exec").length, 0, "0 exec calls on the new runner");
    assert.equal(all.filter((c) => c.runtime === binding.runtimeId && c.id === runId).length, 0, "the old run id never reached the new runner");
    assert.equal(all.filter((c) => c.op === "prepare" && c.id === runId).length, 1, "prepare for the run id happened once, on the old runtime");
    assert.equal(all.filter((c) => c.op === "start" && c.id === runId).length, 1, "start for the run id happened once, on the old runtime");
    assert.equal(store.executions.get(runId).runtimeId, RUN_OLD);
    assert.equal(store.executions.get(runId).bindingVersion, 1);
    assert.deepEqual(provider.released, []);
    store.close();
  });
}
