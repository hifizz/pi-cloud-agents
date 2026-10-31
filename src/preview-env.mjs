// Preview HTTP forwarder for a workspace Sprite (AMP13-preview). The Sprites SDK does have a proxy primitive
// (Sprite.proxyPort → /v1/sprites/<name>/proxy over an authenticated WebSocket), but it needs the raw
// {baseURL, token} and would open a listening socket next to the API server. The existing runtimeBash primitive is
// the safer seam: it already runs commands inside the target Sprite's own namespace, so the request reaches the dev
// server via that Sprite's loopback — no token ever leaves the provider, nothing binds a port on the API host, and
// no private Sprite is made public.
//
// Wire format (the Sprite-side contract; exercised against a fake bash in test/preview.test.mjs, no network):
//   stdout = base64( meta \0 hdr \0 body )
//     meta = "%{http_code}\t%{content_type}\t%{url_effective}"   (curl --write-out)
//     hdr  = the last header block curl received (-D dump file; CRLF lines, no NUL possible)
//     body = raw response bytes (may contain \0 — only the FIRST two NULs split the fields)
//   stderr carries "code=<curl-exit-code>" when curl itself failed; code=7 is connection refused → the caller shows
//   无服务 as a visible error, never a stale page.
//
// Safety:
//  - The URL is always http://127.0.0.1:<port><path>: port is a bounded int, path is validated by the route, and the
//    URL is shell-quoted — a request can only reach the Sprite's own loopback (no SSRF to a chosen host).
//  - Methods are a fixed allowlist; a request body rides a temp file under the Sprite's /tmp (never the workspace
//    dir, never .env/.git), removed by the same command line's trap. Body size is capped far below the Sprite exec
//    URL limit (the whole command travels inside a WebSocket URL, see MAX_EXEC_QUERY_CHARS in src/sandbox/sprites.mjs).
//  - --compressed is passed so curl returns DECODED bytes; Content-Encoding is never forwarded, so the browser can
//    never receive bytes it would decode twice.
//  - Nothing here touches urlSettings, creates/releases Sprites, or reads credentials.
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { shellQuote } from "./env.mjs";

export const PREVIEW_TIMEOUT_MS = 30_000;
/** Request body cap in bytes. A base64 body is embedded in the exec command, which rides the Sprite exec WebSocket
 * URL (~64k URL chars); 15 KB of raw body stays safely below it. api.mjs also caps all POST bodies at 4 MB. */
export const MAX_PREVIEW_BODY = 15_000;
export const MAX_PREVIEW_RESPONSE = 8 * 1024 * 1024;

/** The explicit method allowlist — not "any verb". HEAD/OPTIONS/TRACE/CONNECT are refused: `curl -X HEAD` hangs on
 * keep-alive servers and CORS preflight is meaningless same-origin. */
export const PREVIEW_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Request headers forwarded verbatim — deliberately small; Cookie/Authorization/Host never cross, so a hostile app
 * cannot ride our login session or impersonate the Sprite's own auth. */
export const FORWARD_REQ_HEADERS = new Set(["content-type", "accept", "accept-language"]);
/** Response headers passed back. Set-Cookie and Content-Encoding are NOT among them: an app cookie on our origin
 * would leak into /api requests, and curl --compressed already decoded the body. `location` and `content-location`
 * are deliberately absent — an upstream redirect target is attacker-controlled; the route normalizes a same-preview
 * relative Location itself and never forwards an absolute/external one. */
export const FORWARD_RES_HEADERS = new Set(["content-type", "cache-control", "etag", "last-modified", "expires"]);

/** Response-level isolation applied to EVERY proxy response — headers, not just the iframe attribute, so a user who
 * opens the preview URL directly gets the same sandbox. `sandbox allow-scripts`: scripts run (the page works) but
 * the document is a unique opaque origin — it can never read/write this origin's cookies, storage or DOM, cannot
 * navigate the top frame, and cannot open popups. `nosniff` stops a served asset being sniffed into a script or
 * document. Referrer-Policy no-referrer keeps our URL path out of anything the page embeds. */
