// Env-var routes (ENV-DEMO): masked management API for workspace defaults + per-session overrides.
//
//   GET    /api/workspaces/:id/env                        -> {enabled, vars:[{name, masked, updatedAt}]}
//   POST   /api/workspaces/:id/env/:name {value}          -> {name, masked, updatedAt}   (value is write-only)
//   POST   /api/workspaces/:id/env/:name/remove           -> {removed}                    (no DELETE verb in the router)
//   GET    /api/bots/:id/env                              -> {enabled, restricted, entries:[{name, mode, masked, inherits}]}
//   POST   /api/bots/:id/env/:name {mode: "set"|"disabled"|"inherit", value?}
//                                                         -> {name, mode, masked}
//
// Values are never returned: GET responses carry names, sources and masked state only. Writes go through the
// env service (AES-GCM ciphertext in the control db; TARSBOT_ENV_KEY required or every write is a 503).
// Every route sits behind the global auth guard (src/routes/auth.mjs); bot-scoped routes verify the session
// actually belongs to the workspace it claims (store-side check, a cross-workspace botId is a 409).
import { HttpError } from "../api.mjs";
import { EnvConfigError } from "../env-config.mjs";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function mapError(e) {
  if (e instanceof HttpError) return e;
  if (e instanceof EnvConfigError) {
    switch (e.code) {
      case "invalid":
        return new HttpError(400, e.message);
      case "not_found":
        return new HttpError(404, e.message);
      case "conflict":
        return new HttpError(409, e.message);
      case "disabled":
        return new HttpError(503, e.message);
      default:
        return e;
    }
  }
  return e;
}

const jsonObject = (body) => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  return body ?? {};
};

const nameParam = (params) => {
  const name = String(params.name ?? "");
  if (!ENV_NAME_RE.test(name)) throw new HttpError(400, `环境变量名不合法：${name.slice(0, 64)}`);
  return name;
};

export function register(app) {
  const { workspaces, control, bots, envService } = app.ctx;
  if (!workspaces || !control || !envService) {
    console.warn("routes/env-vars: app.ctx.workspaces / control / envService is not set, env-var routes are not registered");
    return;
  }

  const workspaceOr404 = (id) => {
    const ws = workspaces.get(id);
    if (!ws) throw new HttpError(404, `workspace not found: ${id}`);
    return ws;
  };

  const botFor = (botId) => {
    const bot = bots?.get(String(botId ?? ""));
    if (!bot) throw new HttpError(404, `session not found: ${botId}`);
    return bot;
  };

  // ---- workspace defaults ----
  app.get("/api/workspaces/:id/env", async (_req, _res, { params }) => {
    workspaceOr404(params.id);
    try {
      return envService.listWorkspace(params.id);
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/workspaces/:id/env/:name", async (_req, _res, { params, body }) => {
    workspaceOr404(params.id);
    const b = jsonObject(body);
    if (typeof b.value !== "string") throw new HttpError(400, "value must be a string (an empty string is a valid value)");
    try {
      const row = envService.setWorkspaceVar(params.id, nameParam(params), b.value);
      return { name: row.name, masked: true, updatedAt: row.updatedAt };
    } catch (e) {
      throw mapError(e);
    }
  });

  // No DELETE verb in the router (see routes/integrations.mjs): removal is POST .../remove.
  app.post("/api/workspaces/:id/env/:name/remove", async (_req, _res, { params }) => {
    workspaceOr404(params.id);
    try {
      envService.removeWorkspaceVar(params.id, nameParam(params));
      return { removed: true };
    } catch (e) {
      throw mapError(e);
    }
  });

  // ---- session overrides ----
  // The session's workspace is resolved from the control store link — never from a client-supplied id.
  app.get("/api/bots/:id/env", async (_req, _res, { params }) => {
    const bot = botFor(params.id);
    try {
      const link = control.links.workspaceOf(String(bot.conversationId));
      if (!link) throw new HttpError(409, `session ${params.id} has no linked workspace`);
      return envService.listSession({ workspaceId: link.id, bot });
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/bots/:id/env/:name", async (_req, _res, { params, body }) => {
    const bot = botFor(params.id);
    const b = jsonObject(body);
    const mode = typeof b.mode === "string" ? b.mode : "";
    if (!["set", "disabled", "inherit"].includes(mode)) throw new HttpError(400, 'mode must be one of: set | disabled | inherit');
    if (mode === "set" && typeof b.value !== "string") throw new HttpError(400, "value must be a string for mode=set");
    try {
      const link = control.links.workspaceOf(String(bot.conversationId));
      if (!link) throw new HttpError(409, `session ${params.id} has no linked workspace`);
      const out = envService.setSessionVar({ workspaceId: link.id, bot, name: nameParam(params), mode, value: b.value });
      return { name: out.name, mode: out.mode, masked: out.mode === "set" };
    } catch (e) {
      throw mapError(e);
    }
  });
}
