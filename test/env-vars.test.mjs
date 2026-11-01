// ENV-DEMO offline tests. Covers (no network, no Sprite, no .env):
//   - store/service: workspace defaults inherit / session set / disabled / empty-string value / restore-inherit /
//     cross-workspace refuse / reserved names / AES-GCM at rest (ciphertext only in sqlite) / masked API (no
//     plaintext anywhere) / reopen persistence / missing master key disables cleanly / loop+readOnly restriction.
//   - exec path: the resolver's effective env reaches runner.start via prepare-names + start-env (per-call env
//     only — argv/staged files/durable memo never see a value).
//   - console path: attachTerminal stages the SAME effective env (a command prints it back).
//   - PTY path: provider.pty passes sessionEnv as the first stdin bytes on a fixed bootstrap argv — the value is
//     NEVER in spawn argv / options.env (the exec URL query).
//   - auth: every route sits behind the global guard (401 without a session).
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { createEnvConfigService, EnvConfigError } from "../src/env-config.mjs";
import { register as registerEnvRoutes } from "../src/routes/env-vars.mjs";
import { register as registerAuth } from "../src/routes/auth.mjs";
import { register as registerTerminal } from "../src/routes/terminal.mjs";
import { createSpritesProvider } from "../src/providers/sprites.mjs";
import { createRunnerClient } from "../src/runner/client.mjs";
import { attachTerminal } from "../src/terminal-env.mjs";

const MODEL = { provider: "faux", modelId: "faux-1" };
const KEY = "test-master-key-0123456789abcdef";
const SECRET = "s3cr3t!V@lue-with punctuation 'quotes' $dollar `tick`";

function world({ key = KEY } = {}) {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "req-1",
    projectId: project.id,
    name: "w1",
    baseBranch: "main",
    branch: "b1",
    cwd: "/home/sprite/workspace/app",
    model: MODEL,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-aaaaaaaaaa" });
  const svc = createEnvConfigService({ store, ...(key === null ? { env: {} } : { masterKey: key }) });
  const bots = {
    map: {},
    get(id) {
      return this.map[id] ?? this.map[Object.keys(this.map).find((k) => this.map[k].name === id)];
    },
    list() {
      return Object.values(this.map);
    },
  };
  const seed = (over = {}) => {
    const bot = { id: `b${Object.keys(bots.map).length + 1}`, name: `b${Object.keys(bots.map).length + 1}`, conversationId: `conv-${Object.keys(bots.map).length + 1}`, model: MODEL, createdAt: new Date().toISOString(), ...over };
    bots.map[bot.id] = bot;
    if (bot.workspaceId !== null) store.links.link({ conversationId: String(bot.conversationId), workspaceId: over.workspaceId ?? workspace.id, botId: bot.id });
    return bot;
  };
  return { store, workspace, svc, bots, seed };
}

test("disabled session-only and deleted defaults remain explicit unsets; scope budget is atomic", () => {
  const { store, workspace, svc, seed } = world();
  try {
    const bot = seed();
    svc.setSessionVar({ workspaceId: workspace.id, bot, name: "ONLY_SESSION", mode: "disabled" });
    svc.setWorkspaceVar(workspace.id, "DELETED_DEFAULT", "old");
    svc.setSessionVar({ workspaceId: workspace.id, bot, name: "DELETED_DEFAULT", mode: "disabled" });
    svc.removeWorkspaceVar(workspace.id, "DELETED_DEFAULT");
    assert.deepEqual(svc.effectiveEnv({ workspaceId: workspace.id, conversationId: bot.conversationId }).unset.sort(), ["DELETED_DEFAULT", "ONLY_SESSION"]);
    for (let i = 0; i < 3; i++) svc.setWorkspaceVar(workspace.id, "PAD_" + i, "'".repeat(8192));
    assert.throws(() => svc.setWorkspaceVar(workspace.id, "PAD_3", "'".repeat(8192)), /32 KiB/);
    assert.equal(svc.listWorkspace(workspace.id).vars.length, 3);
  } finally { store.close(); }
});