export const PREVIEW_RESPONSE_HEADERS = {
  "content-security-policy": "sandbox allow-scripts",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// ---- scoped preview capability ---------------------------------------------------------------------------------
// The opaque-origin sandbox means the app's subresource requests can NOT carry the SameSite=Lax session cookie —
// that is the isolation working as intended. The capability is the bridge the parent approved: a short-lived,
// HMAC-signed token carried IN THE PATH (not a cookie, not a header, never forwarded upstream) that authorizes GET
// access to ONE preview prefix only. It is bound to (workspaceId, binding runtimeId, port): a rebuild (new
// runtimeId) invalidates it, and it can never authorize anything outside its own /preview/<port>/cap-…/ path.
export const CAP_TTL_MS = 15 * 60 * 1000;
export const CAP_RE = /^cap-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const capSecret = (control) => control.meta.ensure("previewCapSecret", () => b64u(randomBytes(32)));

const capPayload = ({ workspaceId, runtimeId, port, exp }) => `${workspaceId}|${runtimeId}|${port}|${exp}`;
const capSig = (secret, payload) => b64u(createHmac("sha256", secret).update(payload).digest());

/** Mint a capability for (ws, binding, port). `now`/`ttlMs` injectable for tests. */
export function mintPreviewCapability({ control, workspaceId, runtimeId, port, now = Date.now(), ttlMs = CAP_TTL_MS }) {
  const exp = now + ttlMs;
  const payload = capPayload({ workspaceId, runtimeId, port, exp });
  const token = `${b64u(payload)}.${capSig(capSecret(control), payload)}`;
  return { token, exp };
}

/** Validate a `cap-<payload>.<sig>` token against the CURRENT binding. Returns {ok:true} or {ok:false, reason}. The
 * binding is read at request time so a rebuild (new runtimeId) revokes all outstanding caps immediately. */
export function verifyPreviewCapability({ control, workspaceId, runtimeId, port, token, now = Date.now() }) {
  const m = CAP_RE.exec(String(token ?? ""));
  if (!m) return { ok: false, reason: "format" };
  let payload;
  try {
    payload = Buffer.from(m[1], "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "format" };
  }
  const [ws, rid, p, exp] = payload.split("|");
  const expN = Number(exp);
  if (ws !== workspaceId || rid !== runtimeId || Number(p) !== port || !Number.isInteger(expN)) return { ok: false, reason: "scope" };
  if (expN < now) return { ok: false, reason: "expired" };
  const expected = capSig(capSecret(control), payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(m[2]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature" };
  return { ok: true };
}

const q = (s) => shellQuote([String(s)]);

/**
 * Build the Sprite-side command. The URL, every header and the base64 body are single-quoted argv pieces; the script
 * skeleton itself is a fixed string (no request text ever becomes shell syntax). `D` is a scratch dir under the
 * Sprite's /tmp — never the workspace dir — removed by the trap on the same line.
 */
export function curlCommand({ port, path, method, headers = [], bodyB64 = "", timeoutMs = PREVIEW_TIMEOUT_MS }) {
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  const hdr = headers.filter(([k]) => FORWARD_REQ_HEADERS.has(k)).map(([k, v]) => `-H ${q(`${k}: ${v}`)}`).join(" ");
  const write = bodyB64 ? ` && printf %s ${q(bodyB64)} | base64 -d > "$D/b"` : "";
  const data = bodyB64 ? ` --data-binary @"$D/b"` : "";
  const url = q(`http://127.0.0.1:${port}${path}`);
  return (
    `D=$(mktemp -d /tmp/pca-preview.XXXXXX) || exit 90; trap 'rm -rf "$D"' EXIT` +
    write +
    ` && curl -sS --compressed --max-time ${secs} -X ${method}${hdr ? ` ${hdr}` : ""}${data}` +
    ` -D "$D/hdr" --output "$D/out" --write-out '%{http_code}\t%{content_type}\t%{url_effective}' ${url} > "$D/meta" 2>"$D/err"` +
    ` || { c=$?; cat "$D/err" >&2; printf 'code=%s' "$c" >&2; exit $c; }` +
    ` && { cat "$D/meta"; printf '\\000'; cat "$D/hdr"; printf '\\000'; cat "$D/out"; } | base64`
  );
}

/** The LAST header block of a `curl -D` dump (redirect/1xx chains precede it). Returns {name: value} lowercase. */
export function parseHeaderDump(dump) {
  const blocks = dump.split("\r\n\r\n").filter((b) => b.trim());
  const last = blocks.at(-1) ?? "";
  const headers = {};
  for (const line of last.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/** Parse the base64 stdout back into {status, headers, body}. Throws a coded error on malformed output. */
export function parseCurlOutput(stdout) {
  const raw = Buffer.from(String(stdout).replace(/\s+/g, ""), "base64");
  const nul1 = raw.indexOf(0);
  const nul2 = nul1 < 0 ? -1 : raw.indexOf(0, nul1 + 1);
  if (!raw.length || nul1 < 0 || nul2 < 0) {
    const e = new Error("preview: malformed upstream output");
    e.code = "bad_output";
    throw e;
  }
  const meta = raw.subarray(0, nul1).toString("utf8").split("\t");
  const status = Number(meta[0]);
  if (!Number.isInteger(status) || status < 100 || status > 999) {
    const e = new Error("preview: bad upstream status");
    e.code = "bad_output";
    throw e;
  }
  const headers = parseHeaderDump(raw.subarray(nul1 + 1, nul2).toString("latin1"));
  if (meta[1]) headers["content-type"] = headers["content-type"] ?? meta[1];
  return { status, headers, body: raw.subarray(nul2 + 1) };
}

const coded = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

/**
 * Forward one validated request through `bash` — the workspace's runtimeBash, so it runs INSIDE the Sprite and
 * 127.0.0.1 is exactly the dev server the user started there. Returns {status, headers, body}; throws a coded error:
 *   no_service (connection refused → visible 无服务), timeout, too_large, upstream, bad_output.
 * Response headers are filtered to FORWARD_RES_HEADERS before returning.
 */
export async function forwardPreview({ bash, port, path, method, reqHeaders = {}, body = Buffer.alloc(0), timeoutMs = PREVIEW_TIMEOUT_MS }) {
  if (body.length > MAX_PREVIEW_BODY) throw coded("too_large", `preview request body exceeds ${MAX_PREVIEW_BODY} bytes`);
  const headers = Object.entries(reqHeaders)
    .filter(([k]) => FORWARD_REQ_HEADERS.has(k.toLowerCase()))
    .map(([k, v]) => [k.toLowerCase(), String(v).slice(0, 512)]);
  const bodyB64 = body.length ? body.toString("base64") : "";
  const r = await bash(curlCommand({ port, path, method, headers, bodyB64, timeoutMs }), { timeoutMs: timeoutMs + 10_000 });
  if (r?.timedOut) throw coded("timeout", "preview request timed out");
  if (r?.exitCode !== 0) {
    const m = /code=(\d+)/.exec(String(r?.stderr ?? ""));
    if (m && m[1] === "7") throw coded("no_service", "nothing is listening on that port in the workspace Sprite");
    if (m && m[1] === "28") throw coded("timeout", "preview upstream timed out");
    throw coded("upstream", `preview upstream failed${m ? ` (curl ${m[1]})` : ""}`);
  }
  const out = parseCurlOutput(r.stdout);
  if (out.body.length > MAX_PREVIEW_RESPONSE) throw coded("too_large", "preview response too large");
  const filtered = {};
  for (const k of FORWARD_RES_HEADERS) if (out.headers[k] !== undefined) filtered[k] = out.headers[k];
  // `location`/`content-location` are NEVER forwarded — returned separately for the route to normalize or drop.
  const upstreamHeaders = {};
  for (const k of ["location", "content-location"]) if (out.headers[k] !== undefined) upstreamHeaders[k] = out.headers[k];
  return { status: out.status, headers: filtered, upstreamHeaders, body: out.body };
}

/**
 * Rewrite an upstream HTML page so its asset URLs stay under the preview prefix `base` (e.g.
 * /api/workspaces/w/preview/3000). Relative URLs resolve against the document URL already; this additionally:
 *   - injects <base href="base/"> so relative links keep working whatever the document's own URL suffix is;
 *   - rewrites path-absolute attr/url() references (`src="/x"`, `url(/x)`) onto the prefix — `//` protocol-relative
 *     URLs are left alone. Absolute-path `fetch("/x")` inside JS is NOT rewritten (documented limitation).
 * Runs only on text/html bodies; anything else is returned untouched.
 */
export function rewriteHtml(html, base) {
  const b = String(base).replace(/\/+$/, "");
  let out = String(html);
  // <base> first in <head>: relative URLs and anchor refs now resolve under the preview path.
  if (/<head[\s>]/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${b}/">`);
  else out = `<base href="${b}/">` + out;
  // Path-absolute attribute values — but never protocol-relative "//" and never the base we just injected.
  const rewriteAbs = (m) => m.replace(/((?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${b}/`);
  const parts = out.split(/(<base[^>]*>)/i);
  out = parts.map((p, i) => (i % 2 === 1 ? p : rewriteAbs(p))).join("");
  // Inline CSS url(/x). url(//x) and url(data:) untouched.
  out = out.replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${b}/`);
  return out;
}

/** Is anything listening on this port inside the Sprite? One real bash round-trip; a refused connection is a visible
 * 无服务, anything else is ok. Never a guess and never silently "up". */
export async function probePreview({ bash, port, timeoutMs = 8_000 }) {
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  const r = await bash(`D=$(mktemp -d /tmp/pca-preview.XXXXXX) || exit 90; trap 'rm -rf "$D"' EXIT; curl -sS --max-time ${secs} -o /dev/null ${q(`http://127.0.0.1:${port}/`)} || printf 'code=%s' $?`, {
    timeoutMs: timeoutMs + 5_000,
  });
  if (r?.timedOut) return { ok: false, kind: "timeout" };
  const m = /code=(\d+)/.exec(`${r?.stdout ?? ""}${r?.stderr ?? ""}`);
  if (!m) return { ok: r?.exitCode === 0 };
  return { ok: false, kind: m[1] === "7" ? "no_service" : m[1] === "28" ? "timeout" : "upstream", code: Number(m[1]) };
}
