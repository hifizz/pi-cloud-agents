// Preview routes (AMP13-preview): let the user open the dev server that is ACTUALLY running inside the current
// session's workspace Sprite, through the authenticated API. The Sprite stays private — nothing touches urlSettings
// and no token ever reaches the browser; requests are forwarded by src/preview-env.mjs as an in-Sprite curl over the
// workspace's own runtimeBash.
//
//   GET  /api/workspaces/:id/preview                          -> {ports, workspaceId}   (probe; session-cookie auth)
//   POST /api/workspaces/:id/preview/token   {port}           -> {token, exp, url}      (mint; session-cookie auth)
//   GET|POST /api/workspaces/:id/preview/:port/:capPath/:path* -> the upstream response (cap-… auth OR session cookie)
//
// WHY a path capability (the live-acceptance fix): the app is CSP-sandboxed to an opaque origin, so its subresource
// requests — <script src>, <link>, <a href> navigation — are cross-site w.r.t. our origin and the SameSite=Lax
// session cookie is NOT sent. That isolation is correct and stays. The capability is the parent-approved bridge:
//   - minted ONLY by an authenticated POST (Origin-checked, session cookie);
//   - bound server-side to (workspaceId, active binding runtimeId, port) — a rebuild invalidates it;
//   - carried in the path (cap-<payload>.<sig>), never a cookie/header, never forwarded upstream;
//   - a global-guard seam lets it satisfy auth on GET requests to ITS OWN prefix only — nothing else is authorized;
//   - short-lived (15 min) + path-bound + HMAC over control.meta secret → no replay to other workspaces/ports.
// `path` inside a cap URL is still the same traversal-checked relative path → SSRF stays impossible.
// Response-level isolation is unchanged (CSP sandbox + nosniff + no-referrer on every response).
import { HttpError } from "../api.mjs";
import {
  forwardPreview,
  probePreview,
  rewriteHtml,
  mintPreviewCapability,
  verifyPreviewCapability,
  PREVIEW_METHODS,
  PREVIEW_RESPONSE_HEADERS,
  FORWARD_REQ_HEADERS,
  PREVIEW_TIMEOUT_MS,
  CAP_TTL_MS,
} from "../preview-env.mjs";

const PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/%\-\[\]]*$/;
const COMMON_PORTS = [3000, 5173, 8000, 8080, 4173, 4200, 5000];
/** A `cap-<b64>.<sig>` path segment; the route pattern is a named param, validated below. */
const CAP_SEG_RE = /^cap-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

let warned = false;

/** A client-supplied path becomes an upstream path ONLY after these checks — a literal ".." segment or an encoded
 * traversal is rejected, never normalized away. `capPrefix` (the cap-bearing URL prefix) is re-prepended when the
 * caller rewrites HTML so asset links keep carrying the capability. */
function checkedPath(raw, query, { capPrefix = "" } = {}) {
  const path = `/${String(raw ?? "").replace(/^\/+/, "")}`;
  if (path.length > 2048) throw new HttpError(400, "path is too long");
  if (!PATH_RE.test(path)) throw new HttpError(400, "path contains illegal characters");
  for (const seg of path.split("/")) {
    if (seg === ".." || /%2e/i.test(seg)) throw new HttpError(400, "path traversal is not allowed");
  }
  const qs = new URLSearchParams(query ?? {}).toString();
  return { upstream: qs ? `${path}?${qs}` : path, display: `${capPrefix}${path}` };
}

function checkedPort(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new HttpError(400, "port must be an integer between 1 and 65535");
  return n;
}