// ---- service semantics -----------------------------------------------------------------------------------------------

test("env service: workspace default + session set/disabled/inherit + empty string is a real value", () => {
  const { workspace, svc, seed } = world();
  svc.setWorkspaceVar(workspace.id, "API_URL", "https://api.example.com");
  svc.setWorkspaceVar(workspace.id, "FLAG", "");
  const bot = seed();

  assert.deepEqual(svc.effectiveEnv({ workspaceId: workspace.id, conversationId: bot.conversationId }), {
    set: { API_URL: "https://api.example.com", FLAG: "" },
    unset: [],
  });

  // override one, leave the other inherited
  svc.setSessionVar({ workspaceId: workspace.id, bot, name: "API_URL", mode: "set", value: "https://staging.example.com" });
  assert.deepEqual(svc.effectiveEnv({ workspaceId: workspace.id, conversationId: bot.conversationId }), {
    set: { API_URL: "https://staging.example.com", FLAG: "" },
    unset: [],
  });

  // disabled = a real UNSET (not skipped, not empty string): the name lands in `unset`, out of `set`
  svc.setSessionVar({ workspaceId: workspace.id, bot, name: "FLAG", mode: "disabled" });
  const eff = svc.effectiveEnv({ workspaceId: workspace.id, conversationId: bot.conversationId });
  assert.deepEqual(eff.set, { API_URL: "https://staging.example.com" });
  assert.deepEqual(eff.unset, ["FLAG"]);

  // restoring inherit brings the default back verbatim (including the empty string)
  svc.setSessionVar({ workspaceId: workspace.id, bot, name: "FLAG", mode: "inherit" });
  assert.deepEqual(svc.effectiveEnv({ workspaceId: workspace.id, conversationId: bot.conversationId }), {
    set: { API_URL: "https://staging.example.com", FLAG: "" },
    unset: [],
  });

  // a session override does NOT leak into a second session of the same workspace
  const other = seed();
  assert.deepEqual(svc.effectiveEnv({ workspaceId: workspace.id, conversationId: other.conversationId }), {
    set: { API_URL: "https://api.example.com", FLAG: "" },
    unset: [],
  });
});

test("env service: session override survives only its own conversation (fork/delegation child inherits defaults)", () => {
  const { workspace, svc, seed } = world();
  svc.setWorkspaceVar(workspace.id, "TOKEN_X", "ws-default");
  const parent = seed();
  svc.setSessionVar({ workspaceId: workspace.id, bot: parent, name: "TOKEN_X", mode: "set", value: "parent-secret" });
  const fork = seed({ parent: { botId: parent.id } }); // new conversation id
  assert.equal(svc.effectiveEnv({ workspaceId: workspace.id, conversationId: fork.conversationId }).set.TOKEN_X, "ws-default");
});

