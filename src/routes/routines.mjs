// Routine routes (F06).
//   GET  /api/routines                 -> [{ id, bot, botId, prompt, everyMs|atTimes, enabled, status, nextAt, lastFiredAt, fireCount, recent }]
//   POST /api/routines {bot, prompt, everyMs | atTimes}   bot = id or name
//   POST /api/routines/:id/cancel      (no DELETE support in the router)
import { HttpError } from "../api.mjs";
import { cancelRoutine, createRoutine, listRoutines } from "../ext/routines.mjs";

const MIN_EVERY_MS = 1000;

export function register(app) {
  const { harness, bots } = app.ctx;

  const view = (r) => {
    const bot = bots.list().find((b) => b.conversationId === r.botConversationId);
    return { ...r, bot: bot?.name ?? null, botId: bot?.id ?? null };
  };

  app.get("/api/routines", async () => (await listRoutines(harness)).map(view));

  app.post("/api/routines", async (_req, _res, { body }) => {
    const b = body ?? {};
    if (typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "body must be a JSON object");
    if (typeof b.bot !== "string" || !b.bot) throw new HttpError(400, "bot is required");
    if (typeof b.prompt !== "string" || !b.prompt.trim()) throw new HttpError(400, "prompt is required");
    const hasEvery = b.everyMs !== undefined && b.everyMs !== null;
    const hasAt = b.atTimes !== undefined && b.atTimes !== null;
    if (hasEvery === hasAt) throw new HttpError(400, "exactly one of everyMs or atTimes is required");
    if (hasEvery && !(typeof b.everyMs === "number" && Number.isFinite(b.everyMs) && b.everyMs >= MIN_EVERY_MS)) {
      throw new HttpError(400, `everyMs must be a number >= ${MIN_EVERY_MS}`);
    }
    const bot = bots.get(b.bot);
    if (!bot) throw new HttpError(404, `bot not found: ${b.bot}`);
    try {
      const created = await createRoutine(harness, {
        botConversationId: bot.conversationId,
        prompt: b.prompt,
        ...(hasEvery ? { everyMs: b.everyMs } : { atTimes: b.atTimes }),
      });
      return view(created);
    } catch (e) {
      throw new HttpError(400, String(e?.message ?? e));
    }
  });

  app.post("/api/routines/:id/cancel", async (_req, _res, { params }) => {
    const ok = await cancelRoutine(harness, params.id);
    if (!ok) throw new HttpError(404, `routine not found: ${params.id}`);
    return { ok: true, id: params.id };
  });
}
