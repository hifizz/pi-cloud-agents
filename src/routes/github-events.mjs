// AMP13-events routes (authenticated like everything else — no public webhook):
//   GET  /api/workspaces/:id/events                -> public sync state (enabled, lastSyncAt, nextSyncAt, record,
//                                                     subscriptions, per-PR check rollups, lastError)
//   POST /api/workspaces/:id/events/configure      {enabled?, autoCreate?, autoAppend?, pollSec?} -> state
//   POST /api/workspaces/:id/events/sync           -> state after one manual sync ("立即同步")
//   POST /api/workspaces/:id/events/send           {eventId, botId} -> {sent, botId, name}
//   POST /api/workspaces/:id/events/subscribe      {target: "issue:12"|"pr:34", botId} -> state
//   POST /api/workspaces/:id/events/disable        -> state
// Background polling: enabled workspaces poll the authenticated events feed on an in-process timer
// (default 60s, `pollSec` per workspace, clamped 15..3600). Parent server calls `service.startPolling()` once at
// startup (resumes all persisted `enabled` states) and `service.close()` at shutdown (clears every timer). The
// created service is also parked on app.ctx.githubEvents so nothing else needs wiring.
// Needs app.ctx.control + app.ctx.github + app.ctx.bots; reuses app.ctx.workspaceSessions (exposed by
// routes/workspaces.mjs) for auto-created sessions. When a dependency is missing the routes are not registered
// (one console.warn), like every other plugin. No token ever reaches a response; service errors carry codes.
import { HttpError } from "../api.mjs";
import { ctx } from "../harness.mjs";
import { config } from "../config.mjs";
import { createGithubEventsService, EventsError } from "../github-events.mjs";
import { mapGithubError } from "./github.mjs";

let warned = false;

function mapError(e) {
  if (e instanceof HttpError) return e;
  const g = mapGithubError(e);
  if (g !== e) return g;
  switch (e?.code) {
    case "invalid":
      return new HttpError(400, e.message);
    case "not_found":
      return new HttpError(404, e.message);
    case "conflict":
      return new HttpError(409, e.message);
    case "unavailable":
      return new HttpError(503, e.message);
    default:
      return e;
  }
}

export function register(app) {
  const { control, github, bots } = app.ctx;
  if (!control || !github || !bots) {
    if (!warned) {
      warned = true;
      console.warn("routes/github-events: app.ctx.control / github / bots is not set, event routes are not registered");
    }
    return;
  }

  const submit = async (botId, text) => {
    const conv = await bots.conversation(botId);
    if (!conv) throw new EventsError("not_found", `conversation not found for session ${botId}`);
    await conv.submit({ type: "input", content: text }, ctx);
  };

  const service = createGithubEventsService({
    dataDir: app.ctx.dataDir ?? config.dataDir,
    control,
    bots,
    github,
    // Lazy: routes register in filename order and workspaces.mjs (which sets app.ctx.workspaceSessions) sorts AFTER
    // this file — reading it once here would always see undefined. Look it up per call instead.
    sessions: {
      get startDiscussion() {
        return app.ctx.workspaceSessions?.startDiscussion;
      },
      get startReview() {
        return app.ctx.workspaceSessions?.startReview;
      },
    },
    submit,
  });
  app.ctx.githubEvents = service;

  app.get("/api/workspaces/:id/events", async (_req, _res, { params }) => {
    try {
      return service.getState(params.id);
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/workspaces/:id/events/configure", async (_req, _res, { params, body }) => {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    for (const key of ["enabled", "autoCreate", "autoAppend"]) {
      if (b[key] !== undefined && typeof b[key] !== "boolean") throw new HttpError(400, `${key} must be a boolean`);
    }
    if (b.pollSec !== undefined && b.pollSec !== null && typeof b.pollSec !== "number") {
      throw new HttpError(400, "pollSec must be a number of seconds (15..3600)");
    }
    try {
      return await service.configure(params.id, b);
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/workspaces/:id/events/sync", async (_req, _res, { params }) => {
    try {
      return await service.sync(params.id);
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/workspaces/:id/events/send", async (_req, _res, { params, body }) => {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    try {
      return await service.send(params.id, { eventId: b.eventId, botId: b.botId });
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/workspaces/:id/events/subscribe", async (_req, _res, { params, body }) => {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    try {
      return await service.subscribe(params.id, { target: b.target, botId: b.botId });
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/workspaces/:id/events/disable", async (_req, _res, { params }) => {
    try {
      return await service.disable(params.id);
    } catch (e) {
      throw mapError(e);
    }
  });
}