test("env service: reserved names rejected (control env / credentials / loader hooks)", () => {
  const { workspace, svc } = world();
  for (const name of ["PATH", "HOME", "SHELL", "BASH_ENV", "ENV", "NODE_OPTIONS", "GH_TOKEN", "GITHUB_TOKEN", "SPRITES_TOKEN", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PCA_HOME", "TARSBOT_MODEL", "GIT_SSH_COMMAND", "TOKEN_ROUTER_API_KEY", "EXA_API_KEY"]) {
    assert.throws(() => svc.setWorkspaceVar(workspace.id, name, "x"), (e) => e instanceof EnvConfigError && e.code === "invalid", name);
  }
  // legitimately named user vars pass
  svc.setWorkspaceVar(workspace.id, "MY_API_KEY", "k");
  svc.setWorkspaceVar(workspace.id, "FEATURE_FLAG", "on");
});

test("env service: names validated on session writes too; bad value types refused", () => {
  const { workspace, svc, seed } = world();
  const bot = seed();
  assert.throws(() => svc.setSessionVar({ workspaceId: workspace.id, bot, name: "PATH", mode: "set", value: "x" }), EnvConfigError);
  assert.throws(() => svc.setSessionVar({ workspaceId: workspace.id, bot, name: "9BAD", mode: "set", value: "x" }), EnvConfigError);
  assert.throws(() => svc.setSessionVar({ workspaceId: workspace.id, bot, name: "OK", mode: "set", value: 42 }), EnvConfigError);
});

test("env service: cross-workspace botId refused on session writes", () => {
  const { store, workspace, svc, seed } = world();
  const p2 = store.projects.upsert({ repo: "acme/other", defaultBranch: "main" });
  const { workspace: ws2 } = store.workspaces.create({ requestId: "req-2", projectId: p2.id, name: "w2", baseBranch: "main", branch: "b2", cwd: "/x", model: MODEL });
  const bot = seed(); // linked to workspace.id
  assert.throws(() => svc.setSessionVar({ workspaceId: ws2.id, bot, name: "A", mode: "set", value: "v" }), (e) => e.code === "conflict");
});

test("env service: restricted sessions cannot write overrides and get no user vars", () => {
  const { workspace, svc, seed } = world();
  svc.setWorkspaceVar(workspace.id, "A", "v");
  const ro = seed({ readOnly: true });
  const loop = seed({ loopRun: { runId: "run_x", loopId: "loop_x" } });
  assert.equal(svc.isRestricted(ro), true);
  assert.equal(svc.isRestricted(loop), true);
  assert.throws(() => svc.setSessionVar({ workspaceId: workspace.id, bot: ro, name: "A", mode: "set", value: "y" }), (e) => e.code === "conflict");
  assert.throws(() => svc.setSessionVar({ workspaceId: workspace.id, bot: loop, name: "A", mode: "disabled" }), (e) => e.code === "conflict");
});

test("env storage: values are ciphertext in the control db; masked API never returns plaintext", () => {
  const { store, workspace, svc, seed } = world();
  svc.setWorkspaceVar(workspace.id, "API_URL", SECRET);
  const bot = seed();
  svc.setSessionVar({ workspaceId: workspace.id, bot, name: "SESS", mode: "set", value: SECRET });

  const raw = store.envVars.get(workspace.id, "API_URL").value;
  assert.match(raw, /^v1:/);
  assert.ok(!raw.includes(SECRET), "stored blob must not contain plaintext");
  // the ciphertext round-trips through the masked service (no _decrypt test hook needed)
  assert.equal(svc.effectiveEnv({ workspaceId: workspace.id }).set.API_URL, SECRET);
  const sess = store.sessionEnv.list(String(bot.conversationId)).find((r) => r.name === "SESS");
  assert.match(sess.value, /^v1:/);
  assert.ok(!sess.value.includes(SECRET));

  for (const payload of [svc.listWorkspace(workspace.id), svc.listSession({ workspaceId: workspace.id, bot })]) {
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(SECRET), `masked payload leaks the value: ${text}`);
  }
});

