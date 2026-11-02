// Integrations routes (AMP13-integrations, revised): install / enable / disable / uninstall Skills and
// MCP endpoints FOR THE PI AGENT, scoped to one workspace.
//
//   GET  /api/integrations                                        -> capabilities + Slack status (not implemented)
//   GET  /api/workspaces/:id/integrations                         -> installs of THIS workspace
//   GET  /api/workspaces/:id/integrations/skills?bot=<botId>      -> SKILL.md files in the session dir
//   POST /api/workspaces/:id/integrations/skills/read             {bot, path} -> file preview (install source)
//   POST /api/workspaces/:id/integrations                         {kind:"skill", name?, description?, content}
//                                                                 {kind:"skill-file", bot, path, name?, description?}
//                                                                 {kind:"mcp", name, url, tokenEnv?}
//   POST /api/workspaces/:id/integrations/:iid/enable             {enabled: true|false}
//   POST /api/workspaces/:id/integrations/:iid/uninstall          (no DELETE verb in the router)
//   GET  /api/workspaces/:id/integrations/:iid                    -> record (+ skill content preview)
//
// Boundaries:
//  - Installs are stored by the service (dataDir/integrations.json), workspace-scoped. Enable/disable/
//   uninstall reconfigure every linked session (conv.configure) and publish/unpublish the dynamic MCP
//   extension — busy sessions pick the new tool set up at the next model request, reported as such.
//  - MCP: the user supplies a named public http(s) endpoint (+ optional env var NAME for a Bearer token);
//    the service runs the SSRF checks (public URL, public DNS answer, redirects refused) and a REAL
//    initialize + tools/list before recording. Plaintext secrets are never accepted or stored.
//  - Skills: content is an explicit snapshot (uploaded text or a workspace file read through runtimeBash);
//    nothing is executed, no user-message pseudo-install, no repo file is touched by uninstall.
import { HttpError } from "../api.mjs";
import { ctx } from "../harness.mjs";
import { getIntegrationsService } from "../ext/integrations.mjs";
import { listWorkspaceSkillFiles, readWorkspaceSkillFile, MCP_PROTOCOL_VERSION, SKILL_DIRS } from "../integrations.mjs";

function mapError(e) {
  if (e instanceof HttpError) return e;
  switch (e?.code) {
    case "invalid":
      return new HttpError(400, e.message);
    case "not_found":
      return new HttpError(404, e.message);
    case "conflict":
      return new HttpError(409, e.message);
    case "upstream":
      return new HttpError(502, e.message);
    default:
      return e;
  }
}

let warned = false;

