// Offline tests for src/sandbox/e2b.mjs (fake `Sandbox` class that mimics the e2b SDK surface we use).
import { test } from "node:test";
import assert from "node:assert/strict";

const { createE2bBash, findE2bSandbox, getE2bInfo, e2bBash } = await import("../src/sandbox/e2b.mjs");

const KEY = "e2b_SECRETKEY1234567890";
const GH = "ghp_SECRETTOKEN1234567890";

class FakeExitError extends Error {
  constructor(r) {
    super("exit");
    this.name = "CommandExitError";
    this.exitCode = r.exitCode;
    this.error = r.error;
  }
}
const named = (name, message) => Object.assign(new Error(message), { name });

/**
 * Fake `Sandbox` class. `world` holds listing state and scripted behaviours:
 *   world.items: SandboxInfo[]; world.runs: scripted handler per commands.run call (index clamped)
 */
function makeWorld({ items = [{ sandboxId: "sbx1", state: "running", startedAt: new Date(), metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" } }], runs } = {}) {
  const world = { items, listCalls: [], connectCalls: [], runCalls: [], kills: [], runs: runs ?? [() => ({ stdout: "", stderr: "", exitCode: 0 })], connectError: [], runError: [], writes: [] };
  class FakeSandbox {
    constructor(id) {
      this.sandboxId = id;
      this.files = {
        write: async (path, data) => {
          world.writes.push({ id, path, data });
          if (world.writeError) throw world.writeError;
          return { path };
        },
      };
      this.commands = {
        run: async (cmd, opts) => {
          const i = world.runCalls.length;
          world.runCalls.push({ id, cmd, opts });
          const pre = world.runError[i];
          if (pre) throw pre;
          const script = world.runs[Math.min(i, world.runs.length - 1)];
          return script({ cmd, opts, index: i });
        },
      };
    }
    static list(opts) {
      world.listCalls.push(opts);
      let done = false;
      return {
        get hasNext() {
          return !done;
        },
        async nextItems() {
          done = true;
          await new Promise((r) => setImmediate(r));
          const md = opts.query?.metadata ?? {};
          return world.items.filter((x) => Object.entries(md).every(([k, v]) => x.metadata[k] === v));
        },
      };
    }
    static async connect(id, opts) {
      const i = world.connectCalls.length;
      world.connectCalls.push({ id, opts });
      const err = world.connectError[i];
      if (err) throw err;
      const item = world.items.find((x) => x.sandboxId === id);
      if (!item) throw named("SandboxNotFoundError", "sandbox not found");
      item.state = "running";
      return new FakeSandbox(id);
    }
  }
  return { Sandbox: FakeSandbox, world };
}

/** A handle like the SDK's CommandHandle (background mode). */
function handle({ stdout = "", stderr = "", exitCode = 0, error, hang = false, waitError } = {}) {
  let release;
  const h = {
    pid: 42,
    stdout,
    stderr,
    killed: 0,
    async kill() {
      h.killed++;
      release?.();
      return true;
    },
    wait() {
      if (waitError) return Promise.reject(waitError);
      if (hang) return new Promise((_, rej) => (release = () => rej(new FakeExitError({ exitCode: 137 }))));
      return exitCode === 0 ? Promise.resolve({ exitCode }) : Promise.reject(new FakeExitError({ exitCode, error }));
    },
  };
  return h;
}

const make = (world, extra = {}) => createE2bBash({ Sandbox: world.Sandbox, apiKey: KEY, retryDelayMs: 0, ...extra });

test("returns stdout/stderr and exit code 0", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle({ stdout: "out\n", stderr: "err\n" })] });
  const r = await make({ Sandbox, world })("echo out");
  assert.deepEqual(r, { stdout: "out\n", stderr: "err\n", exitCode: 0, timedOut: false });
  assert.equal(world.runCalls[0].opts.background, true);
  assert.equal(world.runCalls[0].opts.cwd, "/home/user");
});

test("non-zero exit (CommandExitError) is a result, not an exception", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle({ stdout: "a", stderr: "b", exitCode: 3 })] });
  const r = await make({ Sandbox, world })("exit 3");
  assert.deepEqual(r, { stdout: "a", stderr: "b", exitCode: 3, timedOut: false });
});

test("command is wrapped for /bin/sh semantics: quoted as one argument, quotes/newlines/comments survive", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle()] });
  const command = `echo 'it''s' "q" $HOME \`x\` \\n\nsecond line # trailing comment`;
  await make({ Sandbox, world })(command);
  const sent = world.runCalls[0].cmd;
  assert.ok(sent.startsWith("exec /bin/sh -c '"));
  // Unquoting the single-quoted word must give back the original command.
  const body = sent.slice("exec /bin/sh -c ".length);
  assert.equal(body.slice(1, -1).replaceAll(`'\\''`, "'"), command);
});

