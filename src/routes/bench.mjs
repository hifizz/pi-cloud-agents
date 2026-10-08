// Benchmark helper routes (Task 15).
//   GET  /api/bench/health                        → {ok:true}
//   POST /api/bench/bots {name, modelId, tools[]} → the new Bot record, with agent tools narrowed to exactly `tools`.
// Tool objects are resolved through the new Bot's own agent (same approach as BotRegistry.forkBot).
import { HttpError } from "../api.mjs";
import { config, defaultModel } from "../config.mjs";
import { ctx } from "../harness.mjs";

export function register(app) {
  const { bots } = app.ctx;

  app.get("/api/bench/health", () => ({ ok: true }));

  app.post("/api/bench/bots", async (_req, _res, { body }) => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
    const { name, modelId, tools, instructions } = body;
    if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "name is required");
    if (modelId !== undefined && typeof modelId !== "string") throw new HttpError(400, "modelId must be a string");
    if (instructions !== undefined && typeof instructions !== "string") throw new HttpError(400, "instructions must be a string");
    if (!Array.isArray(tools) || tools.length === 0 || tools.some((t) => typeof t !== "string")) {
      throw new HttpError(400, "tools must be a non-empty array of tool names");
    }
    if (bots.get(name.trim())) throw new HttpError(409, `bot exists: ${name}`);

    const bot = await bots.createBot({
      name: name.trim(),
      model: modelId ? { provider: config.provider, modelId } : defaultModel(),
      ...(instructions ? { instructions } : {}),
    });
    const conv = await bots.conversation(bot.id);
    const resolved = await conv.agent(ctx);
    const byName = new Map(resolved.tools.map((t) => [t.name, t]));
    const missing = tools.filter((n) => !byName.has(n));
    if (missing.length) throw new HttpError(400, `unknown tools (bot ${bot.name} was created with all tools): ${missing.join(", ")}`);
    await conv.configure({ tools: tools.map((n) => byName.get(n)) }, ctx);
    const after = await conv.agent(ctx);
    return { ...bot, tools: after.tools.map((t) => t.name) };
  });
}
