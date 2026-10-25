// Offline tests for src/sandbox/instabox.mjs (fake fetch that mimics the instabox.sh REST surface we use).
import { test } from "node:test";
import assert from "node:assert/strict";

const { createInstaboxBash, findInstaboxMachine, instaboxApi, waitOperation, getInstaboxInfo, instaboxBash } = await import(
  "../src/sandbox/instabox.mjs"
);

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

/** fetch failure whose cause provably precedes the request (connect refused), like undici produces. */
const refused = () => {
  const cause = new Error("connect ECONNREFUSED 1.2.3.4:443");
  cause.code = "ECONNREFUSED";
  const e = new TypeError("fetch failed");
  e.cause = cause;
  return e;
};
/** fetch failure after the request was sent (connection reset mid-response). */
const reset = () => {
  const cause = new Error("read ECONNRESET");
  cause.code = "ECONNRESET";
  const e = new TypeError("fetch failed");
  e.cause = cause;
  return e;
};
const aborted = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

/**
 * Fake world. Scripted behaviours (consumed in order, last item sticks unless noted):
 *   world.machine: machine object | null (GET /v1/machines/{name}); world.machineScript: per-call overrides
 *   world.execScript: exec responses ({stdout,...} | {status, code} | Error); world.execErrors[i]: thrown before response i
 *   world.startResponses: POST /start overrides ({status, code}); world.opStates: successive operation poll states
 */
function makeWorld({ machine = { id: "m1", name: "pi-cloud-agents", state: "running", metadata: { app: "pi-cloud-agents" } }, execScript, startResponses, opStates } = {}) {
  const world = {
    machine,
    machineScript: [],
    execScript: execScript ?? [{ stdout: "out\n", stderr: "err\n", exitCode: 0, timedOut: false, truncated: false }],
    execErrors: [],
    startResponses: startResponses ?? [],
    opStates: opStates ?? ["succeeded"],
    calls: [],
    execIndex: 0,
  };
  world.fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    world.calls.push({ method, path: u.pathname + u.search, headers: init.headers ?? {}, body });
    if (u.pathname === "/v1/machines" && method === "GET") {
      return ok({ machines: world.machine ? [world.machine] : [], cursor: null });
    }
    if (/^\/v1\/machines\/[^/]+$/.test(u.pathname) && method === "GET") {
      const scripted = world.machineScript.shift();
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted; // a respond() object
      if (!world.machine) return apiFail(404, "not_found", `no machine ${u.pathname.split("/").pop()}`);
      return ok(world.machine);
    }
    if (/\/exec$/.test(u.pathname) && method === "POST") {
      const i = world.execIndex++;
      const pre = world.execErrors[i];
      if (pre) {
        if (pre instanceof Error) throw pre;
        return apiFail(pre.status, pre.code, pre.message ?? "boom");
      }
      const r = world.execScript[Math.min(i, world.execScript.length - 1)];
      if (r instanceof Error) throw r;
      if (r && r.status !== undefined) return apiFail(r.status, r.code, r.message ?? "boom");
      return ok(r);
    }
    if (/\/start$/.test(u.pathname) && method === "POST") {
      const scripted = world.startResponses.shift();
      if (scripted) return scripted.status !== undefined ? apiFail(scripted.status, scripted.code, scripted.message ?? "boom") : ok(scripted);
      world.opSeq = (world.opSeq ?? 0) + 1;
      world.latestOp = { id: `op-${world.opSeq}`, type: "start", state: "running" };
      world.machine = { ...world.machine, state: "running" };
      return respond(202, world.latestOp); // 202 answers carry the bare Operation object (live OpenAPI)
    }
    if (/\/wake$/.test(u.pathname) && method === "POST") {
      world.opSeq = (world.opSeq ?? 0) + 1;
      world.latestOp = { id: `op-${world.opSeq}`, type: "wake", state: "running" };
      return respond(202, world.latestOp);
    }
    if (/^\/v1\/operations\//.test(u.pathname) && method === "GET") {
      await new Promise((r) => setTimeout(r, world.opPollMs ?? 2)); // emulate the server-side long-poll
      const state = world.opStates.shift() ?? "succeeded";
      const base = world.latestOp ?? { id: decodeURIComponent(u.pathname.split("/").pop()), type: "start" };
      base.state = state;
      return ok(state === "succeeded" ? { ...base, machine: world.machine } : { ...base, error: { code: "start_failed", message: "machine did not start" } });
    }
    throw new Error(`fake fetch: unhandled ${method} ${u.pathname}`);
  };
  return world;
}