test("timeout: pid killed, partial output kept, timedOut true; SDK timeout is above ours", async () => {
  const h = handle({ stdout: "partial", stderr: "warn", hang: true });
  const { Sandbox, world } = makeWorld({ runs: [() => h] });
  const t0 = Date.now();
  const r = await make({ Sandbox, world })("sleep 30", { timeoutMs: 80 });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(r, { stdout: "partial", stderr: "warn", timedOut: true });
  assert.equal(h.killed, 1);
  assert.ok(world.runCalls[0].opts.timeoutMs > 80);
});

test("timeoutMs is passed through; with none, defaultTimeoutMs (never the SDK's 60 s default) is used", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle()] });
  const bash = make({ Sandbox, world }, { defaultTimeoutMs: 300_000 });
  await bash("true", { timeoutMs: 120_000 });
  await bash("true");
  const [a, b] = world.runCalls.map((c) => c.opts.timeoutMs);
  assert.ok(a >= 120_000 && a < 200_000, String(a));
  assert.ok(b >= 300_000 && b < 400_000, String(b));
  assert.notEqual(a, 60_000);
  assert.notEqual(b, 60_000);
  // default default is 10 minutes
  const w2 = makeWorld({ runs: [() => handle()] });
  await make(w2)("true");
  assert.ok(w2.world.runCalls[0].opts.timeoutMs >= 600_000);
});

test("sandbox timeout = max(idleTimeoutMs, command timeout + 60 s)", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle()] });
  const bash = make({ Sandbox, world }, { idleTimeoutMs: 600_000 });
  await bash("a", { timeoutMs: 30_000 });
  assert.equal(world.connectCalls[0].opts.timeoutMs, 600_000);
  const w2 = makeWorld({ runs: [() => handle()] });
  await make(w2, { idleTimeoutMs: 600_000 })("a", { timeoutMs: 1_800_000 });
  assert.equal(w2.world.connectCalls[0].opts.timeoutMs, 1_860_000);
});

test("sandbox not found -> E2B_SANDBOX_MISSING; cache stays empty so a later call looks again", async () => {
  const { Sandbox, world } = makeWorld({ items: [] });
  const bash = make({ Sandbox, world });
  await assert.rejects(bash("x"), (e) => e.code === "E2B_SANDBOX_MISSING" && /e2b-setup/.test(e.message));
  assert.equal(world.runCalls.length, 0);
  world.items.push({ sandboxId: "late", state: "paused", startedAt: new Date(), metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" } });
  world.runs = [() => handle({ stdout: "ok" })];
  assert.equal((await bash("x")).stdout, "ok");
});

test("lookup filters by metadata app+name and covers running + paused", async () => {
  const { Sandbox, world } = makeWorld({
    items: [
      { sandboxId: "other", state: "running", startedAt: new Date(), metadata: { app: "pi-cloud-agents", name: "probe-1" } },
      { sandboxId: "mine", state: "paused", startedAt: new Date(), metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" } },
    ],
  });
  const sbx = await findE2bSandbox({ Sandbox, apiKey: KEY, name: "pi-cloud-agents", timeoutMs: 1000 });
  assert.equal(sbx.sandboxId, "mine");
  assert.deepEqual(world.listCalls[0].query.metadata, { app: "pi-cloud-agents", name: "pi-cloud-agents" });
  assert.deepEqual(world.listCalls[0].query.state, ["running", "paused"]);
  assert.equal(await findE2bSandbox({ Sandbox, apiKey: KEY, name: "nope" }), null);
});

test("paused between calls -> next call transparently reconnects (resumes) and succeeds", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle({ stdout: "ok" })] });
  const logs = [];
  const bash = make({ Sandbox, world }, { idleTimeoutMs: 50, log: (e) => logs.push(e) });
  await bash("first", { timeoutMs: 10 });
  world.items[0].state = "paused";
  await new Promise((r) => setTimeout(r, 120)); // beyond the known-alive window
  const r = await bash("second", { timeoutMs: 10 });
  assert.equal(r.stdout, "ok");
  assert.equal(world.listCalls.length, 1, "found once, then connect by id");
  assert.equal(world.connectCalls.length, 2);
  assert.equal(world.connectCalls[1].id, "sbx1");
  assert.equal(world.items[0].state, "running");
  assert.equal(logs[1].resumed, true);
});

test("inside the known-alive window no extra connect round trip", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle()] });
  const bash = make({ Sandbox, world }, { idleTimeoutMs: 600_000 });
  await bash("a", { timeoutMs: 1000 });
  await bash("b", { timeoutMs: 1000 });
  assert.equal(world.connectCalls.length, 1);
});

