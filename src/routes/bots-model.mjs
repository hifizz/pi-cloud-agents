// Live model switch for a Bot session (composer model selector):
//
//   PATCH /api/bots/:id/model {"modelId":"<id>"} -> 200 {bot} | 400 | 404
//
// `modelId` must be one of the catalog ids (src/models.mjs MODEL_SPECS). The durable agent change applies at the
// next model request; a running round keeps its model. Sits behind the global auth guard like every /api route.
import { HttpError } from "../api.mjs";
import { availableModelIds } from "../models.mjs";

export function register(app) {
  const { bots } = app.ctx;
  if (!bots) {
    console.warn("routes/bots-model: app.ctx.bots is not set, model route is not registered");
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
}
