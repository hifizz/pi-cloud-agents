import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createApi } from "../src/api.mjs";
import { register } from "../src/routes/auth.mjs";
import { authSettings, openAuthStore } from "../src/auth.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery";
const ORIGIN = "http://127.0.0.1:8090";

async function setup({ env = {}, fetch: fakeFetch, withPassword = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pca-auth-"));
  const staticDir = join(dir, "static");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<html>shell</html>");
  let clock = Date.now();
  const now = () => clock;
  const fullEnv = { TARSBOT_ALLOWED_EMAILS: ` ${EMAIL.toUpperCase()}, other@example.com ,`, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", ...env };
  if (withPassword) {
    const s = openAuthStore({ dataDir: dir });
    await s.setPassword(EMAIL, PASSWORD);
    s.close();
  }
  const bots = { list: () => [], get: () => undefined, conversation: async () => undefined };
  const api = createApi({
    harness: {},
    bots,
    staticDir,
    routes: [(app) => register(app, { env: fullEnv, dataDir: dir, now, fetch: fakeFetch })],
  });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    base,
    advance: (ms) => (clock += ms),
    async close() {
      await api.close();
      rmSync(dir, { recursive: true, force: true });
    },
    async req(method, path, { body, cookie, origin = ORIGIN, headers = {} } = {}) {
      const h = { ...headers };
      if (body !== undefined) h["content-type"] = "application/json";
      if (cookie) h.cookie = cookie;
      if (origin) h.origin = origin;
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        // not json
      }
      return { status: res.status, json, text, headers: res.headers };
    },
    async login(extra = {}) {
      const r = await this.req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD }, ...extra });
      assert.equal(r.status, 200, r.text);
      return r.headers.get("set-cookie").split(";")[0];
    },
  };
}

test("unauthenticated: /api/bots 401, /api/health 200, static unaffected", async () => {
  const t = await setup();
  try {
    assert.equal((await t.req("GET", "/api/bots")).status, 401);
    assert.equal((await t.req("GET", "/api/health")).status, 200);
    assert.equal((await t.req("GET", "/api/auth/me")).status, 401);
    const root = await t.req("GET", "/");
    assert.equal(root.status, 200);
    assert.match(root.text, /shell/);
  } finally {
    await t.close();
  }
});

test("password login sets a hardened cookie and unlocks the API", async () => {
  const t = await setup();
  try {
    const r = await t.req("POST", "/api/auth/login", { body: { email: EMAIL.toUpperCase(), password: PASSWORD } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { email: EMAIL });
    const sc = r.headers.get("set-cookie");
    assert.match(sc, /^pca_session=[A-Za-z0-9_-]{43};/);
    for (const part of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"]) assert.ok(sc.includes(part), sc);
    assert.ok(!sc.includes("Secure"));
    const cookie = sc.split(";")[0];
    assert.deepEqual((await t.req("GET", "/api/auth/me", { cookie })).json, { email: EMAIL });
    assert.equal((await t.req("GET", "/api/bots", { cookie })).status, 200);
  } finally {
    await t.close();
  }
});

test("Secure flag with https public url or x-forwarded-proto", async () => {
  const t = await setup({ env: { TARSBOT_PUBLIC_URL: "https://pi.example.com" } });
  try {
    const r = await t.req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD }, origin: "https://pi.example.com" });
    assert.ok(r.headers.get("set-cookie").includes("; Secure"));
    // dev origins are not accepted once a non-loopback public url is set
    const bad = await t.req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD }, origin: ORIGIN });
    assert.equal(bad.status, 403);
  } finally {
    await t.close();
  }
  const t2 = await setup();
  try {
    const r = await t2.req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD }, headers: { "x-forwarded-proto": "https" } });
    assert.ok(r.headers.get("set-cookie").includes("; Secure"));
  } finally {
    await t2.close();
  }
});