const make = (world, extra = {}) => createInstaboxBash({ fetchImpl: world.fetchImpl, apiKey: KEY, retryDelayMs: 0, ...extra });
const execCalls = (world) => world.calls.filter((c) => c.path.endsWith("/exec"));

test("returns stdout/stderr and exit code 0; request shape: resolve by name once, exec by id, key header, no idempotency key on exec", async () => {
  const world = makeWorld();
  const r = await make(world)("echo out");
  assert.deepEqual(r, { stdout: "out\n", stderr: "err\n", exitCode: 0, timedOut: false });
  assert.deepEqual(
    world.calls.map((c) => `${c.method} ${c.path}`),
    ["GET /v1/machines/pi-cloud-agents", "POST /v1/machines/m1/exec"],
  );
  assert.equal(world.calls[0].headers["x-api-key"], KEY);
  assert.equal(world.calls[1].headers["x-api-key"], KEY);
  assert.equal(world.calls[1].headers["idempotency-key"], undefined);
  assert.equal(world.calls[1].body.cwd, "/data/home");
  assert.ok(Number.isInteger(world.calls[1].body.timeoutSeconds));
});

test("non-zero exit is a result, not an exception", async () => {
  const world = makeWorld({ execScript: [{ stdout: "a", stderr: "b", exitCode: 3, timedOut: false }] });
  const r = await make(world)("exit 3");
  assert.deepEqual(r, { stdout: "a", stderr: "b", exitCode: 3, timedOut: false });
});

test("command is wrapped for /bin/sh semantics: quoted as one argument, quotes/newlines/comments survive", async () => {
  const world = makeWorld();
  const command = `echo 'it''s' "q" $HOME \`x\` \\n\nsecond line # trailing comment`;
  await make(world)(command);
  const sent = world.calls[1].body.cmd;
  assert.ok(sent.startsWith("exec /bin/sh -c '"));
  const body = sent.slice("exec /bin/sh -c ".length);
  assert.equal(body.slice(1, -1).replaceAll(`'\\''`, "'"), command);
  assert.equal(world.calls[1].body.envs, undefined);
});

test("timeoutSeconds: ceil of the budget, clamped to [1, 600]; default 600 when no timeoutMs", async () => {
  const world = makeWorld();
  const bash = make(world);
  await bash("a", { timeoutMs: 30_000 });
  assert.equal(world.calls[1].body.timeoutSeconds, 30);
  await bash("b", { timeoutMs: 50 });
  assert.equal(execCalls(world)[1].body.timeoutSeconds, 1);
  await bash("c", { timeoutMs: 2_400_000 });
  assert.equal(execCalls(world)[2].body.timeoutSeconds, 600);
  await bash("d");
  assert.equal(execCalls(world)[3].body.timeoutSeconds, 600);
});

test("server-side kill (timedOut: true) maps to {timedOut: true}; truncated lands in the log only", async () => {
  const world = makeWorld({ execScript: [{ stdout: "partial", stderr: "", exitCode: null, timedOut: true, truncated: true }] });
  const logs = [];
  const r = await make(world, { log: (e) => logs.push(e) })("sleep 999", { timeoutMs: 1000 });
  assert.deepEqual(r, { stdout: "partial", stderr: "", timedOut: true });
  assert.equal(logs[0].outcome, "timeout");
  assert.equal(logs[0].truncated, true);
});

test("machine missing -> INSTABOX_SANDBOX_MISSING pointing at the setup script; no exec is attempted; recovers when it appears", async () => {
  const world = makeWorld({ machine: null });
  const bash = make(world);
  await assert.rejects(bash("x"), (e) => e.code === "INSTABOX_SANDBOX_MISSING" && /instabox-setup/.test(e.message));
  assert.equal(execCalls(world).length, 0);
  world.machine = { id: "late", name: "pi-cloud-agents", state: "running" };
  assert.equal((await bash("x")).stdout, "out\n");
});