test("env storage: reopens with the same key read values back; wrong key fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "pca-env-"));
  try {
    const path = join(dir, "control.sqlite");
    const s1 = openControlStore({ path });
    const p = s1.projects.upsert({ repo: "a/b", defaultBranch: "main" });
    const { workspace } = s1.workspaces.create({ requestId: "r", projectId: p.id, name: "w", baseBranch: "main", branch: "b", cwd: "/x", model: MODEL });
    const svc1 = createEnvConfigService({ store: s1, masterKey: KEY });
    svc1.setWorkspaceVar(workspace.id, "API_URL", SECRET);
    s1.close();

    const s2 = openControlStore({ path });
    const svc2 = createEnvConfigService({ store: s2, masterKey: KEY });
    assert.equal(svc2.effectiveEnv({ workspaceId: workspace.id }).set.API_URL, SECRET);
    const svc3 = createEnvConfigService({ store: s2, masterKey: "different-key-000000000000" });
    assert.throws(() => svc3.effectiveEnv({ workspaceId: workspace.id }), EnvConfigError);
    s2.close();
    // and the db file itself never holds plaintext
    assert.ok(!readFileSync(path).includes(Buffer.from(SECRET)), "sqlite file must not contain plaintext");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env service: missing master key disables writes, keeps effectiveEnv empty (no plaintext fallback)", () => {
  const { workspace, svc, seed } = world({ key: null });
  assert.equal(svc.enabled, false);
  assert.throws(() => svc.setWorkspaceVar(workspace.id, "A", "v"), (e) => e.code === "disabled" && /TARSBOT_ENV_KEY/.test(e.message));
  // No stored config -> an empty effective env (nothing regresses on a keyless server)
  assert.deepEqual(svc.effectiveEnv({ workspaceId: workspace.id, conversationId: seed().conversationId }), { set: {}, unset: [] });
  // lists still answer (masked state reported, feature flagged off)
  assert.equal(svc.listWorkspace(workspace.id).enabled, false);
  // a short key is treated as missing too
  const weak = createEnvConfigService({ store: openControlStore({ path: null }), masterKey: "short" });
  assert.equal(weak.enabled, false);
});

