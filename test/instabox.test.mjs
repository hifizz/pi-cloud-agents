// Offline tests for src/sandbox/instabox.mjs. The fake mirrors only the @insforge/instabox-sdk surface we use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandExitError as SdkCommandExitError } from "@insforge/instabox-sdk";

const { createInstaboxBash, findInstaboxSandbox, getInstaboxInfo, instaboxBash } = await import("../src/sandbox/instabox.mjs");

const KEY = "ibk_SECRETKEY1234567890";
const GH = "ghp_SECRETTOKEN1234567890";
const API_URL = "https://api.instabox.test";

const commandResult = (overrides = {}) => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, ...overrides });
const named = (name, message, extra = {}) => Object.assign(new Error(message), { name, ...extra });

class FakeCommandExitError extends Error {
  constructor(result) {
    super(`command exited ${result.exitCode}`);
    this.name = "CommandExitError";
    Object.assign(this, result);
  }
}

function makeWorld({
  items = [],
  runs = [() => commandResult()],
} = {}) {
  const world = {
    items,
    runs,
    listCalls: [],
    connectCalls: [],
    createCalls: [],
    runCalls: [],
    connectErrors: [],
    createErrors: [],
    runErrors: [],
    lifecycleCalls: [],
    nextId: 1,
  };

  const handle = (id) => {
    const item = world.items.find((candidate) => candidate.sandboxId === id);
    return {
      sandboxId: id,
      commands: {
        run: async (command, opts) => {
          const index = world.runCalls.length;
          world.runCalls.push({ id, command, opts });
          if (world.runErrors[index]) throw world.runErrors[index];
          return world.runs[Math.min(index, world.runs.length - 1)]({ command, opts, index });
        },
      },
      disableVault: async () => {
        world.lifecycleCalls.push({ id, op: "disableVault" });
        if (item) item.vault = false;
      },
      setAutoSuspend: async (ms) => {
        world.lifecycleCalls.push({ id, op: "setAutoSuspend", ms });
        if (item) item.autoSuspendMs = ms;
      },
      resume: async () => {
        world.lifecycleCalls.push({ id, op: "resume" });
        if (item) item.state = "running";
      },
    };
  };

  class FakeSandbox {
    static async list(opts) {
      world.listCalls.push(opts);
      await new Promise((resolve) => setImmediate(resolve));
      const metadata = opts.metadata ?? {};
      return world.items.filter((item) => Object.entries(metadata).every(([key, value]) => item.metadata?.[key] === value));
    }

    static async connect(id, opts) {
      const index = world.connectCalls.length;
      world.connectCalls.push({ id, opts });
      if (world.connectErrors[index]) throw world.connectErrors[index];
      const item = world.items.find((candidate) => candidate.sandboxId === id);
      if (!item) throw named("InstaboxError", "missing", { code: "not_found", status: 404 });
      if (opts.resume !== false) item.state = "running";
      return handle(id);
    }

    static async create(template, opts) {
      const index = world.createCalls.length;
      world.createCalls.push({ template, opts });
      if (world.createErrors[index]) throw world.createErrors[index];
      const sandboxId = `created-${world.nextId++}`;
      world.items.push({
        sandboxId,
        state: "running",
        startedAt: new Date(),
        metadata: opts.metadata,
        name: opts.name,
        vault: opts.vault !== false,
        autoSuspendMs: opts.autoSuspendMs,
      });
      return handle(sandboxId);
    }
  }

  return { Sandbox: FakeSandbox, world };
}

const make = ({ Sandbox, world }, extra = {}) =>
  createInstaboxBash({ Sandbox, CommandExitError: FakeCommandExitError, apiKey: KEY, apiUrl: API_URL, bootstrap: false, ...extra });