test("409 machine_not_running -> start with Idempotency-Key, operation polled with wait=25s, exec retried once, woke logged", async () => {
  const world = makeWorld({ machine: { id: "m1", name: "pi-cloud-agents", state: "stopped" } });
  world.execScript = [
    { status: 409, code: "machine_not_running" },
    { stdout: "ok", stderr: "", exitCode: 0, timedOut: false },
  ];
  const logs = [];
  const r = await make(world, { log: (e) => logs.push(e) })("x");
  assert.equal(r.stdout, "ok");
  assert.deepEqual(
    world.calls.map((c) => `${c.method} ${c.path}`),
    ["GET /v1/machines/pi-cloud-agents", "POST /v1/machines/m1/exec", "POST /v1/machines/m1/start", "GET /v1/operations/op-1?wait=25s", "POST /v1/machines/m1/exec"],
  );
  assert.match(world.calls[2].headers["idempotency-key"], /^[\da-f-]{36}$/);
  assert.equal(logs[0].woke, true);
  assert.equal(logs[0].retries, 1);
  assert.equal(execCalls(world).length, 2);
});

test("start operation fails -> INSTABOX_START_FAILED; no exec retry", async () => {
  const world = makeWorld({ opStates: ["failed"] });
  world.execScript = [{ status: 409, code: "machine_not_running" }];
  await assert.rejects(make(world)("x"), (e) => e.code === "INSTABOX_START_FAILED" && /machine did not start/.test(e.message));
  assert.equal(execCalls(world).length, 1);
});

test("exec 409 operation_conflict -> wake (no idempotency key), operation polled, exec retried once", async () => {
  const world = makeWorld();
  world.execScript = [
    { status: 409, code: "operation_conflict" },
    { stdout: "ok", stderr: "", exitCode: 0, timedOut: false },
  ];
  const logs = [];
  const r = await make(world, { log: (e) => logs.push(e) })("x");
  assert.equal(r.stdout, "ok");
  assert.deepEqual(
    world.calls.map((c) => `${c.method} ${c.path}`),
    ["GET /v1/machines/pi-cloud-agents", "POST /v1/machines/m1/exec", "POST /v1/machines/m1/wake", "GET /v1/operations/op-1?wait=25s", "POST /v1/machines/m1/exec"],
  );
  assert.equal(world.calls[2].headers["idempotency-key"], undefined, "wake needs no idempotency key");
  assert.equal(logs[0].woke, true);
});

test("start answered 409 operation_conflict -> machine polled until running, exec retried", async () => {
  const world = makeWorld();
  world.execScript = [
    { status: 409, code: "machine_not_running" },
    { stdout: "ok", stderr: "", exitCode: 0, timedOut: false },
  ];
  world.startResponses = [{ status: 409, code: "operation_conflict" }];
  const r = await make(world)("x");
  assert.equal(r.stdout, "ok");
  assert.equal(execCalls(world).length, 2);
  // the settle poll re-reads the machine by id
  assert.equal(world.calls[3].path, "/v1/machines/m1");
});

test("command above the platform's 64 KiB cmd cap fails fast with no HTTP call", async () => {
  const world = makeWorld();
  await assert.rejects(make(world)("x".repeat(70_000)), (e) => e.code === "INSTABOX_COMMAND_TOO_LARGE" && /64 KiB/.test(e.message));
  assert.equal(world.calls.length, 0);
});

test("exec 404 machine_not_found -> id cache dropped, machine re-resolved by name, exec retried against the new id", async () => {
  const world = makeWorld();
  world.execScript = [
    { status: 404, code: "machine_not_found" },
    { stdout: "ok", stderr: "", exitCode: 0, timedOut: false },
  ];
  // after the 404 the machine exists again under a new id
  const origImpl = world.fetchImpl;
  world.fetchImpl = async (url, init) => {
    const res = await origImpl(url, init);
    if (typeof url === "string" && url.endsWith("/exec") && res.status === 404) {
      world.machine = { id: "m2", name: "pi-cloud-agents", state: "running" };
    }
    return res;
  };
  const r = await make(world)("x");
  assert.equal(r.stdout, "ok");
  assert.deepEqual(
    world.calls.map((c) => `${c.method} ${c.path}`),
    ["GET /v1/machines/pi-cloud-agents", "POST /v1/machines/m1/exec", "GET /v1/machines/pi-cloud-agents", "POST /v1/machines/m2/exec"],
  );
});

