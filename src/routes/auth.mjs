// Auth routes + global guard (docs/CLOUD-PLAN.md §4). Whitelisted-email login via password or Google OAuth (PKCE).
// Nothing secret (passwords, session tokens, OAuth codes/secrets) is logged or echoed in responses.
import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../api.mjs";
import { authSettings, hashPassword, normalizeEmail, openAuthStore, SESSION_TTL_MS, verifyPasswordHash } from "../auth.mjs";

const COOKIE = "pca_session";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const STATE_TTL_MS = 10 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 5;
const DEV_ORIGINS = ["http://127.0.0.1:8090", "http://localhost:8090", "http://127.0.0.1:5183", "http://localhost:5183"];
const LOGIN_ERROR = "invalid email or password";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const isLoopbackUrl = (u) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};

/**
 * @param {any} app
 * @param {{ fetch?: typeof fetch, env?: Record<string,string|undefined>, dataDir?: string, now?: () => number, store?: any }} [opts]
 */
export function register(app, opts = {}) {
  const env = opts.env ?? process.env;
  const settings = authSettings(env); // throws when AUTH_DISABLED on a non-loopback host
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));

  let store = opts.store;
  const getStore = () => (store ??= openAuthStore({ dataDir: opts.dataDir, now }));

  const publicOrigin = (() => {
    try {
      return new URL(settings.publicUrl).origin;
    } catch {
      return undefined;
    }
  })();
  const allowedOrigins = new Set([publicOrigin].filter(Boolean));
  if (!settings.publicUrlSet || isLoopbackUrl(settings.publicUrl)) for (const o of DEV_ORIGINS) allowedOrigins.add(o);

  let warned = false;
  const warnDisabled = () => {
    if (warned) return;
    warned = true;
    console.warn("auth: TARSBOT_AUTH_DISABLED=1 — authentication is OFF (local development only)");
  };
  if (settings.disabled) warnDisabled();

  const secureCookie = (req) => settings.publicUrl.startsWith("https://") || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  const cookieHeader = (req, value, maxAge) =>
    `${COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureCookie(req) ? "; Secure" : ""}`;
  const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE];
  // Re-check the allowlist on every lookup: removing an email from TARSBOT_ALLOWED_EMAILS revokes its sessions.
  const sessionOf = (req) => {
    const s = getStore().getSession(tokenOf(req));
    return s && settings.allowed.has(s.email) ? s : null;
  };
  const clientIp = (req) => (env.FLY_APP_NAME && req.headers["fly-client-ip"]) || req.socket?.remoteAddress || "unknown";

  function startSession(req, res, email) {
    const token = getStore().createSession(email);
    res.setHeader("set-cookie", cookieHeader(req, token, SESSION_TTL_MS / 1000));
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) throw new HttpError(403, "forbidden origin");
  }

  // ---- global guard ----
  // Fail closed: an app without a guard hook would leave every route open.
  if (typeof app.guard !== "function") throw new Error("auth: app.guard is required (src/api.mjs)");
  app.guard((req, { kind, path }) => {
    if (settings.disabled) return true;
    const mutating = kind === "ws" || (req.method !== "GET" && req.method !== "HEAD");
    if (mutating) checkOrigin(req);
    if (kind === "http" && (path.startsWith("/api/auth/") || path === "/api/auth" || path === "/api/health")) return true;
    if (kind === "http" && req.method === "GET" && app.ctx.previewAuthOk?.(path) === true) return true;
    if (!sessionOf(req)) throw new HttpError(401, "authentication required");
    return true;
  });

  // ---- password login with throttling ----
  const failures = new Map(); // "email|ip" -> number[] timestamps
  const recentFailures = (key) => {
    const list = (failures.get(key) ?? []).filter((t) => now() - t < FAIL_WINDOW_MS);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  };
  let dummyHash;

  app.get("/api/auth/me", (req) => {
    if (settings.disabled) return { email: "dev@local" };
    const s = sessionOf(req);
    if (!s) throw new HttpError(401, "not logged in");
    return { email: s.email };
  });

  app.post("/api/auth/login", async (req, res, { body }) => {
    if (settings.disabled) return { email: "dev@local" };
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    if (typeof b.email !== "string" || typeof b.password !== "string") throw new HttpError(401, LOGIN_ERROR);
    const email = normalizeEmail(b.email);
    const key = `${email}|${clientIp(req)}`;
    if (recentFailures(key).length >= FAIL_LIMIT) throw new HttpError(429, "too many failed attempts, try again later");
    let ok = false;
    if (settings.allowed.has(email)) {
      ok = await getStore().verifyPassword(email, b.password);
    } else {
      // Spend comparable time so allowlist membership is not observable by timing.
      dummyHash ??= await hashPassword("dummy-password");
      await verifyPasswordHash(b.password, dummyHash);
    }
    if (!ok) {
      const list = recentFailures(key);
      list.push(now());
      failures.set(key, list);
      throw new HttpError(401, LOGIN_ERROR);
    }
    failures.delete(key);
    startSession(req, res, email);
    return { email };
  });

  app.post("/api/auth/logout", (req, res) => {
    getStore().deleteSession(tokenOf(req));
    res.setHeader("set-cookie", cookieHeader(req, "", 0));
    return { ok: true };
  });

  // ---- Google OAuth (authorization code + PKCE) ----
  const oauthStates = new Map(); // state -> {verifier, nonce, expires}
  const redirectUri = () => `${settings.publicUrl}/api/auth/google/callback`;
  const redirect = (res, location) => {
    res.writeHead(302, { location, "cache-control": "no-store" });
    res.end();
  };
  const fail = (res, code) => redirect(res, `/?auth_error=${code}`);

  app.get("/api/auth/google", (_req, res) => {
    if (!settings.googleClientId || !settings.googleClientSecret) throw new HttpError(503, "google login is not configured");
    for (const [s, v] of oauthStates) if (v.expires <= now()) oauthStates.delete(s);
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    oauthStates.set(state, { verifier, nonce, expires: now() + STATE_TTL_MS });
    const url = new URL(GOOGLE_AUTH);
    url.search = new URLSearchParams({
      client_id: settings.googleClientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    redirect(res, url.toString());
  });

  app.get("/api/auth/google/callback", async (req, res, { query }) => {
    const entry = typeof query.state === "string" ? oauthStates.get(query.state) : undefined;
    if (entry) oauthStates.delete(query.state); // single use
    if (!entry || entry.expires <= now()) return fail(res, "state");
    if (!settings.googleClientId || !settings.googleClientSecret) return fail(res, "exchange");
    if (query.error || typeof query.code !== "string" || !query.code) return fail(res, "denied");
    let info;
    try {
      const tokenRes = await doFetch(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: query.code,
          client_id: settings.googleClientId,
          client_secret: settings.googleClientSecret,
          redirect_uri: redirectUri(),
          grant_type: "authorization_code",
          code_verifier: entry.verifier,
        }).toString(),
      });
      if (!tokenRes.ok) return fail(res, "exchange");
      const tok = await tokenRes.json();
      if (typeof tok?.access_token !== "string") return fail(res, "exchange");
      if (typeof tok.id_token === "string") {
        // Direct TLS response from Google's token endpoint; only the nonce binding is checked here.
        const payload = JSON.parse(Buffer.from(tok.id_token.split(".")[1] ?? "", "base64url").toString("utf8"));
        if (payload.nonce !== undefined && payload.nonce !== entry.nonce) return fail(res, "exchange");
      }
      const infoRes = await doFetch(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${tok.access_token}` } });
      if (!infoRes.ok) return fail(res, "exchange");
      info = await infoRes.json();
    } catch {
      return fail(res, "exchange");
    }
    const email = normalizeEmail(info?.email);
    if (info?.email_verified !== true || !email || !settings.allowed.has(email)) return fail(res, "denied");
    startSession(req, res, email);
    redirect(res, "/");
  });
}
