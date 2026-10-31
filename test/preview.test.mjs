// AMP13-preview: the preview route + the in-Sprite forwarder. Offline: a real control store, a real createApi server,
// and a fake `bash` that emulates the Sprite by RUNNING the generated curl command in a local scratch dir — the
// bytes the browser receives are the bytes the wire format actually produces. No Sprite, no token, no real network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { register as registerPreview } from "../src/routes/preview.mjs";
import { register as registerAuth } from "../src/routes/auth.mjs";
import { openAuthStore } from "../src/auth.mjs";
import { curlCommand, parseCurlOutput, rewriteHtml, mintPreviewCapability, verifyPreviewCapability, PREVIEW_METHODS } from "../src/preview-env.mjs";

const EMAIL = "preview@example.com";
const PASSWORD = "correct horse battery";
const ORIGIN = "http://127.0.0.1:8090";

const HTML = `<!doctype html><html><head><title>demo</title></head><body><h1>hi</h1><script src="/app.js"></script><link href="/x.css" rel="stylesheet"></body></html>`;
const APP_JS = `document.body.dataset.ok = "1";`;

/** A Node stand-in for curl, driven by the SAME args the generated command passes. It writes the same artifacts
 * ($D/out, $D/hdr, $D/meta) a real curl writes and exits with code 7 when the "dev server" has no such path. */
const CURL_STUB = `import { writeFileSync } from "node:fs";
const D = process.argv[2];
const a = process.argv.slice(3);
const url = a[a.length - 1];
const m = /127\\.0\\.0\\.1:(\\d+)(\\/[^\\s'"]*)?/.exec(url);
const port = m ? Number(m[1]) : 0;
const path = ((m && m[2]) || "/").split("?")[0];
const out = D + "/out", meta = D + "/meta", hdr = D + "/hdr", err = D + "/err";
const serve = JSON.parse(process.env.PREVIEW_SERVE);
const UP = Number(process.env.PREVIEW_PORT);
if (port !== UP || !serve[path]) {
  writeFileSync(err, "curl: (7) Failed to connect to 127.0.0.1 port " + port);
  writeFileSync(meta, "");
  process.exit(7);
}
const r = serve[path];
writeFileSync(out, r.body ?? "");
writeFileSync(hdr, "HTTP/1.1 " + (r.status ?? 200) + " OK\\r\\nContent-Type: " + (r.contentType ?? "text/plain") + "\\r\\n" + (r.location ? "Location: " + r.location + "\\r\\n" : "") + (r["content-location"] ? "Content-Location: " + r["content-location"] + "\\r\\n" : "") + (r["set-cookie"] ? "Set-Cookie: " + r["set-cookie"] + "\\r\\n" : "") + "\\r\\n");
writeFileSync(meta, (r.status ?? 200) + "\\t" + (r.contentType ?? "text/plain") + "\\t" + url);
`;

/** Fake `bash`: executes the real generated shell locally, with `curl` swapped for the stub. The stub gets `D`
 * from its own env (the generated command sets it via `D=$(mktemp …)` before calling curl) plus `PREVIEW_SERVE` and
 * `PREVIEW_PORT` — i.e. exactly the in-Sprite view. macOS `mktemp -d` handles the trailing XXXXXX template. */
