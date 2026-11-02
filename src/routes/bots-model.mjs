// Live model + thinking-level switch for a Bot session (composer selectors):
//
//   PATCH /api/bots/:id/model          {"modelId":"<id>"}    -> 200 {bot} | 400 | 404
//   PATCH /api/bots/:id/thinking-level {"level":"<level>"}   -> 200 {bot} | 400 | 404
//   GET   /api/bots/:id/thinking-levels                     -> 200 {levels:[…], current} | 404
//
// `modelId` must be one of the catalog ids (src/models.mjs MODEL_SPECS); `level` one of the levels the bot's
// current model accepts over the wire protocol (supportedThinkingLevels), or "off" = provider default (no
// reasoning_effort sent). `current` in the GET reads the durable agent itself, so it always matches what the
// next request will use; models without verified levels return `levels: []` (UI shows a disabled selector).
// The durable agent change applies at the next model request; a running round keeps its model and level.
// Sits behind the global auth guard like every /api route.
import { HttpError } from "../api.mjs";
import { ctx } from "../harness.mjs";
import { availableModelIds, supportedThinkingLevels } from "../models.mjs";

export function register(app) {
  const { bots } = app.ctx;
  if (!bots) {
    console.warn("routes/bots-model: app.ctx.bots is not set, model routes are not registered");
    return;
  }

  app.patch("/api/bots/:id/model", async (_req, _res, { params, body }) => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
    const modelId = body.modelId;
    if (typeof modelId !== "string" || !availableModelIds().includes(modelId)) {
      throw new HttpError(400, `modelId must be one of: ${availableModelIds().join(", ")}`);
    }
    const bot = await bots.setModel(String(params.id), modelId);
    if (!bot) throw new HttpError(404, `bot not found: ${params.id}`);
    return { bot };
  });

  app.patch("/api/bots/:id/thinking-level", async (_req, _res, { params, body }) => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
    const bot = bots.get(String(params.id));
    if (!bot) throw new HttpError(404, `bot not found: ${params.id}`);
    const level = body.level;
    const allowed = [...supportedThinkingLevels(bot.model?.modelId), "off"];
    if (typeof level !== "string" || !allowed.includes(level)) {
      throw new HttpError(400, `level must be one of: ${allowed.join(", ")}`);
    }
    const updated = await bots.setThinkingLevel(bot.id, level);
    if (!updated) throw new HttpError(404, `bot not found: ${params.id}`);
    return { bot: updated };
  });

  app.get("/api/bots/:id/thinking-levels", async (_req, _res, { params }) => {
    const bot = bots.get(String(params.id));
    if (!bot) throw new HttpError(404, `bot not found: ${params.id}`);
    const conv = await bots.conversation(bot.id);
    if (!conv) throw new HttpError(404, `conversation not found for bot: ${params.id}`);
    const agent = await conv.agent(ctx);
    // `current` is the effective level the next request will use (missing stored field resolves to "off").
    return { levels: supportedThinkingLevels(agent.model?.modelId), current: agent.thinkingLevel ?? "off" };
  });
}
