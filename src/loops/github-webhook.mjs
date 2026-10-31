// GitHub App webhook verification (Issue14 Phase2) — machine auth inside the global guard.
// Verifies X-Hub-Signature-256 ("sha256=<hmac hex>") over the RAW request body with
// TARSBOT_GITHUB_WEBHOOK_SECRET; constant-time compare; body capped and read once. Missing env -> 503,
// bad signature -> 401, both inside the guard so the route is never reached. X-GitHub-Delivery gives the
// replay key; the event's canonical key gives cross-channel dedup.
import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../api.mjs";
import { readRaw } from "./webhook.mjs";

export const MAX_GITHUB_BODY = 256 * 1024; // GitHub deliveries can carry full diff metadata

/**
 * Verify a GitHub webhook request. Reads the raw body (capped) inside the guard and stashes it on
 * req.machineBody; validates the HMAC signature and returns {deliveryId, event} on success.
 * @param {Request} req
 * @param {{ env?: object }} [opts]
 * @returns {{deliveryId: string, event: string}}
 */
export async function verifyGithubWebhook(req, { env = process.env } = {}) {
  const secret = env.TARSBOT_GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "github webhook is not configured (TARSBOT_GITHUB_WEBHOOK_SECRET)");
  const event = String(req.headers["x-github-event"] ?? "").trim();
  if (!event) throw new HttpError(400, "missing X-GitHub-Event");
  const deliveryId = String(req.headers["x-github-delivery"] ?? "").trim();
  if (!deliveryId) throw new HttpError(400, "missing X-GitHub-Delivery");
  const raw = await readRaw(req, MAX_GITHUB_BODY);
  req.machineBody = raw;

  const header = String(req.headers["x-hub-signature-256"] ?? "");
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) throw new HttpError(401, "invalid X-Hub-Signature-256");
  const expected = createHmac("sha256", secret).update(raw).digest();
  let got;
  try {
    got = Buffer.from(m[1], "hex");
  } catch {
    throw new HttpError(401, "invalid X-Hub-Signature-256");
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new HttpError(401, "invalid webhook signature");
  }
  return { deliveryId, event };
}