test("bad password / non-allowlisted email share one 401 message; repeated failures -> 429", async () => {
  const t = await setup();
  try {
    const wrong = await t.req("POST", "/api/auth/login", { body: { email: EMAIL, password: "nope-nope-nope" } });
    const outsider = await t.req("POST", "/api/auth/login", { body: { email: "evil@example.com", password: PASSWORD } });
    assert.equal(wrong.status, 401);
    assert.equal(outsider.status, 401);
    assert.deepEqual(wrong.json, { error: "invalid email or password" });
    assert.deepEqual(outsider.json, wrong.json);
    for (let i = 0; i < 4; i++) assert.equal((await t.req("POST", "/api/auth/login", { body: { email: EMAIL, password: "bad" } })).status, 401);
    // 5 failures recorded for this email+ip: even the right password is now throttled
    assert.equal((await t.req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } })).status, 429);
    t.advance(16 * 60 * 1000);
    assert.equal((await t.req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } })).status, 200);
  } finally {
    await t.close();
  }
});

test("non-GET requests need a matching Origin", async () => {
  const t = await setup();
  try {
    const cookie = await t.login();
    assert.equal((await t.req("POST", "/api/auth/logout", { cookie, origin: "https://evil.example" })).status, 403);
    assert.equal((await t.req("POST", "/api/auth/logout", { cookie, origin: null })).status, 403);
    assert.equal((await t.req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD }, origin: null })).status, 403);
    // GET without Origin is fine
    assert.equal((await t.req("GET", "/api/bots", { cookie, origin: null })).status, 200);
    assert.equal((await t.req("POST", "/api/auth/logout", { cookie })).status, 200);
  } finally {
    await t.close();
  }
});

function wsStatus(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("error", () => {});
  });
}

test("WebSocket upgrade: 401 without cookie, OK with cookie, 401 with bad origin", async () => {
  const t = await setup();
  try {
    const url = `ws://127.0.0.1:${t.port}/api/bots/nobody/stream`;
    assert.equal(await wsStatus(url, { origin: ORIGIN }), 401);
    const cookie = await t.login();
    assert.equal(await wsStatus(url, { origin: ORIGIN, cookie }), "open");
    assert.equal(await wsStatus(url, { origin: "https://evil.example", cookie }), 401);
  } finally {
    await t.close();
  }
});

function googleFetch({ email = EMAIL, verified = true, tokenOk = true } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return tokenOk ? Response.json({ access_token: "at", id_token: "x.e30.y" }) : new Response("no", { status: 400 });
    }
    return Response.json({ email, email_verified: verified });
  };
  f.calls = calls;
  return f;
}

async function googleStart(t) {
  const r = await t.req("GET", "/api/auth/google");
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location"));
  return loc;
}

