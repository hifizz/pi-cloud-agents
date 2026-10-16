// Authentication core: config from env, sqlite store (users + sessions), scrypt password hashing.
// Storage is <dataDir>/auth.sqlite, separate from pi-durable's sqlite. Secrets (passwords, session tokens,
// OAuth secrets) are never logged; sessions are stored only as sha256 hashes.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { config } from "./config.mjs";

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltLen: 16 };
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
export const MIN_PASSWORD_LENGTH = 12;

/** "A@x.com, b@y.com,," -> Set{"a@x.com","b@y.com"} */
export function parseAllowlist(raw) {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

/** Read all auth settings from an env bag. Throws when auth is disabled on a non-loopback host. */
export function authSettings(env = process.env) {
  const disabled = env.TARSBOT_AUTH_DISABLED === "1";
  const host = env.TARSBOT_HOST ?? "127.0.0.1";
  if (disabled && !LOOPBACK_HOSTS.includes(host)) {
    throw new Error(`TARSBOT_AUTH_DISABLED=1 is only allowed on a loopback host (TARSBOT_HOST=${host})`);
  }
  return {
    disabled,
    host,
    allowed: parseAllowlist(env.TARSBOT_ALLOWED_EMAILS),
    publicUrl: (env.TARSBOT_PUBLIC_URL || "http://127.0.0.1:8090").replace(/\/+$/, ""),
    publicUrlSet: Boolean(env.TARSBOT_PUBLIC_URL),
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
  };
}

export async function hashPassword(password) {
  const salt = randomBytes(SCRYPT.saltLen);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPasswordHash(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger)) return false;
  try {
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    const actual = await scryptAsync(password, salt, expected.length, { N, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** @param {{dataDir?: string, now?: () => number}} [opts] */
export function openAuthStore({ dataDir = config.dataDir, now = Date.now } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "auth.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, password_hash TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, email TEXT, created_at INTEGER, expires_at INTEGER);`);
  const getUser = db.prepare("SELECT password_hash FROM users WHERE email = ?");
  const upsertUser = db.prepare(
    "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash",
  );
  const insertSession = db.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)");
  const getSession = db.prepare("SELECT email, expires_at FROM sessions WHERE token_hash = ?");
  const delSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");

  return {
    async setPassword(email, password) {
      upsertUser.run(normalizeEmail(email), await hashPassword(password), now());
    },
    /** Resolves true only when the user exists and the password matches. */
    async verifyPassword(email, password) {
      const row = getUser.get(normalizeEmail(email));
      return verifyPasswordHash(password, row?.password_hash);
    },
    /** @returns {string} the raw session token (only its sha256 is stored) */
    createSession(email) {
      const token = randomBytes(32).toString("base64url");
      const t = now();
      insertSession.run(sha256(token), normalizeEmail(email), t, t + SESSION_TTL_MS);
      return token;
    },
    /** @returns {{email: string} | null}; expired rows are deleted lazily */
    getSession(token) {
      if (!token) return null;
      const h = sha256(token);
      const row = getSession.get(h);
      if (!row) return null;
      if (row.expires_at <= now()) {
        delSession.run(h);
        return null;
      }
      return { email: row.email };
    },
    deleteSession(token) {
      if (token) delSession.run(sha256(token));
    },
    /** Test hook: expire every session. */
    _expireAll() {
      db.exec("UPDATE sessions SET expires_at = 0");
    },
    close() {
      db.close();
    },
  };
}