function fakeBash({ port, serve }) {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), "pca-preview-stub-"));
  const stub = join(dir, "curl.mjs");
  writeFileSync(stub, CURL_STUB);
  const bash = async (command, { timeoutMs } = {}) => {
    calls.push(command);
    return await new Promise((resolve) => {
      // `D` is a shell-local var in the generated command; pass it to the stub as an explicit argv so the stub sees
      // exactly what curl would. `curl` itself only needs the URL arg.
      const rewritten = command.replace(/\bcurl\b/g, `"${process.execPath}" "${stub}" "$D"`);
      execFile(
        "/bin/sh",
        ["-c", rewritten],
        {
          timeout: (timeoutMs ?? 10_000) + 5_000,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, PREVIEW_SERVE: JSON.stringify(serve), PREVIEW_PORT: String(port) },
        },
        (error, stdout, stderr) => resolve({ exitCode: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  };
  bash.calls = calls;
  return bash;
}

/** One world: store + a ready workspace + active binding + the preview route (optionally behind the real auth guard). */
async function makeEnv({ withAuth = false, withSeam = false, serve, port = 3000 } = {}) {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "prev-1",
    projectId: project.id,
    name: "prev",
    baseBranch: "main",
    branch: "tarsbot/prev-aaaaaa",
    cwd: "/home/sprite/workspace/app",
    model: { provider: "faux", modelId: "faux-1" },
  });
  const ws = store.workspaces.update(workspace.id, { status: "ready" });
  store.bindings.bind(ws.id, { provider: "sprites", runtimeId: "pca-preview0001" });

  const bash = fakeBash({ port, serve });
  const dataDir = mkdtempSync(join(tmpdir(), "pca-preview-auth-"));
  if (withAuth) {
    const s = openAuthStore({ dataDir });
    await s.setPassword(EMAIL, PASSWORD);
    s.close();
  }

  const workspaces = { get: (id) => store.workspaces.get(id) };
  const api = createApi({
    harness: {},
    bots: { list: () => [], get: () => undefined },
    routes: [
      ...(withAuth
        ? [
            (app) => {
              // The proposed auth.mjs seam — registered HERE in the test by wrapping the real registerAuth's
              // app.guard call, so the real guard logic + the previewAuthOk seam both run, exactly like the
              // parent-side one-line change:
              //   src/routes/auth.mjs, inside app.guard((req,{kind,path}) => {…}):
              //     if (kind === "http" && req.method === "GET" && app.ctx.previewAuthOk?.(path)) return true;
              const wrapped = withSeam
                ? {
                    ...app,
                    guard: (fn) =>
                      app.guard((req, info) => {
                        if (info.kind === "http" && req.method === "GET" && app.ctx.previewAuthOk?.(info.path)) return true;
                        return fn(req, info);
                      }),
                  }
                : app;
              registerAuth(wrapped, { env: { TARSBOT_ALLOWED_EMAILS: EMAIL }, dataDir });
            },
          ]
        : []),
      (app) => {
        app.ctx.workspaces = workspaces;
        app.ctx.control = store;
        app.ctx.runtimeBash = async () => bash;
      },
      registerPreview,
    ],
  });
  const { port: listenPort } = await api.listen(0);
  const base = `http://127.0.0.1:${listenPort}`;
  const req = async (method, path, { body, cookie, headers = {} } = {}) => {
    const h = { ...headers, origin: ORIGIN };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async () => {
    const r = await req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } });
    assert.equal(r.status, 200, r.text);
    return r.headers.get("set-cookie").split(";")[0];
  };
  return { ws, req, login, bash, close: () => api.close(), store };
}

// ---- pure helpers ----------------------------------------------------------------------------------------------------
test("PREVIEW_METHODS is the fixed allowlist; HEAD/OPTIONS/TRACE/CONNECT are refused", () => {
  assert.deepEqual([...PREVIEW_METHODS].sort(), ["DELETE", "GET", "PATCH", "POST", "PUT"]);
  for (const m of ["HEAD", "OPTIONS", "TRACE", "CONNECT"]) assert.ok(!PREVIEW_METHODS.has(m));
});

test("curlCommand: URL is always the Sprite loopback; body rides a /tmp scratch file cleaned by trap", () => {
  const cmd = curlCommand({ port: 3000, path: "/a?x=1", method: "POST", headers: [["content-type", "application/json"]], bodyB64: "aGk=" });
  assert.match(cmd, /'http:\/\/127\.0\.0\.1:3000\/a\?x=1'/);
  assert.match(cmd, /mktemp -d \/tmp\/pca-preview\./);
  assert.match(cmd, /trap 'rm -rf "\$D"' EXIT/);
  assert.match(cmd, /--data-binary @"\$D\/b"/);
  assert.match(cmd, /base64/);
  // no header outside the allowlist is ever emitted
  const cmd2 = curlCommand({ port: 1, path: "/", method: "GET", headers: [["cookie", "c=1"], ["authorization", "x"], ["accept", "*/*"]] });
  assert.ok(!/cookie/i.test(cmd2) && !/authorization/i.test(cmd2), cmd2);
});

test("parseCurlOutput: meta NUL hdr NUL body — binary body survives, last header block wins", () => {
  const meta = "200\ttext/html\thttp://127.0.0.1:3000/";
  const hdr = "HTTP/1.1 301 Moved\r\nLocation: /a\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-U: 1\r\n\r\n";
  const body = Buffer.concat([Buffer.from("<h1>x</h1>"), Buffer.from([0, 1, 2, 255])]);
  const packed = Buffer.concat([Buffer.from(meta), Buffer.from([0]), Buffer.from(hdr), Buffer.from([0]), body]).toString("base64");
  const out = parseCurlOutput(packed);
  assert.equal(out.status, 200);
  assert.equal(out.headers["x-u"], "1");
  assert.deepEqual([...out.body.slice(-4)], [0, 1, 2, 255]);
  assert.throws(() => parseCurlOutput("%%%"), /malformed|bad/);
});