test("resolve transport failure is retried once and then succeeds", async () => {
  const world = makeWorld();
  world.machineScript.push(refused());
  const r = await make(world)("x");
  assert.equal(r.stdout, "out\n");
  assert.equal(world.calls.filter((c) => c.method === "GET" && c.path === "/v1/machines/pi-cloud-agents").length, 2);
});

test("resolve transport failure twice -> INSTABOX_CONNECT_FAILED", async () => {
  const world = makeWorld();
  world.machineScript.push(refused(), refused());
  await assert.rejects(make(world)("x"), (e) => e.code === "INSTABOX_CONNECT_FAILED" && /after 1 retry/.test(e.message));
  assert.equal(execCalls(world).length, 0);
});

test("exec transport failure that provably precedes the request (ECONNREFUSED) is retried once", async () => {
  const world = makeWorld();
  world.execErrors.push(refused());
  const r = await make(world)("x");
  assert.equal(r.stdout, "out\n");
  assert.equal(execCalls(world).length, 2);
});

test("exec transport failure after the request was sent (ECONNRESET / abort / 500) -> INSTABOX_CONNECTION_ENDED, never retried", async () => {
  for (const error of [reset(), aborted()]) {
    const world = makeWorld();
    world.execErrors.push(error);
    await assert.rejects(make(world)("git push"), (e) => e.code === "INSTABOX_CONNECTION_ENDED" && /may or may not have run/.test(e.message));
    assert.equal(execCalls(world).length, 1);
  }
  const world = makeWorld();
  world.execScript = [{ status: 500, code: "internal_error" }];
  await assert.rejects(make(world)("x"), (e) => e.code === "INSTABOX_CONNECTION_ENDED");
  assert.equal(execCalls(world).length, 1);
});

test("other exec 4xx (e.g. 400 invalid_request) is retried once, then INSTABOX_CONNECT_FAILED", async () => {
  const world = makeWorld();
  world.execScript = [{ status: 400, code: "invalid_request", message: "cmd too long" }];
  await assert.rejects(make(world)("x"), (e) => e.code === "INSTABOX_CONNECT_FAILED" && /cmd too long/.test(e.message));
  assert.equal(execCalls(world).length, 2);
});

test("response without a usable exit code (and not timedOut) -> INSTABOX_API error", async () => {
  const world = makeWorld({ execScript: [{ stdout: "", stderr: "", exitCode: null, timedOut: false }] });
  await assert.rejects(make(world)("x"), (e) => e.code === "INSTABOX_API" && /exit code/.test(e.message));
});

test("concurrent first calls share one machine lookup", async () => {
  const world = makeWorld();
  const bash = make(world);
  const rs = await Promise.all([bash("a"), bash("b"), bash("c")]);
  assert.ok(rs.every((r) => r.stdout === "out\n"));
  assert.equal(world.calls.filter((c) => c.path === "/v1/machines/pi-cloud-agents").length, 1);
});

test("envs: only opts.env reaches the per-command envs; absent when empty", async () => {
  const world = makeWorld();
  await make(world, { env: { GH_TOKEN: GH } })("gh pr list");
  assert.deepEqual(execCalls(world)[0].body.envs, { GH_TOKEN: GH });
  assert.ok(!execCalls(world)[0].body.cmd.includes(GH));
  const world2 = makeWorld();
  await make(world2)("true");
  assert.equal(execCalls(world2)[0].body.envs, undefined);
});

test("errors never contain the API key, env values or secrets (and no command text)", async () => {
  const leak = `boom ${KEY} ${GH} extra-secret-value https://api.instabox.sh/v1/machines?apiKey=${KEY}`;
  const world = makeWorld();
  world.machineScript.push(Object.assign(new Error(leak)), Object.assign(new Error(leak)));
  await assert.rejects(make(world, { env: { GH_TOKEN: GH }, secrets: ["extra-secret-value"] })('echo "secret command text"'), (e) => {
    for (const s of [KEY, GH, "extra-secret-value", "apiKey=", "secret command text"]) assert.ok(!e.message.includes(s), `${s} in: ${e.message}`);
    assert.match(e.message, /\*\*\*/);
    return true;
  });
});

