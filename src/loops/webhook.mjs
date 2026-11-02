// Loop webhook credentials (Issue14 Phase1): machine authentication for POST /api/loops/:id/webhook.
//
// Two accepted credential forms (either is sufficient):
//   1. Authorization: Bearer <secret>   — verified against the loop's stored scrypt hash (verifyPasswordHash gives
//      constant-time comparison on equal-length digests; a wrong-length or malformed secret fails closed).
//   2. Standard Webhooks signature: headers `webhook-id`, `webhook-timestamp`, `webhook-signature` ("v1,<b64> ..."),
//      HMAC-SHA256 over "<id>.<ts>.<rawBody>" with the server-side key TARSBOT_LOOPS_WEBHOOK_HMAC_KEY.
//      HMAC needs the raw secret: it CANNOT be verified from an irreversible hash, so the key comes from the
//      environment (not the per-loop stored hash). Missing env -> that path is 503, never a fake success.
//
// The raw body is read ONCE here (capped), before any JSON parsing or side effect, and stashed on req.machineBody
// for the route. Timestamp skew beyond 5 minutes is rejected; signature comparison uses timingSafeEqual.
import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../api.mjs";
import { verifyPasswordHash } from "../auth.mjs";

export const MAX_WEBHOOK_BODY = 64 * 1024;
const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const SW_VERSION = "v1";

/** Read the request body capped at `limit`; throws 413. Runs before any parsing or side effect. */
export async function readRaw(req, limit = MAX_WEBHOOK_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "webhook body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const bearerSecret = (req) => {
  const h = String(req.headers["authorization"] ?? "");
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m?.[1]?.trim() || undefined;
};

function standardWebhookParts(req) {
  const id = req.headers["webhook-id"];
  const ts = req.headers["webhook-timestamp"];
  const sig = req.headers["webhook-signature"];
  if (!id || !ts || !sig) return undefined;
  return { id: String(id), timestamp: Number(ts), signatures: String(sig).split(" ").filter(Boolean) };
}

/** Verify a Standard Webhooks signature. `key` is the raw HMAC material (base64 or utf8 string). */
export function verifyStandardSignature({ id, timestamp, signatures }, rawBody, key, { now = Date.now } = {}) {
  if (!key) return false;
  if (!Number.isFinite(timestamp)) return false;
  const tsMs = timestamp > 1e12 ? timestamp : timestamp * 1000; // spec uses seconds; tolerate ms
  if (Math.abs(now() - tsMs) > TIMESTAMP_SKEW_MS) return false;
  const keyBytes = /^[A-Za-z0-9+/=_-]+$/.test(key) && key.length > 24 ? Buffer.from(key, "base64") : Buffer.from(key, "utf8");
  const expected = createHmac("sha256", keyBytes).update(`${id}.${Math.floor(tsMs / 1000)}.`).update(rawBody).digest();
  for (const candidate of signatures) {
    const [version, b64] = candidate.split(",", 2);
    if (version !== SW_VERSION || !b64) continue;
    let got;
    try {
      got = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/**
 * Verify the machine credentials of one webhook request against a loop record.
 * `rawBody` is the exact request bytes (read once by the caller before anything else).
 * Throws HttpError(401) on any failure, 503 when a credential path's server material is missing.
 * Returns {via: "bearer"|"standard", webhookId?: string} on success — webhookId is the dedup key.
 */
export async function verifyWebhookCredentials(req, loop, rawBody, { env = process.env, now = Date.now } = {}) {
  if (!loop) throw new HttpError(404, "loop not found");
  if (loop.trigger?.kind !== "webhook") throw new HttpError(404, "loop has no webhook trigger");

  const sw = standardWebhookParts(req);
  if (sw) {
    const key = env.TARSBOT_LOOPS_WEBHOOK_HMAC_KEY;
    if (!key) throw new HttpError(503, "standard webhooks verification is not configured (TARSBOT_LOOPS_WEBHOOK_HMAC_KEY)");
    if (!verifyStandardSignature(sw, rawBody, key, { now })) throw new HttpError(401, "invalid webhook signature");
    return { via: "standard", webhookId: sw.id };
  }

  const secret = bearerSecret(req);
  if (secret) {
    if (!loop.webhookSecretHash) throw new HttpError(503, "loop has no webhook secret stored");
    const ok = await verifyPasswordHash(secret, loop.webhookSecretHash);
    if (!ok) throw new HttpError(401, "invalid webhook secret");
    const id = req.headers["webhook-id"];
    return { via: "bearer", webhookId: id ? String(id) : undefined };
  }

  throw new HttpError(401, "webhook credentials required");
}

/** Simple in-process rate limiter for the webhook edge: `limit` requests per `windowMs` per key. */
export function createRateLimiter({ limit = 60, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= limit) {
      hits.set(key, list);
      return false;
    }
    list.push(t);
    hits.set(key, list);
    return true;
  };
}