/** Headers the browser sent that may cross. Everything else (cookie, host, auth) is dropped here AND in the env. */
function forwardedHeaders(req) {
  const out = {};
  for (const k of FORWARD_REQ_HEADERS) {
    const v = req.headers[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

const isHtml = (headers) => /text\/html/i.test(String(headers["content-type"] ?? ""));

/** Upstream Location → a safe value for the browser, or null to drop it. Same-preview-only; external/other-port/
 * scheme-relative/traversal are dropped. `capPrefix` keeps the cap segment on relative redirects. */
function normalizeLocation(location, { port, prefix, capPrefix = "" }) {
  if (typeof location !== "string" || !location.trim()) return null;
  for (const seg of location.split("?")[0].split("#")[0].split("/")) {
    if (seg === ".." || /^\.{2,}$/.test(seg) || /%2e/i.test(seg)) return null;
  }
  let u;
  try {
    u = new URL(location, `http://127.0.0.1:${port}/`);
  } catch {
    return null;
  }
  if (u.hostname !== "127.0.0.1") return null;
  if (u.port !== "" && Number(u.port) !== port) return null;
  let path = u.pathname + u.search + u.hash;
  if (!path.startsWith("/")) path = `/${path}`;
  return `${capPrefix || prefix}${path}`;
}

export function register(app) {
  const { workspaces, control } = app.ctx;
  if (!workspaces || !control) {
    if (!warned) {
      warned = true;
      console.warn("routes/preview: app.ctx.workspaces / control is not set, preview routes are not registered");
    }
    return;
  }

  // The guard verifies a scoped capability before allowing a cookieless sandbox resource request.
  app.ctx.previewAuthOk = (path) => {
    const match = /^\/api\/workspaces\/([^/]+)\/preview\/(\d+)\/(cap-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:\/|$)/.exec(path);
    if (!match) return false;
    const [, workspaceId, port, token] = match;
    const binding = control.bindings.current(workspaceId);
    if (!binding || workspaces.get(workspaceId)?.status !== "ready") return false;
    return verifyPreviewCapability({ control, workspaceId, runtimeId: binding.runtimeId, port: Number(port), token }).ok;
  };

  const workspaceOr404 = (id) => {
    const ws = workspaces.get(id);
    if (!ws) throw new HttpError(404, `workspace not found: ${id}`);
    return ws;
  };

  /** The session's real Sprite: server-resolved from the workspace + its active binding; ready and bash-capable, or
   * a visible 409/503 — never a guess and never a host-side fallback. Returns {bash, binding} for cap scoping. */
  async function sessionBash(id) {
    const ws = workspaceOr404(id);
    if (ws.status !== "ready") throw new HttpError(409, `workspace is not ready (status: ${ws.status})`);
    const binding = control.bindings.current(id);
    if (!binding?.runtimeId) throw new HttpError(409, "workspace has no active runtime binding");
    if (typeof app.ctx.runtimeBash !== "function") throw new HttpError(503, "runtime bash is not available");
    try {
      return { bash: await app.ctx.runtimeBash(id), binding };
    } catch (e) {
      throw new HttpError(409, `runtime unavailable: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  function mapPreviewError(e) {
    if (e instanceof HttpError) return e;
    switch (e?.code) {
      case "no_service":
        return new HttpError(502, "无服务：该端口在工作区 Sprite 内没有进程监听");
      case "timeout":
        return new HttpError(504, "预览请求超时");
      case "too_large":
        return new HttpError(502, "预览响应过大");
      case "upstream":
      case "bad_output":
      default:
        return new HttpError(502, "预览上游请求失败");
    }
  }

  // GET /api/workspaces/:id/preview — probe the common dev ports (and ?port=N for one explicit check). Session auth.
  app.get("/api/workspaces/:id/preview", async (_req, _res, { params, query }) => {
    const { bash } = await sessionBash(params.id);
    if (query.port !== undefined) {
      const port = checkedPort(query.port);
      const r = await probePreview({ bash, port });
      return { workspaceId: params.id, ports: r.ok ? [port] : [], up: r.ok, port, ...(r.ok ? {} : { reason: r.kind }) };
    }
    const ports = [];
    for (const port of COMMON_PORTS) {
      const r = await probePreview({ bash, port, timeoutMs: 4_000 });
      if (r.ok) ports.push(port);
    }
    return { workspaceId: params.id, ports };
  });

  // POST /api/workspaces/:id/preview/token {port} — mint a path capability. Session-cookie + Origin-checked by the
  // global guard; the cap is what the OPAQUE-ORIGIN frame's assets/navigate can actually use. Bound to the CURRENT
  // binding — a rebuild kills it.
  app.post("/api/workspaces/:id/preview/token", async (_req, _res, { params, body }) => {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const port = checkedPort(b.port);
    const { binding } = await sessionBash(params.id);
    const cap = mintPreviewCapability({ control, workspaceId: params.id, runtimeId: binding.runtimeId, port });
    return {
      token: cap.token,
      exp: cap.exp,
      url: `/api/workspaces/${params.id}/preview/${port}/cap-${cap.token}/`,
      ttlMs: CAP_TTL_MS,
    };
  });

  // The proxy. Two auth shapes reach it (the global guard ran first):
  //   - session cookie (panel's own probe/new-tab GET, or a same-origin fetch): cookie present → route works.
  //   - cap in path (the sandboxed app's subresources/navigation, which cannot carry the cookie): when the FIRST
  //     segment after the port is `cap-<token>`, the route re-verifies it against the CURRENT binding before
  //     proxying. Any other first segment is just a normal path segment — a cookie-authed request to
  //     /preview/3000/app.js keeps working unchanged.
  const proxy = async (req, res, { params, query, body }) => {
    if (!PREVIEW_METHODS.has(req.method)) throw new HttpError(405, "method not allowed");
    const port = checkedPort(params.port);
    const { bash, binding } = await sessionBash(params.id);

    const firstSeg = params.capPath ?? null;
    let capPrefix = "";
    // params.capPath IS the first path segment — the catch-all :path* holds the rest. A `cap-` first segment is the
    // capability; anything else is just the app's own first path segment.
    if (firstSeg !== null && firstSeg.startsWith("cap-")) {
      if (!CAP_SEG_RE.test(firstSeg)) throw new HttpError(401, "invalid preview capability");
      const v = verifyPreviewCapability({ control, workspaceId: params.id, runtimeId: binding.runtimeId, port, token: firstSeg });
      if (!v.ok) throw new HttpError(v.reason === "expired" ? 401 : 403, `preview capability ${v.reason}`);
      capPrefix = `/api/workspaces/${params.id}/preview/${port}/${firstSeg}`;
    }
    // Reconstruct the upstream path: first segment + the catch-all rest (or just the rest when the first is a cap).
    const rawPath = capPrefix ? (params.path ?? "") : [firstSeg, params.path].filter(Boolean).join("/");
    // When there's no cap segment the global guard already required a session cookie — nothing extra here.

    const { upstream } = checkedPath(rawPath, query, { capPrefix });
    try {
      const out = await forwardPreview({
        bash,
        port,
        path: upstream,
        method: req.method,
        reqHeaders: forwardedHeaders(req),
        body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
        timeoutMs: PREVIEW_TIMEOUT_MS,
      });
      let body2 = out.body;
      const prefix = `/api/workspaces/${params.id}/preview/${port}`;
      const headers = { ...PREVIEW_RESPONSE_HEADERS, ...out.headers, "cache-control": "no-store" };
      const loc = normalizeLocation(out.upstreamHeaders?.location, { port, prefix, capPrefix });
      if (loc !== null) headers.location = loc;
      else delete headers.location;
      delete headers["content-location"];
      if (isHtml(out.headers) && req.method === "GET") {
        // Base prefix includes the cap so rewritten assets AND <base> keep it — subresources stay authorized.
        body2 = Buffer.from(rewriteHtml(out.body.toString("utf8"), capPrefix || prefix), "utf8");
        headers["content-type"] = "text/html; charset=utf-8";
      }
      if (body2.length) headers["content-length"] = body2.length;
      res.writeHead(out.status, headers);
      res.end(body2);
    } catch (e) {
      throw mapPreviewError(e);
    }
  };
  app.get("/api/workspaces/:id/preview/:port", proxy);
  app.post("/api/workspaces/:id/preview/:port", proxy);
  // One trailing segment (e.g. /app.js or /cap-T) — :capPath/:path* only matches two+ segments.
  app.get("/api/workspaces/:id/preview/:port/:capPath", proxy);
  app.post("/api/workspaces/:id/preview/:port/:capPath", proxy);
  app.get("/api/workspaces/:id/preview/:port/:capPath/:path*", proxy);
  app.post("/api/workspaces/:id/preview/:port/:capPath/:path*", proxy);
}
