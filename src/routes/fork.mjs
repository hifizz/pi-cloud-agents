// POST /api/bots/:id/fork {entryId?, name, modelId?, readOnly?, instructions?} → the new Bot record (REQ-F07).
import { HttpError } from "../api.mjs";

function optString(obj, key) {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
  return v;
}

/** Durable entry ids are positive integers; accept a number or a numeric string. */
function optEntryId(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, "entryId must be a positive integer");
  return n;
}

export function register(app) {
  const { bots } = app.ctx;

  app.post("/api/bots/:id/fork", async (_req, _res, { params, body }) => {
    if (!bots.get(params.id)) throw new HttpError(404, `bot not found: ${params.id}`);
    if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) {
      throw new HttpError(400, "body must be a JSON object");
    }
    const b = body ?? {};
    const name = optString(b, "name")?.trim();
    if (!name) throw new HttpError(400, "name is required");
    const entryId = optEntryId(b.entryId);
    const modelId = optString(b, "modelId");
    const instructions = optString(b, "instructions");
    if (b.readOnly !== undefined && typeof b.readOnly !== "boolean") throw new HttpError(400, "readOnly must be a boolean");
    if (bots.get(name)) throw new HttpError(409, `bot exists: ${name}`);
    try {
      return await bots.forkBot(params.id, {
        name,
        ...(entryId ? { entryId } : {}),
        ...(modelId ? { modelId } : {}),
        ...(instructions ? { instructions } : {}),
        ...(b.readOnly ? { readOnly: true } : {}),
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // Unknown or invisible entry ids and empty histories are caller errors.
      if (/no history|entry/i.test(String(e?.message))) throw new HttpError(400, String(e.message));
      throw e;
    }
  });
}
