// Inbound webhook routes (idea 8). SECURITY: these are the only unauthenticated API routes besides /api/auth and
// /api/health — the per-bot token in the path is the credential. routes/auth.mjs explicitly allow-lists the exact
// delivery path /api/hooks/:botId/:token (checked there before the origin check, since senders are not browsers);
// management routes below stay behind the session guard. Unknown tokens 404 so tokens cannot be enumerated.
//
//   POST /api/hooks/:botId/:token    delivery (no session; token-checked, optional GitHub HMAC)
//   GET  /api/hooks                  (authed) list hook registrations
//   POST /api/hooks/:botId           (authed) mint/return the bot's hook token
import { HttpError } from "../api.mjs";
import { deliverHook, ensureHookToken, listHooks, verifyGithubSignature } from "../ext/hooks.mjs";

export function register(app, opts = {}) {
  const { harness, bots } = app.ctx;
  const secretOf = opts.secretOf ?? (() => process.env.TARSBOT_HOOK_SECRET);

  app.post("/api/hooks/:botId/:token", async (_req, _res, { params, query, body, rawBody }) => {
    const bot = bots.get(params.botId);
    if (!bot) throw new HttpError(404, "not found");
    const rawText = typeof rawBody === "string" ? rawBody : body === undefined ? "" : JSON.stringify(body);
    if (rawText.length > 256 * 1024) throw new HttpError(413, "webhook body too large");
    const source = String(query.source ?? (sourceOfHeader(_req) ? "github" : "generic"));
    const event = eventHeader(_req) ?? query.event ?? undefined;
    if (source === "github" || event !== undefined) {
      const secret = secretOf(bot.id);
      if (!verifyGithubSignature(secret, signatureHeader(_req), Buffer.from(rawText, "utf8"))) {
        throw new HttpError(401, "bad signature");
      }
    }
    const result = await deliverHook({ harness }, {
      conversationId: bot.conversationId,
      token: params.token,
      source,
      event,
      action: body?.action ?? undefined,
      requestId: requestId(_req) ?? body?.delivery ?? undefined,
      rawBody: rawText,
      payload: body,
    });
    if (!result.delivered) {
      // Duplicates answer 200 with a marker (webhook senders retry hard on 4xx); unknown tokens still 404.
      if (result.reason === "unknown hook token") throw new HttpError(404, "not found");
      return { ok: true, duplicate: true };
    }
    return { ok: true, submissionId: result.submissionId };
  });

  // ---- authed management ----
  app.get("/api/hooks", async () => listHooks(harness));

  app.post("/api/hooks/:botId", async (_req, _res, { params }) => {
    const bot = bots.get(params.botId);
    if (!bot) throw new HttpError(404, `bot not found: ${params.botId}`);
    const token = await ensureHookToken(harness, bot.conversationId);
    return { botId: bot.id, conversationId: bot.conversationId, token, url: `/api/hooks/${bot.id}/${token}` };
  });
}

const header = (req, name) => {
  const v = req?.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
};
const eventHeader = (req) => header(req, "x-github-event");
const signatureHeader = (req) => header(req, "x-hub-signature-256");
const requestId = (req) => header(req, "x-request-id");
const sourceOfHeader = (req) => eventHeader(req) !== undefined;