test("rewriteHtml: <base> inject + path-absolute attrs rewritten; protocol-relative and relative untouched", () => {
  const out = rewriteHtml(`<html><head></head><body><script src="/app.js"></script><a href="//cdn.com/x">c</a><a href="rel/y">r</a><div style="background:url(/i.png)"></div></body></html>`, "/api/workspaces/w/preview/3000");
  assert.match(out, /<base href="\/api\/workspaces\/w\/preview\/3000\/">/);
  assert.match(out, /src="\/api\/workspaces\/w\/preview\/3000\/app\.js"/);
  assert.match(out, /href="\/\/cdn\.com\/x"/, "protocol-relative URLs are left alone");
  assert.match(out, /href="rel\/y"/, "relative URLs are left alone");
  assert.match(out, /url\(\/api\/workspaces\/w\/preview\/3000\/i\.png\)/);
});

// ---- the route over a real server ------------------------------------------------------------------------------------
test("probe: ready workspace + listening port -> up; dead port -> 无服务 reason", async () => {
  const env = await makeEnv({ serve: { "/": { status: 200, contentType: "text/html", body: HTML } } });
  try {
    const up = await env.req("GET", `/api/workspaces/${env.ws.id}/preview?port=3000`);
    assert.equal(up.status, 200, up.text);
    assert.deepEqual(up.json.ports, [3000]);
    assert.equal(up.json.up, true);

    const down = await env.req("GET", `/api/workspaces/${env.ws.id}/preview?port=9999`);
    assert.equal(down.status, 200);
    assert.equal(down.json.up, false);
    assert.equal(down.json.reason, "no_service");
  } finally {
    await env.close();
    env.store.close();
  }
});

test("proxy GET /: HTML is rewritten under the preview prefix; asset path resolves; non-HTML untouched", async () => {
  const env = await makeEnv({ serve: { "/": { status: 200, contentType: "text/html", body: HTML }, "/app.js": { status: 200, contentType: "text/javascript", body: APP_JS } } });
  try {
    const page = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/`);
    assert.equal(page.status, 200, page.text);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.text, /<base href="\/api\/workspaces\/[^/]+\/preview\/3000\/">/);
    assert.match(page.text, /src="\/api\/workspaces\/[^/]+\/preview\/3000\/app\.js"/);

    const asset = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.text, APP_JS);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  } finally {
    await env.close();
    env.store.close();
  }
});

test("proxy: multi-segment paths reach upstream verbatim; traversal and bad ports are 400 before any bash call", async () => {
  const env = await makeEnv({ serve: { "/static/css/app.css": { status: 200, contentType: "text/css", body: "body{}" } } });
  try {
    const ok = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/static/css/app.css`);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.text, "body{}");

    for (const bad of [`/preview/3000/../secret`, `/preview/3000/%2e%2e/x`, `/preview/abc/`, `/preview/0/`, `/preview/70000/`]) {
      const r = await env.req("GET", `/api/workspaces/${env.ws.id}${bad}`);
      assert.equal(r.status, 400, `${bad} -> ${r.status}`);
    }
    const missing = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/nope.js`);
    assert.equal(missing.status, 502); // nothing listening there → visible upstream failure, not silent 404
  } finally {
    await env.close();
    env.store.close();
  }
});

test("proxy POST: JSON body is forwarded; response headers are filtered (no set-cookie back)", async () => {
  const env = await makeEnv({
    serve: {
      "/echo": { status: 200, contentType: "application/json", body: `{"got":true}` },
      // a hostile app trying to plant a cookie on our origin must be stripped
      "/plant": { status: 200, contentType: "text/plain", body: "p", "set-cookie": "pca_session=stolen; Path=/" },
    },
  });
  try {
    const r = await env.req("POST", `/api/workspaces/${env.ws.id}/preview/3000/echo`, { body: { hello: "world" } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { got: true });
    const planted = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/plant`);
    assert.equal(planted.status, 200);
    assert.equal(planted.headers.get("set-cookie"), null, "an upstream Set-Cookie must never come back on our origin");
  } finally {
    await env.close();
    env.store.close();
  }
});