test("sandbox killed externally while cached: reconnect finds nothing -> E2B_SANDBOX_MISSING, cache cleared", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle()] });
  const bash = make({ Sandbox, world });
  await bash("a");
  world.items.length = 0;
  world.runError[1] = named("SandboxNotFoundError", "sandbox gone");
  await assert.rejects(bash("b"), (e) => e.code === "E2B_SANDBOX_MISSING");
  // a new sandbox appears -> next call recovers
  world.items.push({ sandboxId: "sbx2", state: "running", startedAt: new Date(), metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" } });
  const r = await bash("c");
  assert.equal(r.exitCode, 0);
  assert.equal(world.runCalls.at(-1).id, "sbx2");
});

test("connect failure -> retried once, then succeeds", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle({ stdout: "ok" })] });
  world.connectError[0] = new Error("network down");
  const logs = [];
  const r = await make({ Sandbox, world }, { log: (e) => logs.push(e) })("x");
  assert.equal(r.stdout, "ok");
  assert.equal(world.connectCalls.length, 2);
  assert.equal(logs[0].retries, 1);
});

test("connect failure twice -> E2B_CONNECT_FAILED, exactly two attempts", async () => {
  const { Sandbox, world } = makeWorld();
  world.connectError[0] = new Error("down");
  world.connectError[1] = new Error("still down");
  await assert.rejects(make({ Sandbox, world })("x"), (e) => e.code === "E2B_CONNECT_FAILED" && /after 1 retry: still down/.test(e.message));
  assert.equal(world.connectCalls.length, 2);
  assert.equal(world.runCalls.length, 0);
});

test("failure starting the command is retried once; failure after start is NOT retried", async () => {
  const w = makeWorld({ runs: [() => handle({ stdout: "ok" })] });
  w.world.runError[0] = new Error("envd unreachable");
  const r = await make(w)("x");
  assert.equal(r.stdout, "ok");
  assert.equal(w.world.runCalls.length, 2);

  const w2 = makeWorld({ runs: [() => handle({ waitError: new Error("stream reset") })] });
  await assert.rejects(make(w2)("git push"), (e) => e.code === "E2B_CONNECTION_ENDED" && /may or may not have run/.test(e.message));
  assert.equal(w2.world.runCalls.length, 1);
});

test("concurrent first calls share one lookup", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle({ stdout: "ok" })] });
  const bash = make({ Sandbox, world });
  const rs = await Promise.all([bash("a"), bash("b"), bash("c")]);
  assert.ok(rs.every((r) => r.stdout === "ok"));
  assert.equal(world.listCalls.length, 1);
  assert.equal(world.connectCalls.length, 1);
});

test("envs: only opts.env goes into the per-command envs; absent when empty", async () => {
  const w = makeWorld({ runs: [() => handle()] });
  await make(w, { env: { GH_TOKEN: GH } })("gh pr list");
  assert.deepEqual(w.world.runCalls[0].opts.envs, { GH_TOKEN: GH });
  assert.ok(!w.world.runCalls[0].cmd.includes(GH));
  const w2 = makeWorld({ runs: [() => handle()] });
  await make(w2)("true");
  assert.equal(w2.world.runCalls[0].opts.envs, undefined);
});

test("errors never contain the API key, env values or secrets (and no command text)", async () => {
  const leak = `boom ${KEY} ${GH} extra-secret-value https://api.e2b.app/sandboxes?apiKey=${KEY}`;
  const w = makeWorld();
  w.world.connectError[0] = new Error(leak);
  w.world.connectError[1] = new Error(leak);
  await assert.rejects(make(w, { env: { GH_TOKEN: GH }, secrets: ["extra-secret-value"] })('echo "secret command text"'), (e) => {
    for (const s of [KEY, GH, "extra-secret-value", "apiKey=", "secret command text"]) assert.ok(!e.message.includes(s), `${s} in: ${e.message}`);
    assert.match(e.message, /\*\*\*/);
    return true;
  });
  const w2 = makeWorld({ runs: [() => handle({ waitError: new Error(`reset ${GH}`) })] });
  await assert.rejects(make(w2, { env: { GH_TOKEN: GH } })("x"), (e) => !e.message.includes(GH));
});

test("log receives only length, duration, exit code, retries, outcome, resumed", async () => {
  const logs = [];
  const { Sandbox, world } = makeWorld({ runs: [() => handle({ stdout: "OUTPUT-TEXT" })] });
  await make({ Sandbox, world }, { log: (e) => logs.push(e) })("echo COMMAND-TEXT");
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ["commandLength", "exitCode", "ms", "outcome", "resumed", "retries"]);
  const s = JSON.stringify(logs);
  assert.ok(!s.includes("COMMAND-TEXT") && !s.includes("OUTPUT-TEXT"));
});