test("log receives only length, duration, exit code, retries, outcome, woke, truncated — never command or output text", async () => {
  const logs = [];
  const world = makeWorld({ execScript: [{ stdout: "OUTPUT-TEXT", stderr: "", exitCode: 0, timedOut: false }] });
  await make(world, { log: (e) => logs.push(e) })("echo COMMAND-TEXT");
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ["commandLength", "exitCode", "ms", "outcome", "retries", "truncated", "woke"]);
  const s = JSON.stringify(logs);
  assert.ok(!s.includes("COMMAND-TEXT") && !s.includes("OUTPUT-TEXT"));
});

test("a throwing log function does not break the call", async () => {
  const world = makeWorld();
  const r = await make(world, { log: () => { throw new Error("log down"); } })("x");
  assert.equal(r.exitCode, 0);
});

test("factory validates arguments; missing key -> INSTABOX_CONFIG", () => {
  const fetchImpl = async () => {};
  assert.throws(() => createInstaboxBash({ fetchImpl, apiKey: KEY, name: "" }), TypeError);
  assert.throws(() => createInstaboxBash({ fetchImpl: "not-a-function", apiKey: KEY, name: "x" }), TypeError);
  assert.throws(() => createInstaboxBash({ fetchImpl }), (e) => e.code === "INSTABOX_CONFIG");
});

test("findInstaboxMachine: the machine by name, or null on 404; other errors pass through", async () => {
  const world = makeWorld();
  assert.equal((await findInstaboxMachine({ fetchImpl: world.fetchImpl, apiKey: KEY })).id, "m1");
  const world2 = makeWorld({ machine: null });
  assert.equal(await findInstaboxMachine({ fetchImpl: world2.fetchImpl, apiKey: KEY, name: "nope" }), null);
  const world3 = makeWorld();
  world3.machineScript.push(respond(401, { error: { code: "invalid_api_key", message: "bad key" } }));
  await assert.rejects(findInstaboxMachine({ fetchImpl: world3.fetchImpl, apiKey: KEY }), (e) => e.apiCode === "invalid_api_key");
});

test("waitOperation: returns the terminal operation; times out with INSTABOX_OPERATION_TIMEOUT", async () => {
  const world = makeWorld({ opStates: ["succeeded"] });
  const client = instaboxApi({ fetchImpl: world.fetchImpl, apiKey: KEY });
  const done = await client.waitOperation({ operationId: "op-9", operation: { state: "running" } }, { timeoutMs: 5_000 });
  assert.equal(done.state, "succeeded");
  assert.equal(done.machine.id, "m1");
  const world2 = makeWorld({ opStates: Array(50).fill("running") });
  const client2 = instaboxApi({ fetchImpl: world2.fetchImpl, apiKey: KEY });
  await assert.rejects(client2.waitOperation({ operationId: "op-1" }, { timeoutMs: 20, pollHttpMs: 5 }), (e) => e.code === "INSTABOX_OPERATION_TIMEOUT");
});

test("waitOperation rejects a response without an operation id", async () => {
  await assert.rejects(waitOperation({ call: async () => ({}) }, {}), (e) => e.code === "INSTABOX_API");
});

test("production instance: missing INSTABOX_API_KEY -> INSTABOX_CONFIG without leaking values", async () => {
  const saved = process.env.INSTABOX_API_KEY;
  try {
    delete process.env.INSTABOX_API_KEY;
    await assert.rejects(instaboxBash("true"), (e) => e.code === "INSTABOX_CONFIG" && /INSTABOX_API_KEY/.test(e.message));
  } finally {
    if (saved === undefined) delete process.env.INSTABOX_API_KEY;
    else process.env.INSTABOX_API_KEY = saved;
  }
});

test("getInstaboxInfo has sandbox and name only; name defaults to pi-cloud-agents", () => {
  const prev = process.env.TARSBOT_INSTABOX_NAME;
  try {
    delete process.env.TARSBOT_INSTABOX_NAME;
    assert.deepEqual(getInstaboxInfo(), { sandbox: "instabox", name: "pi-cloud-agents" });
    process.env.TARSBOT_INSTABOX_NAME = "other";
    assert.deepEqual(getInstaboxInfo(), { sandbox: "instabox", name: "other" });
  } finally {
    if (prev === undefined) delete process.env.TARSBOT_INSTABOX_NAME;
    else process.env.TARSBOT_INSTABOX_NAME = prev;
  }
});