export function register(app) {
  const { workspaces, control, bots, runtimeBash, integrations } = app.ctx;
  const service = integrations ?? getIntegrationsService();
  if (!workspaces || !control || !bots || !service) {
    if (!warned) {
      warned = true;
      console.warn("routes/integrations: app.ctx.workspaces / control / bots / integrations service is not set, integration routes are not registered");
    }
    return;
  }

  function jsonObject(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
    return body ?? {};
  }

  function workspaceOr404(id) {
    const ws = workspaces.get(id);
    if (!ws) throw new HttpError(404, `workspace not found: ${id}`);
    return ws;
  }

  /** Resolve the bot's real session directory (server-side, never a client path) + the workspace bash. */
  async function sessionDir(wsId, botId) {
    const ws = workspaceOr404(wsId);
    if (ws.status !== "ready") throw new HttpError(409, `workspace is not ready (status: ${ws.status})`);
    if (!control.bindings.current(ws.id)) throw new HttpError(409, "workspace has no active runtime binding");
    if (typeof runtimeBash !== "function") throw new HttpError(503, "runtime bash is not available");
    const bot = bots.get(String(botId ?? ""));
    if (!bot) throw new HttpError(404, `bot not found: ${botId}`);
    const link = control.links.workspaceOf(String(bot.conversationId));
    if (!link || link.id !== ws.id) throw new HttpError(409, `session ${botId} does not belong to workspace ${ws.id}`);
    const dir = bot.issueLoop?.dir ?? bot.review?.dir ?? bot.worktree?.dir ?? bot.loopRun?.dir ?? ws.cwd;
    if (typeof dir !== "string" || !dir) throw new HttpError(409, "session directory could not be determined");
    let bash;
    try {
      bash = await runtimeBash(ws.id);
    } catch (e) {
      throw new HttpError(409, `runtime unavailable: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    return { ws, bot, dir, bash };
  }

  // GET /api/integrations — honest capability report.
  app.get("/api/integrations", async () => ({
    kinds: ["skill", "skill-file", "mcp"],
    mcp: { protocolVersion: MCP_PROTOCOL_VERSION, transport: "streamable-http", oauth: false, note: "minimal JSON-RPC client, not the full SDK" },
    skills: { scanDirs: SKILL_DIRS, file: "SKILL.md" },
    slack: { implemented: false, reason: "Slack 集成未配置、未实现（无凭据与通道配置）；此处仅说明状态，没有入口。" },
  }));

  app.get("/api/workspaces/:id/integrations", async (_req, _res, { params }) => {
    workspaceOr404(params.id);
    return { installs: service.installs.list(params.id) };
  });

  // ---- skills inside the session dir (install source, not the store) -------------------------------------------------
  // Registered BEFORE /integrations/:iid so "skills" can never match a record id.

  app.get("/api/workspaces/:id/integrations/skills", async (_req, _res, { params, query }) => {
    const { dir, bash } = await sessionDir(params.id, query.bot);
    try {
      return { skills: await listWorkspaceSkillFiles(bash, dir), dir };
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/workspaces/:id/integrations/skills/read", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const { dir, bash } = await sessionDir(params.id, b.bot);
    try {
      const content = await readWorkspaceSkillFile(bash, dir, b.path);
      const name = String(b.path).split("/").slice(0, -1).pop() || String(b.path);
      return { skill: { path: b.path, name, content } };
    } catch (e) {
      throw mapError(e);
    }
  });

  app.get("/api/workspaces/:id/integrations/:iid", async (_req, _res, { params }) => {
    workspaceOr404(params.id);
    const install = service.installs.get(params.iid);
    if (!install || install.workspaceId !== params.id) throw new HttpError(404, `integration not found: ${params.iid}`);
    const out = { install };
    if (install.kind === "skill") {
      try {
        out.content = service.installs.skillContent(params.iid, params.id);
      } catch (e) {
        throw mapError(e);
      }
    }
    return out;
  });

  // ---- install -----------------------------------------------------------------------------------------------------

  app.post("/api/workspaces/:id/integrations", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const ws = workspaceOr404(params.id);
    try {
      if (b.kind === "skill") {
        const install = service.installSkill({ workspaceId: ws.id, name: b.name, description: b.description, content: b.content, source: { type: "upload" } });
        return { install: service.installs.get(install.id), applied: await service.applyInstallDelta(ws.id, { add: [install] }) };
      }
      if (b.kind === "skill-file") {
        const { dir, bash } = await sessionDir(ws.id, b.bot);
        const path = typeof b.path === "string" ? b.path : "";
        const content = await readWorkspaceSkillFile(bash, dir, path);
        const install = service.installSkill({
          workspaceId: ws.id,
          name: b.name,
          description: b.description,
          content,
          source: { type: "workspace-file", path },
        });
        return { install: service.installs.get(install.id), applied: await service.applyInstallDelta(ws.id, { add: [install] }) };
      }
      if (b.kind === "mcp") {
        const install = await service.installMcp({ workspaceId: ws.id, name: b.name, url: b.url, tokenEnv: b.tokenEnv });
        return { install: service.installs.get(install.id), applied: await service.applyInstallDelta(ws.id, { add: [install] }) };
      }
      throw new HttpError(400, "kind must be one of: skill, skill-file, mcp");
    } catch (e) {
      throw mapError(e);
    }
  });

  // ---- lifecycle -----------------------------------------------------------------------------------------------------

  app.post("/api/workspaces/:id/integrations/:iid/enable", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
    workspaceOr404(params.id);
    try {
      const install = service.setEnabled(params.iid, params.id, b.enabled);
      const applied = await service.applyInstallDelta(params.id, b.enabled ? { add: [install] } : { remove: [install] });
      return { install, applied };
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/workspaces/:id/integrations/:iid/uninstall", async (_req, _res, { params }) => {
    workspaceOr404(params.id);
    try {
      const install = service.uninstall(params.iid, params.id);
      const applied = await service.applyInstallDelta(params.id, { remove: [install] });
      return { removed: { id: install.id, name: install.name, kind: install.kind }, applied };
    } catch (e) {
      throw mapError(e);
    }
  });
}