test("a throwing log function does not break the call", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle()] });
  const r = await make({ Sandbox, world }, { log: () => { throw new Error("log down"); } })("x");
  assert.equal(r.exitCode, 0);
});

test("factory validates arguments; missing key -> E2B_CONFIG", () => {
  assert.throws(() => createE2bBash({ apiKey: KEY }), TypeError);
  const { Sandbox } = makeWorld();
  assert.throws(() => createE2bBash({ Sandbox }), (e) => e.code === "E2B_CONFIG");
});

test("production instance: missing E2B_API_KEY -> E2B_CONFIG without leaking values", async () => {
  const saved = process.env.E2B_API_KEY;
  try {
    delete process.env.E2B_API_KEY;
    await assert.rejects(e2bBash("true"), (e) => e.code === "E2B_CONFIG" && /E2B_API_KEY/.test(e.message));
  } finally {
    if (saved === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = saved;
  }
});

test("getE2bInfo has sandbox and name only; name defaults to pi-cloud-agents", () => {
  const prev = process.env.TARSBOT_E2B_NAME;
  try {
    delete process.env.TARSBOT_E2B_NAME;
    assert.deepEqual(getE2bInfo(), { sandbox: "e2b", name: "pi-cloud-agents" });
    process.env.TARSBOT_E2B_NAME = "other";
    assert.deepEqual(getE2bInfo(), { sandbox: "e2b", name: "other" });
  } finally {
    if (prev === undefined) delete process.env.TARSBOT_E2B_NAME;
    else process.env.TARSBOT_E2B_NAME = prev;
  }
});

test("killed by a signal (SDK exitCode -1, error 'signal: killed') is reported as 137", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle({ exitCode: -1, error: "signal: killed" })] });
  assert.equal((await make({ Sandbox, world })("kill -9 $$")).exitCode, 137);
  const w2 = makeWorld({ runs: [() => handle({ exitCode: -1, error: "signal: terminated" })] });
  assert.equal((await make(w2)("x")).exitCode, 143);
  const w3 = makeWorld({ runs: [() => handle({ exitCode: -1 })] });
  assert.equal((await make(w3)("x")).exitCode, 137);
});

test("scripts too big for one argv element are uploaded and run from a temp file, then removed", async () => {
  const big = `echo start\n${": filler line\n".repeat(10_000)}echo done`; // ~140 KB
  const { Sandbox, world } = makeWorld({ runs: [() => handle({ stdout: "done\n" })] });
  const bash = make({ Sandbox, world });
  const r = await bash(big);
  assert.equal(r.stdout, "done\n");
  assert.equal(world.writes.length, 1);
  assert.equal(world.writes[0].data, big);
  const sent = world.runCalls[0].cmd;
  assert.ok(sent.length < 1000, "argv stays small");
  assert.ok(sent.includes(world.writes[0].path) && /rm -f/.test(sent) && /exit \$rc/.test(sent));
  await bash("echo hi"); // small commands never upload
  assert.equal(world.writes.length, 1);
});

test("upload failure is a start-phase failure: retried once, then E2B_CONNECT_FAILED without the command text", async () => {
  const big = "echo SECRET-CMD-TEXT\n" + ": filler line\n".repeat(10_000);
  const { Sandbox, world } = makeWorld();
  world.writeError = new Error("upload broke");
  await assert.rejects(make({ Sandbox, world })(big), (e) => e.code === "E2B_CONNECT_FAILED" && !e.message.includes("SECRET-CMD-TEXT"));
  assert.equal(world.writes.length, 2);
});

test("SDK errors that embed the command text are scrubbed and truncated", async () => {
  const command = "echo top-secret-command-body";
  const { Sandbox, world } = makeWorld();
  const embed = new Error(`[invalid_argument] error starting process '${command}': ${command} ${"x".repeat(5000)}`);
  world.runError[0] = embed;
  world.runError[1] = embed;
  await assert.rejects(make({ Sandbox, world })(command), (e) => {
    assert.ok(!e.message.includes("top-secret-command-body"), e.message);
    assert.ok(e.message.length < 800, String(e.message.length));
    return true;
  });
});

test("requested sandbox timeout is clamped to maxTimeoutMs (Hobby: 1 h); no reconnect storm", async () => {
  const { Sandbox, world } = makeWorld({ runs: [() => handle()] });
  const bash = make({ Sandbox, world }, { maxTimeoutMs: 3_600_000 });
  await bash("a", { timeoutMs: 7_200_000 });
  assert.equal(world.connectCalls[0].opts.timeoutMs, 3_600_000);
  await bash("b", { timeoutMs: 7_200_000 });
  assert.equal(world.connectCalls.length, 1);
});