// ---- response-level isolation (the security fix): every proxy response is sandboxed, not just the iframe --------
test("every proxy response carries the response-level sandbox: CSP sandbox + nosniff + no-referrer", async () => {
  const env = await makeEnv({
    serve: {
      "/": { status: 200, contentType: "text/html", body: HTML },
      "/app.js": { status: 200, contentType: "text/javascript", body: APP_JS },
      "/img.svg": { status: 200, contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg"><script>top.location='/api/auth/me'</script></svg>` },
    },
  });
  try {
    for (const path of ["/", "/app.js", "/img.svg"]) {
      const r = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000${path}`);
      assert.equal(r.status, 200, path);
      // The CSP sandbox is on the response itself — direct navigation is isolated exactly like the iframe.
      assert.equal(r.headers.get("content-security-policy"), "sandbox allow-scripts", path);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer", path);
    }
  } finally {
    await env.close();
    env.store.close();
  }
});

test("redirects: a same-preview Location is normalized; external/other-port/scheme-relative are dropped", async () => {
  const env = await makeEnv({
    serve: {
      "/rel": { status: 302, contentType: "text/plain", body: "", location: "/inside?a=1#f" },
      "/abs-same": { status: 302, contentType: "text/plain", body: "", location: "http://127.0.0.1:3000/also" },
      "/evil": { status: 302, contentType: "text/plain", body: "", location: "https://evil.example/steal" },
      "/other-port": { status: 302, contentType: "text/plain", body: "", location: "http://127.0.0.1:9999/other" },
      "/scheme-rel": { status: 302, contentType: "text/plain", body: "", location: "//evil.example/x" },
      "/traversal": { status: 302, contentType: "text/plain", body: "", location: "/../../api/auth/me" },
      "/cl": { status: 200, contentType: "text/plain", body: "x", "content-location": "https://evil.example/c" },
    },
  });
  // teach the stub to emit Location/Content-Location header lines
  env.bash.calls.length = 0;
  try {
    const rel = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/rel`);
    assert.equal(rel.status, 302);
    const loc = rel.headers.get("location");
    assert.ok(loc?.startsWith(`/api/workspaces/${env.ws.id}/preview/3000/inside`), `same-preview redirect kept + prefixed, got ${loc}`);

    const abs = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/abs-same`);
    assert.match(abs.headers.get("location") ?? "", new RegExp(`/api/workspaces/${env.ws.id}/preview/3000/also`));

    for (const bad of ["/evil", "/other-port", "/scheme-rel", "/traversal"]) {
      const r = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000${bad}`);
      assert.equal(r.status, 302, bad);
      assert.equal(r.headers.get("location"), null, `${bad}: external/different-port/traversal redirect must be dropped`);
    }

    // content-location is never forwarded to the browser at all
    const cl = await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/cl`);
    assert.equal(cl.headers.get("content-location"), null);
  } finally {
    await env.close();
    env.store.close();
  }
});

test("guard: unauthenticated -> 401; logged-in -> 200; a non-ready/no-binding workspace is a visible error", async () => {
  const env = await makeEnv({
    withAuth: true,
    serve: { "/": { status: 200, contentType: "text/html", body: HTML } },
  });
  try {
    assert.equal((await env.req("GET", `/api/workspaces/${env.ws.id}/preview?port=3000`)).status, 401);
    assert.equal((await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/`)).status, 401);
    const cookie = await env.login();
    assert.equal((await env.req("GET", `/api/workspaces/${env.ws.id}/preview?port=3000`, { cookie })).status, 200);
    assert.equal((await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/`, { cookie })).status, 200);

    // a workspace the route cannot resolve is a 404; one without an active binding is a visible 409
    assert.equal((await env.req("GET", `/api/workspaces/ws_nope/preview?port=3000`, { cookie })).status, 404);
  } finally {
    await env.close();
    env.store.close();
  }
});

test("guard: not-ready workspace is 409", async () => {
  const env = await makeEnv({ serve: { "/": { status: 200, body: "x" } } });
  try {
    env.store.workspaces.update(env.ws.id, { status: "preparing" });
    const notReady = await env.req("GET", `/api/workspaces/${env.ws.id}/preview?port=3000`);
    assert.equal(notReady.status, 409);
    assert.match(notReady.json.error, /not ready/);
  } finally {
    await env.close();
    env.store.close();
  }
});

// ---- path capability (the live-acceptance fix): opaque-origin subresources carry no cookie ---------------------------
test("capability mint+verify: bound to ws+runtimeId+port; tamper/expiry/wrong-binding rejected", async () => {
  const store = openControlStore({ path: null });
  try {
    const cap = mintPreviewCapability({ control: store, workspaceId: "w1", runtimeId: "rt1", port: 3000 });
    assert.match(cap.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(verifyPreviewCapability({ control: store, workspaceId: "w1", runtimeId: "rt1", port: 3000, token: `cap-${cap.token}` }).ok, true);
    // wrong scope
    assert.equal(verifyPreviewCapability({ control: store, workspaceId: "w2", runtimeId: "rt1", port: 3000, token: `cap-${cap.token}` }).reason, "scope");
    assert.equal(verifyPreviewCapability({ control: store, workspaceId: "w1", runtimeId: "rt2", port: 3000, token: `cap-${cap.token}` }).reason, "scope");
    assert.equal(verifyPreviewCapability({ control: store, workspaceId: "w1", runtimeId: "rt1", port: 9999, token: `cap-${cap.token}` }).reason, "scope");
    // tampered signature / garbage / expired
    assert.equal(verifyPreviewCapability({ control: store, workspaceId: "w1", runtimeId: "rt1", port: 3000, token: `cap-${cap.token}x` }).reason, "signature");
    assert.equal(verifyPreviewCapability({ control: store, workspaceId: "w1", runtimeId: "rt1", port: 3000, token: "cap-garbage" }).reason, "format");
    const old = mintPreviewCapability({ control: store, workspaceId: "w1", runtimeId: "rt1", port: 3000, now: Date.now() - 20 * 60_000 });
    assert.equal(verifyPreviewCapability({ control: store, workspaceId: "w1", runtimeId: "rt1", port: 3000, token: `cap-${old.token}` }).reason, "expired");
  } finally {
    store.close();
  }
});

test("cap URL end-to-end: mint → cookie-less GET (opaque-origin asset) works; invalid cap / plain cookie-less / cap on other API refused", async () => {
  const env = await makeEnv({
    withAuth: true,
    withSeam: true, // the parent-side one-line guard seam, exercised against the REAL auth guard
    serve: {
      "/": { status: 200, contentType: "text/html", body: `<html><head></head><body><a href="page2">next</a><script src="/app.js"></script></body></html>` },
      "/app.js": { status: 200, contentType: "text/javascript", body: APP_JS },
      "/page2": { status: 200, contentType: "text/html", body: `<html><body>page2</body></html>` },
    },
  });
  try {
    const cookie = await env.login();
    // 1. mint (session cookie + Origin — the only path to a capability)
    const mint = await env.req("POST", `/api/workspaces/${env.ws.id}/preview/token`, { body: { port: 3000 }, cookie });
    assert.equal(mint.status, 200, mint.text);
    assert.match(mint.json.url, new RegExp(`^/api/workspaces/${env.ws.id}/preview/3000/cap-`));
    const capUrl = mint.json.url;

    // 2. THE ACCEPTANCE CASE: cookie-less requests (what the opaque-origin iframe sends) load the page and assets.
    const page = await env.req("GET", capUrl); // no cookie — only the path cap
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /<base href="[^"]*cap-[^/]+\//, "rewritten base keeps the capability");
    assert.match(page.text, /src="[^"]*cap-[^/]+\/app\.js"/, "rewritten absolute src keeps the capability");
    const asset = await env.req("GET", `${capUrl}app.js`); // relative asset resolves under cap prefix, no cookie
    assert.equal(asset.status, 200);
    assert.equal(asset.text, APP_JS);
    const nav = await env.req("GET", `${capUrl}page2`); // in-app navigation, no cookie
    assert.equal(nav.status, 200);

    // 3. refusals: no cookie and no cap → 401 (unchanged); bad cap → 401/403; cap does NOT authorize other API paths.
    assert.equal((await env.req("GET", `/api/workspaces/${env.ws.id}/preview/3000/`)).status, 401);
    const badCap = `${capUrl.slice(0, capUrl.indexOf("cap-"))}cap-forged.invalid/`;
    const forged = await env.req("GET", badCap);
    assert.ok([401, 403].includes(forged.status), `forged cap → ${forged.status}`);
    assert.equal((await env.req("GET", "/api/bots")).status, 401, "the cap seam must not open ordinary API");

    // 4. rebuild (new runtimeId) revokes the cap even before expiry.
    env.store.bindings.bind(env.ws.id, { provider: "sprites", runtimeId: "pca-rebuilt-02" });
    const afterRebuild = await env.req("GET", capUrl);
    assert.ok([401, 403].includes(afterRebuild.status), `stale-binding cap → ${afterRebuild.status}`);
  } finally {
    await env.close();
    env.store.close();
  }
});
