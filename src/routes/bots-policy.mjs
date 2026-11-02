// Per-session approval policy (composer permission selector):
//
//   PATCH /api/bots/:id/approval-policy {"policy":"ask"|"auto"|"bypass"} -> 200 {bot} | 400 | 404
//
// "ask" (default; records without the field) parks dangerous tool calls in the approval center.
// "auto" lets the Approval hook memo an approval for recoverable (non-hard) classifications only.
// "bypass" lets the Approval hook memo an approval for every dangerous call.
// Sits behind the global auth guard like every /api route.
import { HttpError } from "../api.mjs";

const POLICIES = new Set(["ask", "auto", "bypass"]);

export function register(app) {
  const { bots } = app.ctx;
  if (!bots) {
    console.warn("routes/bots-policy: app.ctx.bots is not set, approval-policy route is not registered");
    return;
  }

  app.patch("/api/bots/:id/approval-policy", async (_req, _res, { params, body }) => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
    const policy = body.policy;
    if (typeof policy !== "string" || !POLICIES.has(policy)) throw new HttpError(400, 'policy must be "ask", "auto" or "bypass"');
    const bot = bots.update(String(params.id), { approvalPolicy: policy });
    if (!bot) throw new HttpError(404, `bot not found: ${params.id}`);
    return { bot };
  });
}