test("env service: stored config + missing key -> effectiveEnv throws 'disabled' (never silently {})", () => {
  // Encrypt a var WITH a key, then resolve WITHOUT it: the stored config makes the session config-dependent,
  // so a missing key must REFUSE rather than run commands half-configured.
  const store = openControlStore({ path: null });
  const p = store.projects.upsert({ repo: "a/b", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({ requestId: "r", projectId: p.id, name: "w", baseBranch: "main", branch: "b", cwd: "/x", model: MODEL });
  const keyed = createEnvConfigService({ store, masterKey: KEY });
  keyed.setWorkspaceVar(workspace.id, "API_URL", "v");
  const keyless = createEnvConfigService({ store, env: {} }); // enabled=false, same store
  assert.throws(
    () => keyless.effectiveEnv({ workspaceId: workspace.id }),
    (e) => e instanceof EnvConfigError && e.code === "disabled",
  );
});

// ---- routes (masked API + auth guard) -------------------------------------------------------------------------------

async function apiWorld({ key = KEY, withAuth = false } = {}) {
  const { store, workspace, svc, bots, seed } = world({ key });
  const bot = seed();
  const api = createApi({
    harness: {},
    bots,
    routes: [
      (a) => Object.assign(a.ctx, { workspaces: { get: (id) => store.workspaces.get(id), list: () => store.workspaces.list() }, control: store, bots, envService: svc }),
      registerEnvRoutes,
      ...(withAuth ? [(a) => registerAuth(a, { env: { TARSBOT_AUTH_DISABLED: "", TARSBOT_ALLOWED_EMAILS: "u@x", TARSBOT_HOST: "127.0.0.1", TARSBOT_PUBLIC_URL: "http://127.0.0.1:8090" } })] : []),
    ],
  });
  const { port } = await api.listen(0);
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const post = async (p, body) => {
    const r = await fetch(url(p), { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8090" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const get = async (p) => ({ status: (await fetch(url(p))).status, body: await (await fetch(url(p))).json() });
  return { store, workspace, svc, bots, bot, api, post, get, close: () => api.close() };
}

test("env routes: masked set/list/remove for workspace + session; no plaintext anywhere", async () => {
  const w = await apiWorld();
  try {
    let r = await w.post(`/api/workspaces/${w.workspace.id}/env/API_URL`, { value: SECRET });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ["name", "masked", "updatedAt"]);
    assert.ok(!JSON.stringify(r.body).includes(SECRET));

    r = await w.get(`/api/workspaces/${w.workspace.id}/env`);
    assert.deepEqual(r.body.vars, [{ name: "API_URL", masked: true, updatedAt: r.body.vars[0].updatedAt }]);
    assert.ok(!JSON.stringify(r.body).includes(SECRET));

    // session: set / disabled / inherit over the bot's own linked workspace
    r = await w.post(`/api/bots/${w.bot.id}/env/API_URL`, { mode: "set", value: "session-v" });
    assert.deepEqual(r.body, { name: "API_URL", mode: "set", masked: true });
    r = await w.get(`/api/bots/${w.bot.id}/env`);
    const row = r.body.entries.find((e) => e.name === "API_URL");
    assert.equal(row.mode, "set");
    r = await w.post(`/api/bots/${w.bot.id}/env/API_URL`, { mode: "disabled" });
    assert.equal(r.body.mode, "disabled");
    r = await w.post(`/api/bots/${w.bot.id}/env/API_URL`, { mode: "inherit" });
    assert.equal(r.body.mode, "inherit");
    r = await w.get(`/api/bots/${w.bot.id}/env`);
    assert.equal(r.body.entries.find((e) => e.name === "API_URL").mode, "inherit");

    // remove a workspace var
    r = await w.post(`/api/workspaces/${w.workspace.id}/env/API_URL/remove`, {});
    assert.deepEqual(r.body, { removed: true });
    r = await w.post(`/api/workspaces/${w.workspace.id}/env/API_URL/remove`, {});
    assert.equal(r.status, 404);

    // reserved name -> 400 with a clear reason, no value echoed
    r = await w.post(`/api/workspaces/${w.workspace.id}/env/PATH`, { value: "/evil" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /保留名/);
    // another workspace id + this bot -> conflict or not-found, never a write into ws2
    r = await w.post(`/api/bots/${w.bot.id}/env/BAD%20NAME`, { mode: "set", value: "x" });
    assert.equal(r.status, 400);
  } finally {
    await w.close();
  }
});

test("env routes: without a session cookie the guard refuses (401)", async () => {
  const w = await apiWorld({ withAuth: true });
  try {
    const r = await w.get(`/api/workspaces/${w.workspace.id}/env`);
    assert.equal(r.status, 401);
    const p = await w.post(`/api/bots/${w.bot.id}/env/A`, { mode: "set", value: "x" });
    assert.equal(p.status, 401);
  } finally {
    await w.close();
  }
});

test("env routes: disabled feature -> writes 503, lists still answer", async () => {
  const w = await apiWorld({ key: null });
  try {
    const r = await w.post(`/api/workspaces/${w.workspace.id}/env/A`, { value: "v" });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /TARSBOT_ENV_KEY/);
    const l = await w.get(`/api/workspaces/${w.workspace.id}/env`);
    assert.equal(l.status, 200);
    assert.equal(l.body.enabled, false);
  } finally {
    await w.close();
  }
});

// ---- exec path: effective env reaches runner.start as per-call env ----------------------------------------------------

test("exec: session effective env is staged as names and injected at start; values never in argv/files/memo", async () => {
  const { store, workspace, svc, seed } = world();
  svc.setWorkspaceVar(workspace.id, "DEPLOY_ENV", SECRET);
  svc.setWorkspaceVar(workspace.id, "PLAIN", "yes");
  const bot = seed();
  svc.setSessionVar({ workspaceId: workspace.id, bot, name: "PLAIN", mode: "disabled" });

  // The exact resolver branch from server.mjs, exercised directly.
  const eff = svc.isRestricted(bot)
    ? { set: { GH_TOKEN: "" }, unset: [] }
    : svc.effectiveEnv({ workspaceId: workspace.id, conversationId: String(bot.conversationId) });
  assert.deepEqual(eff.set, { DEPLOY_ENV: SECRET });
  assert.deepEqual(eff.unset, ["PLAIN"]);

  // A recording bash primitive: captures every command text + per-call env like createSpritesBash would send.
  const calls = [];
  const bash = async (command, o = {}) => {
    calls.push({ command, env: o.env });
    if (/runner\.sh' prepare /.test(command)) return { stdout: "prepared=new\nstate=claimed\nsize=0\nlaunched=0\n", stderr: "", exitCode: 0 };
    if (/runner\.sh' start /.test(command)) return { stdout: "started=new\nstate=running\nsize=0\nlaunched=1\n", stderr: "", exitCode: 0 };
    if (/runner\.sh' wait /.test(command)) return { stdout: "state=exited\nexit=0\noffset=0\nsize=0\nencoding=base64\n--data--\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  bash.supportsEnv = true;
  const runner = createRunnerClient({ bash, home: "~/.pca-test", runnerSource: false });

  await runner.prepare({ id: "run-1", cwd: "/w", command: "echo hi", env: eff.set, unset: eff.unset });
  await runner.start("run-1");

  const whole = calls.map((c) => c.command).join("\n");
  assert.ok(!whole.includes(SECRET), `a command line carried the value: ${whole.slice(0, 400)}`);
  // NAMES only are staged: both the set names AND the disabled (unset) names — values never reach a file
  const namesFile = calls.find((c) => /'env\.part\./.test(c.command));
  assert.ok(namesFile, "env names were staged");
  // The start call carries every set value PLUS the disabled names and the PCA_ENV_UNSET transport list;
  // the runner wrapper then unsets them — a disabled var is a real unset, never the empty string.
  const startCall = calls.find((c) => /runner\.sh' start /.test(c.command));
  assert.equal(startCall.env.DEPLOY_ENV, SECRET);
  assert.equal(startCall.env.PLAIN, "", "disabled name arrives stripped, runner unsets it in the wrapper");
  assert.equal(startCall.env.PCA_ENV_UNSET, "PLAIN");
  // prepare itself carries no env
  const prepareCall = calls.find((c) => /runner\.sh' prepare /.test(c.command));
  assert.equal(prepareCall.env, undefined);
});

test("exec: supportsEnv-less primitive refuses env (no fallback to files)", async () => {
  const bash = async () => ({ stdout: "", stderr: "", exitCode: 0 });
  const runner = createRunnerClient({ bash, home: "~/.pca-test", runnerSource: false });
  await assert.rejects(
    () => runner.prepare({ id: "r2", cwd: "/w", command: "echo hi", env: { A: "b" } }),
    (e) => e.code === "RUNNER_ENV_UNSUPPORTED",
  );
});

// ---- console path: attachTerminal injects the same effective env --------------------------------------------------------

test("console: run stages the session's effective env through the runner", async () => {
  const { store, workspace, svc, seed } = world();
  svc.setWorkspaceVar(workspace.id, "DEPLOY_ENV", SECRET);
  const bot = seed();

  const prepared = [];
  const started = [];
  const runner = {
    async install() {},
    async prepare({ id, cwd, command, env, unset }) {
      prepared.push({ id, cwd, command, env, unset });
      return { prepared: "new" };
    },
    async start(id) {
      started.push(id);
      return { started: "new" };
    },
    async wait() {
      return { state: "exited", exit: 0, offset: 0, size: 0, text: "", done: true };
    },
    async kill() {
      return { killed: "confirmed" };
    },
  };

  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.OPEN = 1;
  socket.bufferedAmount = 0;
  const frames = [];
  socket.send = (f) => frames.push(JSON.parse(f));
  socket.close = () => {};
  socket.on("message", () => {});

  const app = {
    ctx: {
      bots: { get: (id) => (id === bot.id ? bot : undefined) },
      control: store,
      runtimeBash: async () => async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      envService: svc,
    },
  };
  // The route is bypassed (it needs a real ws); drive attachTerminal's message handler directly.
  await attachTerminal(app, socket, bot.id, { runner });
  const ready = frames.find((f) => f.type === "ready");
  assert.ok(ready);
  socket.emit("message", JSON.stringify({ type: "run", id: "r1", command: "echo $DEPLOY_ENV" }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(prepared.length, 1);
  assert.deepEqual(prepared[0].env, { DEPLOY_ENV: SECRET });
});

test("console: restricted session refused before any env resolution", async () => {
  const { store, workspace, svc, seed } = world();
  const bot = seed({ loopRun: { runId: "run_x" } });
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.OPEN = 1;
  socket.bufferedAmount = 0;
  const frames = [];
  socket.send = (f) => frames.push(JSON.parse(f));
  let closed = 0;
  socket.close = () => closed++;
  const app = { ctx: { bots: { get: () => bot }, control: store, envService: svc } };
  await attachTerminal(app, socket, bot.id, {});
  assert.equal(closed, 1);
  assert.match(frames[0].message, /disabled for restricted/);
});

test("PTY client deadline kills/closes stalled bootstrap without sending secrets", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = new EventEmitter();
  c.stdin = new PassThrough(); c.stdout = new PassThrough();
  let killed = 0, closed = 0;
  c.kill = () => killed++; c.close = () => closed++;
  const client = { getSprite() {}, sprite: () => ({ spawn: () => c }) };
  const pending = createSpritesProvider({ client }).pty("pca-test")({ cwd: "/tmp", sessionEnv: { SECRET: "fictional-value" } });
  const rejected = assert.rejects(pending, /timed out/);
  c.emit("spawn");
  assert.equal(c.stdin.read().toString(), "PCA_ENV_1\n");
  t.mock.timers.tick(90_001);
  await rejected;
  assert.equal(killed, 1); assert.equal(closed, 1);
});

test("bash and PTY redact per-call secrets without retaining another session's values", async () => {
  const a = "session-A-fictional", b = "session-B-fictional";
  const client = { getSprite() {}, sprite: () => ({ spawn() { throw new Error(a + " " + b); } }) };
  const p = createSpritesProvider({ client });
  const { createSpritesBash } = await import("../src/sandbox/sprites.mjs");
  const bash = createSpritesBash({ client, name: "pca-test", retryDelayMs: 0 });
  for (const run of [
    (value) => bash("true", { env: { SECRET: value } }),
    (value) => p.pty("pca-test")({ cwd: "/tmp", sessionEnv: { SECRET: value } }),
  ]) {
    const results = await Promise.allSettled([run(a), run(b)]);
    assert.equal(results[0].status, "rejected");
    assert.ok(!results[0].reason.message.includes(a));
    assert.ok(results[0].reason.message.includes(b), "other call's value was not retained");
    assert.ok(!results[1].reason.message.includes(b));
    assert.ok(results[1].reason.message.includes(a));
  }
});

// ---- PTY path: sessionEnv as stdin bootstrap, never in argv/options.env --------------------------------------------------

test("provider.pty: sessionEnv goes via probe+ACK handshake on stdin; argv/env carry no secret; disabled vars unset", async () => {
  const spawnCalls = [];
  const client = {
    async getSprite() {
      return { name: "pca-aaaaaaaaaa", labels: [] };
    },
    sprite(name) {
      return {
        spawn: (cmd, args, o) => {
          const c = new EventEmitter();
          c.stdin = new PassThrough();
          c.stdout = new PassThrough();
          c.stderr = new PassThrough();
          c.stdinBuf = [];
          c.stdin.on("data", (b) => c.stdinBuf.push(Buffer.from(b)));
          c.resize = () => {};
          c.signal = () => {};
          c.kill = () => {};
          c.close = () => {};
          setImmediate(() => c.emit("spawn"));
          spawnCalls.push({ name, cmd, args, o, handle: c });
          return c;
        },
      };
    },
  };
  const p = createSpritesProvider({ client, ghToken: "ghp_secret", gitEmail: "b@x", legacyNames: [] });
  const factory = p.pty("pca-aaaaaaaaaa");
  const sessionEnv = { DEPLOY_ENV: SECRET, EMPTY_ONE: "" };
  const sessionUnset = ["INHERITED_VAR"];
  let resolved = false;
  const opening = factory({ cwd: "/home/sprite/x", cols: 80, rows: 24, env: { TERM: "xterm", SECRET: "dropped" }, sessionEnv, sessionUnset }).then((s) => { resolved = true; return s; });
  await new Promise(setImmediate);
  const call = spawnCalls[0];

  // Nothing sensitive in argv or the exec env (those become URL query params in the SDK).
  const argvText = `${call.cmd} ${call.args.join(" ")}`;
  assert.ok(!argvText.includes(SECRET), `secret in argv: ${argvText}`);
  assert.equal(call.cmd, "/bin/bash", "pty bootstrap needs bash for `read -n` / `read -t`");
  assert.deepEqual(call.o.env, { TERM: "xterm" }, "options.env stays the display allowlist");
  assert.match(argvText, /stty -echo -icanon/, "bootstrap disables echo + canonical BEFORE reading");
  assert.match(argvText, /read -r -t 30/, "probe read has a deadline");
  assert.match(argvText, /PCA_READY_1/, "bootstrap ACKs before the payload is sent");
  assert.match(argvText, /base64 -d/, "bootstrap decodes the payload");

  // The handshake: probe first, then (after the fake emits the ACK on stdout) the payload line.
  const probe = Buffer.concat(call.handle.stdinBuf).toString();
  assert.equal(probe, "PCA_ENV_1\n", "only the probe is written before the ACK");
  assert.equal(resolved, false, "no handle/user input before applied ACK");
  call.handle.stdout.emit("data", Buffer.from("PCA_RE"));
  call.handle.stdout.emit("data", Buffer.from("ADY_1"));
  await new Promise((r) => setTimeout(r, 10));
  const all = Buffer.concat(call.handle.stdinBuf).toString();
  const payloadLine = all.split("\n")[1];
  assert.match(payloadLine, /^[A-Za-z0-9+/=]+$/);
  const decoded = Buffer.from(payloadLine, "base64").toString("utf8");
  const expected = `export DEPLOY_ENV='${SECRET.replaceAll("'", "'\\''")}'`;
  assert.ok(decoded.includes(expected), `decoded payload lacks the export line: ${decoded}`);
  assert.match(decoded, /export EMPTY_ONE=''/);
  assert.match(decoded, /unset INHERITED_VAR/, "disabled vars are unset in the pty shell too");
  assert.equal(resolved, false, "payload sent is not proof of application");
  call.handle.stdout.emit("data", Buffer.from("PCA_APPL"));
  call.handle.stdout.emit("data", Buffer.from("IED_1hello"));
  const shell = await opening;
  assert.equal(shell.stdout.read().toString(), "hello", "markers do not reach UI");
  shell.write("user-keystroke\n");
  assert.ok(Buffer.concat(call.handle.stdinBuf).toString().endsWith("user-keystroke\n"));
});

test("provider.pty: no sessionEnv keeps the plain login-shell spawn", async () => {
  const spawnCalls = [];
  const client = {
    async getSprite() {
      return { name: "pca-aaaaaaaaaa", labels: [] };
    },
    sprite: () => ({
      spawn: (cmd, args, o) => {
        const c = new EventEmitter();
        c.stdin = new PassThrough();
        c.stdout = new PassThrough();
        c.stderr = new PassThrough();
        c.resize = () => {};
        c.signal = () => {};
        c.kill = () => {};
        c.close = () => {};
        setImmediate(() => c.emit("spawn"));
        spawnCalls.push({ cmd, args, o, handle: c });
        return c;
      },
    }),
  };
  const p = createSpritesProvider({ client, legacyNames: [] });
  const shell = await p.pty("pca-aaaaaaaaaa")({ cwd: "/home/sprite/x", cols: 80, rows: 24 });
  assert.equal(spawnCalls[0].cmd, "/bin/bash");
  assert.deepEqual(spawnCalls[0].args, ["-c", 'exec "${SHELL:-/bin/bash}" -il']);
  assert.equal(spawnCalls[0].o.env, undefined);
  // nothing was written to stdin
  const chunks = [];
  spawnCalls[0].handle.stdin.on("data", (b) => chunks.push(b));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(chunks.length, 0);
  assert.ok(shell);
});