test("google: redirect carries PKCE/state/nonce; success sets cookie", async () => {
  const f = googleFetch();
  const t = await setup({ fetch: f });
  try {
    const loc = await googleStart(t);
    assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const p = loc.searchParams;
    assert.equal(p.get("code_challenge_method"), "S256");
    assert.equal(p.get("scope"), "openid email profile");
    assert.equal(p.get("prompt"), "select_account");
    assert.equal(p.get("redirect_uri"), `${ORIGIN}/api/auth/google/callback`);
    assert.ok(p.get("nonce") && p.get("state"));
    const r = await t.req("GET", `/api/auth/google/callback?code=abc&state=${p.get("state")}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/");
    const cookie = r.headers.get("set-cookie").split(";")[0];
    assert.equal((await t.req("GET", "/api/bots", { cookie })).status, 200);
    const tokenCall = f.calls[0];
    assert.match(String(tokenCall.init.body), /code_verifier=/);
    // state is single use
    const again = await t.req("GET", `/api/auth/google/callback?code=abc&state=${p.get("state")}`);
    assert.equal(again.headers.get("location"), "/?auth_error=state");
  } finally {
    await t.close();
  }
});

test("google: wrong state, unverified email, outsider, exchange failure", async () => {
  for (const [opts, expected] of [
    [{ verified: false }, "denied"],
    [{ email: "evil@example.com" }, "denied"],
    [{ tokenOk: false }, "exchange"],
  ]) {
    const t = await setup({ fetch: googleFetch(opts) });
    try {
      const state = (await googleStart(t)).searchParams.get("state");
      const r = await t.req("GET", `/api/auth/google/callback?code=abc&state=${state}`);
      assert.equal(r.status, 302);
      assert.equal(r.headers.get("location"), `/?auth_error=${expected}`);
      assert.equal(r.headers.get("set-cookie"), null);
    } finally {
      await t.close();
    }
  }
  const t = await setup({ fetch: googleFetch() });
  try {
    await googleStart(t);
    const r = await t.req("GET", "/api/auth/google/callback?code=abc&state=wrong");
    assert.equal(r.headers.get("location"), "/?auth_error=state");
  } finally {
    await t.close();
  }
});

test("google: 503 when not configured", async () => {
  const t = await setup({ env: { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" } });
  try {
    assert.equal((await t.req("GET", "/api/auth/google")).status, 503);
  } finally {
    await t.close();
  }
});

test("logout invalidates the cookie; expired sessions are rejected", async () => {
  const t = await setup();
  try {
    const cookie = await t.login();
    assert.equal((await t.req("GET", "/api/auth/me", { cookie })).status, 200);
    const out = await t.req("POST", "/api/auth/logout", { cookie });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await t.req("GET", "/api/auth/me", { cookie })).status, 401);

    const cookie2 = await t.login();
    assert.equal((await t.req("GET", "/api/bots", { cookie: cookie2 })).status, 200);
    t.advance(31 * 24 * 60 * 60 * 1000);
    assert.equal((await t.req("GET", "/api/bots", { cookie: cookie2 })).status, 401);
  } finally {
    await t.close();
  }
});

test("empty allowlist rejects every login", async () => {
  const t = await setup({ env: { TARSBOT_ALLOWED_EMAILS: "" } });
  try {
    assert.equal((await t.req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } })).status, 401);
  } finally {
    await t.close();
  }
});

test("TARSBOT_AUTH_DISABLED: allowed on loopback, throws on non-loopback host", async () => {
  assert.throws(() => authSettings({ TARSBOT_AUTH_DISABLED: "1", TARSBOT_HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => register({ get() {}, post() {}, guard() {} }, { env: { TARSBOT_AUTH_DISABLED: "1", TARSBOT_HOST: "0.0.0.0" } }), /loopback/);
  const warn = console.warn;
  console.warn = () => {};
  const t = await setup({ env: { TARSBOT_AUTH_DISABLED: "1", TARSBOT_HOST: "127.0.0.1" } });
  console.warn = warn;
  try {
    assert.deepEqual((await t.req("GET", "/api/auth/me", { origin: null })).json, { email: "dev@local" });
    assert.equal((await t.req("GET", "/api/bots", { origin: null })).status, 200);
  } finally {
    await t.close();
  }
});

test("set-password.mjs via piped stdin, then login works; weak/outsider rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pca-setpw-"));
  const env = { ...process.env, TARSBOT_NO_DOTENV: "1", TARSBOT_DATA_DIR: dir, TARSBOT_ALLOWED_EMAILS: EMAIL };
  const run = (email, input) => spawnSync(process.execPath, ["scripts/set-password.mjs", email], { cwd: ROOT, env, input, encoding: "utf8" });
  try {
    const ok = run(EMAIL, "a-very-long-password\n");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), `password set for ${EMAIL}`);
    assert.ok(!ok.stdout.includes("a-very-long-password") && !ok.stderr.includes("a-very-long-password"));
    assert.notEqual(run(EMAIL, "short\n").status, 0);
    assert.notEqual(run("evil@example.com", "a-very-long-password\n").status, 0);

    const store = openAuthStore({ dataDir: dir });
    assert.equal(await store.verifyPassword(EMAIL, "a-very-long-password"), true);
    assert.equal(await store.verifyPassword(EMAIL, "wrong-wrong-wrong"), false);
    store.close();

    const api = createApi({
      harness: {},
      bots: { list: () => [] },
      routes: [(app) => register(app, { env: { TARSBOT_ALLOWED_EMAILS: EMAIL }, dataDir: dir })],
    });
    const { port } = await api.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: EMAIL, password: "a-very-long-password" }),
      });
      assert.equal(res.status, 200);
    } finally {
      await api.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
