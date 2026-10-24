// POST /api/workspaces/:id/checkpoint   save a checkpoint of a ready workspace -> manifest
// GET  /api/workspaces/:id/checkpoints  manifests, newest first
// Needs app.ctx.checkpoints (createCheckpointService) and app.ctx.control (control store); skipped when either is missing.
// `app.ctx.runtimeBash(workspaceId)` (injected by M1-13) returns the bash primitive of the active binding's Sprite.
// Responses carry manifests only: no bundle content, no server paths.
import { HttpError } from "../api.mjs";

export function register(app) {
  const { checkpoints, control } = app.ctx;
  if (!checkpoints || !control) return;

  function workspaceOr404(id) {
    const ws = control.workspaces.get(id);
    if (!ws) throw new HttpError(404, `workspace not found: ${id}`);
    return ws;
  }

  app.post("/api/workspaces/:id/checkpoint", async (_req, _res, { params }) => {
    const ws = workspaceOr404(params.id);
    if (ws.status !== "ready") throw new HttpError(409, `workspace is not ready (status: ${ws.status})`);
    const binding = control.bindings.current(ws.id);
    if (!binding) throw new HttpError(409, "workspace has no active runtime binding");
    if (typeof app.ctx.runtimeBash !== "function") throw new HttpError(503, "runtime bash is not available");
    let bash;
    try {
      bash = await app.ctx.runtimeBash(ws.id);
    } catch (e) {
      throw new HttpError(409, `runtime unavailable: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    try {
      const rec = await checkpoints.save({ workspace: ws, bash, bindingVersion: binding.version });
      return { ...checkpoints.manifest(rec), unchanged: Boolean(rec.unchanged) };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, String(e?.message ?? e));
    }
  });

  app.get("/api/workspaces/:id/checkpoints", async (_req, _res, { params }) => {
    const ws = workspaceOr404(params.id);
    return checkpoints.list(ws.id).map((c) => checkpoints.manifest(c));
  });
}