test("finds the one usable app+name match, reconciles it, and connects with auth", async () => {
  const { Sandbox, world } = makeWorld({
    items: [
      {
        sandboxId: "ours",
        state: "suspended",
        vault: false,
        autoSuspendMs: 600_000,
        startedAt: new Date("2026-10-01"),
        metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" },
      },
      { sandboxId: "wrong", state: "running", startedAt: new Date(), metadata: { app: "pi-cloud-agents", name: "other" } },
      { sandboxId: "broken", state: "error", startedAt: new Date(), metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" } },
    ],
  });
  const sandbox = await findInstaboxSandbox({ Sandbox, apiKey: KEY, apiUrl: API_URL });
  assert.equal(sandbox.sandboxId, "ours");
  assert.deepEqual(world.listCalls, [{ apiKey: KEY, apiUrl: API_URL, metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" } }]);
  assert.deepEqual(world.connectCalls, [{ id: "ours", opts: { apiKey: KEY, apiUrl: API_URL, resume: false } }]);
  assert.deepEqual(world.lifecycleCalls, [{ id: "ours", op: "resume" }]);
});

test("multiple usable metadata matches fail rather than choosing a persistent disk", async () => {
  const fixture = makeWorld({
    items: [
      { sandboxId: "one", state: "running", metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" } },
      { sandboxId: "two", state: "suspended", metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" } },
    ],
  });
  await assert.rejects(
    findInstaboxSandbox({ Sandbox: fixture.Sandbox, apiKey: KEY }),
    (error) => error.code === "INSTABOX_SANDBOX_AMBIGUOUS" && /refusing to choose/.test(error.message),
  );
  assert.equal(fixture.world.connectCalls.length, 0);
});

test("a sole candidate that vanishes during connect returns no match", async () => {
  const fixture = makeWorld({
    items: [
      {
        sandboxId: "gone",
        state: "running",
        vault: false,
        autoSuspendMs: 600_000,
        startedAt: new Date("2026-10-20"),
        metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" },
      },
    ],
  });
  fixture.world.connectErrors[0] = named("InstaboxError", "gone", { code: "not_found", status: 404 });
  const sandbox = await findInstaboxSandbox({ Sandbox: fixture.Sandbox, apiKey: KEY });
  assert.equal(sandbox, null);
  assert.deepEqual(fixture.world.connectCalls.map((call) => call.id), ["gone"]);
});

test("reuse synchronizes auto-suspend before resume when Vault is already disabled", async () => {
  const fixture = makeWorld({
    items: [
      {
        sandboxId: "legacy",
        state: "suspended",
        vault: false,
        autoSuspendMs: 1_800_000,
        metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" },
      },
    ],
  });
  const sandbox = await findInstaboxSandbox({ Sandbox: fixture.Sandbox, apiKey: KEY, autoSuspendMs: 300_000 });
  assert.equal(sandbox.sandboxId, "legacy");
  assert.deepEqual(fixture.world.lifecycleCalls, [
    { id: "legacy", op: "setAutoSuspend", ms: 300_000 },
    { id: "legacy", op: "resume" },
  ]);
});

test("a reusable sandbox with Vault enabled is rejected before connect or user code", async () => {
  const fixture = makeWorld({
    items: [
      {
        sandboxId: "unsafe-running",
        state: "running",
        vault: true,
        autoSuspendMs: 600_000,
        metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" },
      },
    ],
  });
  await assert.rejects(
    findInstaboxSandbox({ Sandbox: fixture.Sandbox, apiKey: KEY }),
    (error) => error.code === "INSTABOX_VAULT_UNSAFE" && /refusing to reuse/.test(error.message),
  );
  assert.equal(fixture.world.connectCalls.length, 0);
  assert.equal(fixture.world.runCalls.length, 0);
});

test("missing sandbox is lazily created with safe defaults; commands carry cwd, env and timeout", async () => {
  const fixture = makeWorld({ runs: [() => commandResult({ stdout: "ok\n", stderr: "warn\n" })] });
  const bash = make(fixture, { env: { GH_TOKEN: GH } });
  const result = await bash("printf ok", { timeoutMs: 12_345 });

  assert.deepEqual(result, { stdout: "ok\n", stderr: "warn\n", exitCode: 0, timedOut: false });
  assert.equal(fixture.world.listCalls.length, 1);
  assert.deepEqual(fixture.world.createCalls, [
    {
      template: "agent-browser",
      opts: {
        apiKey: KEY,
        apiUrl: API_URL,
        name: "pi-cloud-agents",
        metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" },
        autoSuspendMs: 600_000,
        vault: false,
      },
    },
  ]);
  assert.deepEqual(fixture.world.runCalls[0], {
    id: "created-1",
    command: "printf ok",
    opts: { cwd: "/data/home", envs: { GH_TOKEN: GH }, timeoutMs: 12_345 },
  });
});

test("bootstrap runs once before user commands and stores only a GH_TOKEN reference", async () => {
  const fixture = makeWorld({
    runs: [
      () => commandResult(),
      () => commandResult({ stdout: "first" }),
      () => commandResult({ stdout: "second" }),
    ],
  });
  const bash = createInstaboxBash({
    Sandbox: fixture.Sandbox,
    CommandExitError: FakeCommandExitError,
    apiKey: KEY,
    apiUrl: API_URL,
    env: { GH_TOKEN: GH },
    gitEmail: "bot@example.test",
  });

  assert.equal((await bash("printf first", { timeoutMs: 4567 })).stdout, "first");
  assert.equal((await bash("printf second")).stdout, "second");
  assert.equal(fixture.world.runCalls.length, 3);
  const [setup, first, second] = fixture.world.runCalls;
  assert.match(setup.command, /mkdir -p -- '\/data\/home\/workspace'/);
  for (const tool of ["git", "gh", "node", "npm", "python3", "curl", "jq"]) assert.match(setup.command, new RegExp(`\\b${tool}\\b`));
  assert.match(setup.command, /user\.name TARSBot/);
  assert.match(setup.command, /bot@example\.test/);
  assert.match(setup.command, /password=\$GH_TOKEN/);
  assert.doesNotMatch(setup.command, new RegExp(GH));
  assert.deepEqual(setup.opts, { cwd: "/data/home", envs: { GH_TOKEN: GH }, timeoutMs: 120_000 });
  assert.equal(first.command, "printf first");
  assert.equal(first.opts.timeoutMs, 4567);
  assert.equal(second.command, "printf second");
});

test("bootstrap failure never submits the user command and is retryable without leaking secrets", async () => {
  const fixture = makeWorld({ runs: [() => commandResult(), () => commandResult({ stdout: "ok" })] });
  fixture.world.runErrors[0] = new FakeCommandExitError(
    commandResult({ stderr: `missing gh for ${KEY} ${GH}`, exitCode: 127 }),
  );
  const bash = createInstaboxBash({
    Sandbox: fixture.Sandbox,
    CommandExitError: FakeCommandExitError,
    apiKey: KEY,
    env: { GH_TOKEN: GH },
  });

  await assert.rejects(bash("must-not-run"), (error) => {
    assert.equal(error.code, "INSTABOX_BOOTSTRAP_FAILED");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, new RegExp(KEY));
    assert.doesNotMatch(error.message, new RegExp(GH));
    assert.match(error.message, /exit 127/);
    return true;
  });
  assert.equal(fixture.world.runCalls.length, 1);
  assert.doesNotMatch(fixture.world.runCalls[0].command, /must-not-run/);

  assert.equal((await bash("now-run")).stdout, "ok");
  assert.equal(fixture.world.runCalls.length, 3);
  assert.notEqual(fixture.world.runCalls[1].command, "now-run", "bootstrap retried first");
  assert.equal(fixture.world.runCalls[2].command, "now-run");
});

test("cached sandbox is reused and concurrent first calls share one lookup/create", async () => {
  const fixture = makeWorld({ runs: [() => commandResult({ stdout: "ok" })] });
  const bash = make(fixture);
  const results = await Promise.all([bash("a"), bash("b"), bash("c")]);
  assert.ok(results.every((result) => result.stdout === "ok"));
  assert.equal(fixture.world.listCalls.length, 1);
  assert.equal(fixture.world.createCalls.length, 1);
  assert.equal(fixture.world.runCalls.length, 3);
  await bash("d");
  assert.equal(fixture.world.listCalls.length, 1);
  assert.equal(fixture.world.createCalls.length, 1);
});

test("non-zero CommandExitError is a normal result", async () => {
  const fixture = makeWorld();
  fixture.world.runErrors[0] = new FakeCommandExitError(commandResult({ stdout: "out", stderr: "bad", exitCode: 7 }));
  assert.deepEqual(await make(fixture)("exit 7"), { stdout: "out", stderr: "bad", exitCode: 7, timedOut: false });
});

test("the real SDK CommandExitError is mapped without network access", async () => {
  const fixture = makeWorld();
  fixture.world.runErrors[0] = new SdkCommandExitError(commandResult({ stdout: "sdk", stderr: "bad", exitCode: 9 }));
  const bash = createInstaboxBash({
    Sandbox: fixture.Sandbox,
    CommandExitError: SdkCommandExitError,
    apiKey: KEY,
    bootstrap: false,
  });
  assert.deepEqual(await bash("exit 9"), { stdout: "sdk", stderr: "bad", exitCode: 9, timedOut: false });
});

test("CommandExitError timeout preserves partial output and omits exitCode", async () => {
  const fixture = makeWorld();
  fixture.world.runErrors[0] = new FakeCommandExitError(commandResult({ stdout: "partial", stderr: "late", exitCode: 124, timedOut: true }));
  assert.deepEqual(await make(fixture)("sleep 30", { timeoutMs: 80 }), { stdout: "partial", stderr: "late", timedOut: true });
});

test("successful response marked timedOut is also mapped to the timeout contract", async () => {
  const fixture = makeWorld({ runs: [() => commandResult({ stdout: "partial", exitCode: 124, timedOut: true })] });
  assert.deepEqual(await make(fixture)("x"), { stdout: "partial", stderr: "", timedOut: true });
});

test("command transport errors are never retried and redact key, env and command", async () => {
  const command = "git push secret-branch";
  const fixture = makeWorld();
  fixture.world.runErrors[0] = named("InstaboxError", `network failed ${KEY} ${GH}: ${command}`, { code: "network_error" });
  const bash = make(fixture, { env: { GH_TOKEN: GH } });
  await assert.rejects(bash(command), (error) => {
    assert.equal(error.code, "INSTABOX_COMMAND_FAILED");
    assert.equal(error.cause, undefined);
    assert.match(error.message, /may or may not have run/);
    assert.doesNotMatch(error.message, new RegExp(KEY));
    assert.doesNotMatch(error.message, new RegExp(GH));
    assert.doesNotMatch(error.message, /git push secret-branch/);
    return true;
  });
  assert.equal(fixture.world.runCalls.length, 1);
});

test("not_found clears the cached machine for the next call but does not replay the failed command", async () => {
  const fixture = makeWorld({
    items: [
      {
        sandboxId: "old",
        state: "running",
        vault: false,
        autoSuspendMs: 600_000,
        startedAt: new Date(),
        metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" },
      },
    ],
    runs: [() => commandResult({ stdout: "recovered" })],
  });
  fixture.world.runErrors[0] = named("InstaboxError", "machine is gone", { code: "not_found", status: 404 });
  const bash = make(fixture);
  await assert.rejects(bash("first"), (error) => error.code === "INSTABOX_COMMAND_FAILED");
  assert.equal(fixture.world.runCalls.length, 1, "failed command was not replayed");
  fixture.world.items.length = 0;
  const result = await bash("second");
  assert.equal(result.stdout, "recovered");
  assert.equal(fixture.world.listCalls.length, 2);
  assert.equal(fixture.world.createCalls.length, 1);
});

test("a delayed not_found from an old handle cannot clear a replacement handle", async () => {
  let releaseOld;
  const oldFailure = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const gone = named("InstaboxError", "machine is gone", { code: "not_found", status: 404 });
  const fixture = makeWorld({
    items: [
      {
        sandboxId: "old",
        state: "running",
        vault: false,
        autoSuspendMs: 600_000,
        metadata: { app: "pi-cloud-agents", name: "pi-cloud-agents" },
      },
    ],
    runs: [
      async () => {
        await oldFailure;
        throw gone;
      },
      () => {
        throw gone;
      },
      () => commandResult({ stdout: "new" }),
    ],
  });
  const bash = make(fixture);
  const delayed = bash("old-delayed");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(bash("old-fast"), (error) => error.code === "INSTABOX_COMMAND_FAILED");
  fixture.world.items.length = 0;
  assert.equal((await bash("replacement")).stdout, "new");
  releaseOld();
  await assert.rejects(delayed, (error) => error.code === "INSTABOX_COMMAND_FAILED");

  assert.equal((await bash("still-replacement")).stdout, "new");
  assert.equal(fixture.world.listCalls.length, 2);
  assert.equal(fixture.world.createCalls.length, 1);
});

test("list failures are retryable on a later call and never leak secrets", async () => {
  const fixture = makeWorld({ runs: [() => commandResult({ stdout: "ok" })] });
  const originalList = fixture.Sandbox.list;
  let calls = 0;
  fixture.Sandbox.list = async (opts) => {
    calls++;
    if (calls === 1) throw named("InstaboxAuthError", `bad key ${KEY}`, { code: "invalid_api_key" });
    return originalList.call(fixture.Sandbox, opts);
  };
  const bash = make(fixture);
  await assert.rejects(bash("first"), (error) => {
    assert.equal(error.code, "INSTABOX_CONNECT_FAILED");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, new RegExp(KEY));
    return true;
  });
  assert.equal((await bash("second")).stdout, "ok");
  assert.equal(calls, 2);
});

test("create failures are wrapped safely and a later call can retry", async () => {
  const fixture = makeWorld({ runs: [() => commandResult({ stdout: "ok" })] });
  fixture.world.createErrors[0] = named("InstaboxQuotaError", `quota exceeded for ${KEY}`, { code: "quota_exceeded", status: 429 });
  const bash = make(fixture);

  await assert.rejects(bash("first"), (error) => {
    assert.equal(error.code, "INSTABOX_CONNECT_FAILED");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, new RegExp(KEY));
    assert.match(error.message, /quota_exceeded/);
    return true;
  });
  assert.equal(fixture.world.runCalls.length, 0);
  assert.equal(fixture.world.createCalls.length, 1);

  assert.equal((await bash("second")).stdout, "ok");
  assert.equal(fixture.world.listCalls.length, 2);
  assert.equal(fixture.world.createCalls.length, 2);
});

test("truncated and malformed responses fail explicitly", async () => {
  const truncated = makeWorld({ runs: [() => commandResult({ stdout: "cut", truncated: true })] });
  await assert.rejects(make(truncated)("lots"), (error) => error.code === "INSTABOX_OUTPUT_TRUNCATED" && /1 MiB/.test(error.message));

  const malformed = makeWorld({ runs: [() => ({ stdout: "ok", stderr: "", timedOut: false, truncated: false })] });
  await assert.rejects(make(malformed)("bad"), (error) => error.code === "INSTABOX_INVALID_RESPONSE");
});

test("timeout and factory configuration are validated before network access", async () => {
  const fixture = makeWorld();
  const bash = make(fixture);
  for (const timeoutMs of [0, -1, Infinity, 600_001]) {
    await assert.rejects(bash("x", { timeoutMs }), (error) => error.code === "INSTABOX_TIMEOUT_INVALID");
  }
  assert.equal(fixture.world.listCalls.length, 0);
  assert.throws(() => createInstaboxBash({ Sandbox: fixture.Sandbox }), (error) => error.code === "INSTABOX_CONFIG");
  assert.throws(() => make(fixture, { name: "Bad Name" }), (error) => error.code === "INSTABOX_CONFIG");
  assert.throws(() => make(fixture, { home: "relative" }), (error) => error.code === "INSTABOX_CONFIG");
  assert.throws(() => make(fixture, { autoSuspendMs: 1000 }), (error) => error.code === "INSTABOX_CONFIG");
  assert.throws(() => make(fixture, { bootstrapTimeoutMs: 600_001 }), (error) => error.code === "INSTABOX_TIMEOUT_INVALID");
  assert.throws(() => make(fixture, { gitEmail: "" }), (error) => error.code === "INSTABOX_CONFIG");
  assert.throws(() => createInstaboxBash({ Sandbox: {} }), /requires a Sandbox class/);
});

test("log contains metadata only; a throwing logger cannot break execution", async () => {
  const fixture = makeWorld({ runs: [() => commandResult({ stdout: "SECRET OUTPUT" })] });
  const logs = [];
  const command = "echo SECRET COMMAND";
  await make(fixture, { log: (entry) => logs.push(entry) })(command);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ["commandLength", "exitCode", "ms", "outcome"]);
  assert.equal(logs[0].commandLength, command.length);
  assert.equal(logs[0].outcome, "ok");
  assert.ok(!JSON.stringify(logs).includes("SECRET"));

  const second = makeWorld();
  assert.equal((await make(second, { log: () => { throw new Error("logger down"); } })("true")).exitCode, 0);
});

test("info is synchronous; production config errors occur before any network request", async () => {
  const previousName = process.env.TARSBOT_INSTABOX_NAME;
  const previousKey = process.env.INSTABOX_API_KEY;
  const previousIdle = process.env.TARSBOT_INSTABOX_IDLE_MS;
  try {
    delete process.env.TARSBOT_INSTABOX_NAME;
    delete process.env.INSTABOX_API_KEY;
    assert.deepEqual(getInstaboxInfo(), { sandbox: "instabox", name: "pi-cloud-agents" });
    process.env.TARSBOT_INSTABOX_NAME = "mine";
    assert.deepEqual(getInstaboxInfo(), { sandbox: "instabox", name: "mine" });
    await assert.rejects(instaboxBash("true"), (error) => error.code === "INSTABOX_CONFIG" && !error.message.includes(KEY));
    process.env.INSTABOX_API_KEY = KEY;
    for (const idle of ["-1", "not-a-number", "1000"]) {
      process.env.TARSBOT_INSTABOX_IDLE_MS = idle;
      await assert.rejects(instaboxBash("true"), (error) => error.code === "INSTABOX_CONFIG" && /IDLE_MS/.test(error.message));
    }
  } finally {
    if (previousName === undefined) delete process.env.TARSBOT_INSTABOX_NAME;
    else process.env.TARSBOT_INSTABOX_NAME = previousName;
    if (previousKey === undefined) delete process.env.INSTABOX_API_KEY;
    else process.env.INSTABOX_API_KEY = previousKey;
    if (previousIdle === undefined) delete process.env.TARSBOT_INSTABOX_IDLE_MS;
    else process.env.TARSBOT_INSTABOX_IDLE_MS = previousIdle;
  }
});
