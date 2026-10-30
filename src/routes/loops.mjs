// Loop routes (Issue14 Phase1):
//   GET/POST /api/workspaces/:id/loops            list / create
//   GET/PATCH/DELETE /api/loops/:id               detail / patch (version+1 + snapshot) / delete
//   POST /api/loops/:id/enable | /disable         switch
//   POST /api/loops/:id/run                       Run now {entity?:{issue?,pr?}} -> {runId,status} (409 when disabled)
//   GET  /api/loops/:id/runs?limit                run history
//   GET  /api/loops/:id/versions                  version list
//   POST /api/loop-runs/:runId/cancel             cancel a queued / running run
//   GET  /api/loops/queue                         {maxConcurrent, running[], queued[{position}]}
//   POST /api/loops/:id/webhook                   machine-auth entry (Bearer secret OR Standard Webhooks signature)
//   POST /api/loops/:id/webhook/rotate            session auth, returns the new secret once
//
// Auth: everything goes through the global guard in src/routes/auth.mjs. The webhook entry is a machine-credential
// path registered via app.ctx.registerMachineAuth: the guard calls verifyWebhookCredentials (real Bearer-hash /
// Standard-Webhooks check, raw body read once inside the guard) — it is not an anonymous exemption. Every other
// loop route requires a normal login session.
import { randomUUID } from "node:crypto";
import { HttpError } from "../api.mjs";
import { createLoopStore, LoopValidationError } from "../loops/store.mjs";
import { verifyWebhookCredentials, readRaw, createRateLimiter } from "../loops/webhook.mjs";
import { scheduleTriggerKey } from "../loops/schedule.mjs";

const RUNS_LIMIT_MAX = 200;

const loopView = (loop, latestRun) => {
  const { webhookSecretHash: _drop, ...rest } = loop;
  return { ...rest, hasWebhookSecret: Boolean(loop.webhookSecretHash), ...(latestRun !== undefined ? { latestRun } : {}) };
};

const runView = (r) => r;

function jsonObject(body) {
  if (body === undefined) return {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  return body;
}

function mapError(e) {
  if (e instanceof HttpError) return e;
  switch (e?.code) {
    case "invalid":
      return new HttpError(400, e.message);
    case "not_found":
      return new HttpError(404, e.message);
    case "conflict":
      return new HttpError(409, e.message);
    default:
      if (e instanceof LoopValidationError) return new HttpError(400, e.message);
      return e;
  }
}

let warned = false;

export function register(app) {
  const { control, loops, bots } = app.ctx;
  // `loops` is the wired bundle from server.mjs: {store(loopStore), queue, scheduler}. When absent (tests that only
  // exercise other routes, old deployments), nothing registers — one warning, same convention as workspaces.mjs.
  if (!control || !loops) {
    if (!warned) {
      warned = true;
      console.warn("routes/loops: app.ctx.control / app.ctx.loops is not set, loop routes are not registered");
    }
    return;
  }
  const loopStore = loops.store ?? createLoopStore({ store: control });
  const queue = loops.queue;
  const scheduler = loops.scheduler;
  const limiter = loops.rateLimiter ?? createRateLimiter({ limit: 120, windowMs: 60_000 });
  const now = loops.now ?? Date.now;

  const workspaceOr404 = (id) => {
    const ws = control.workspaces.get(id);
    if (!ws) throw new HttpError(404, `workspace not found: ${id}`);
    return ws;
  };
  const loopOr404 = (id) => {
    const loop = control.loops.get(id);
    if (!loop) throw new HttpError(404, `loop not found: ${id}`);
    return loop;
  };

  const runSummary = (r) =>
    r && {
      id: r.id,
      loopId: r.loopId,
      loopVersion: r.loopVersion,
      triggerKind: r.triggerKind,
      status: r.status,
      error: r.error,
      botId: r.botId,
      branch: r.branch,
      prNumber: r.prNumber,
      enqueuedAt: r.enqueuedAt,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      ...(r.position !== undefined ? { position: r.position } : {}),
    };

  // ---- workspace-scoped collection ----
  app.get("/api/workspaces/:id/loops", async (_req, _res, { params }) => {
    workspaceOr404(params.id);
    return control.loops.listByWorkspace(params.id).map((loop) => loopView(loop, runSummary(control.loopRuns.latestOf(loop.id))));
  });

  app.post("/api/workspaces/:id/loops", async (_req, _res, { params, body }) => {
    workspaceOr404(params.id);
    const b = jsonObject(body);
    try {
      const { loop, webhookSecret } = await loopStore.create(params.id, b);
      if (scheduler) await scheduler.sync(loop);
      return { loop: loopView(loop), ...(webhookSecret ? { webhookSecret } : {}) };
    } catch (e) {
      throw mapError(e);
    }
  });

  // ---- single loop ----
  // /api/loops/queue must be registered BEFORE /api/loops/:id: the :id matcher would otherwise swallow "queue".
  app.get("/api/loops/queue", async () => {
    const v = queue.view();
    return { maxConcurrent: v.maxConcurrent, running: v.running.map(runSummary), queued: v.queued.map(runSummary) };
  });

  app.get("/api/loops/:id", async (_req, _res, { params }) => loopView(loopOr404(params.id), runSummary(control.loopRuns.latestOf(params.id))));

  app.patch("/api/loops/:id", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const current = loopOr404(params.id);
    try {
      const out = await loopStore.update(current.id, b);
      if (!out) throw new HttpError(404, `loop not found: ${params.id}`);
      if (scheduler) await scheduler.sync(out.loop);
      return { loop: loopView(out.loop), ...(out.webhookSecret ? { webhookSecret: out.webhookSecret } : {}) };
    } catch (e) {
      throw mapError(e);
    }
  });

  app.delete("/api/loops/:id", async (_req, _res, { params }) => {
    const loop = loopOr404(params.id);
    if (scheduler) await scheduler.stop(loop.id);
    const ok = control.loops.remove(loop.id);
    return { ok, id: params.id };
  });

  app.post("/api/loops/:id/enable", async (_req, _res, { params }) => {
    loopOr404(params.id);
    const loop = await loopStore.setEnabled(params.id, true);
    if (scheduler) await scheduler.sync(loop);
    return { loop: loopView(loop) };
  });

  app.post("/api/loops/:id/disable", async (_req, _res, { params }) => {
    loopOr404(params.id);
    const loop = await loopStore.setEnabled(params.id, false);
    if (scheduler) await scheduler.stop(loop.id);
    return { loop: loopView(loop) };
  });

  // ---- run now ----
  app.post("/api/loops/:id/run", async (_req, _res, { params, body }) => {
    const loop = loopOr404(params.id);
    if (!loop.enabled) throw new HttpError(409, "loop is disabled");
    const b = jsonObject(body);
    let entityRef;
    if (b.entity !== undefined && b.entity !== null) {
      const e = jsonObject(b.entity);
      const issue = Number(e.issue);
      const pr = Number(e.pr);
      if (Number.isInteger(issue) && issue > 0) entityRef = `issue:${issue}`;
      else if (Number.isInteger(pr) && pr > 0) entityRef = `pr:${pr}`;
      else throw new HttpError(400, "entity must be {issue:n} or {pr:n}");
    }
    const { run } = queue.enqueue({ loop, triggerKind: "manual", triggerKey: `manual:${randomUUID()}`, payload: { manual: true }, entityRef });
    return { runId: run.id, status: run.status };
  });

  app.get("/api/loops/:id/runs", async (_req, _res, { params, query }) => {
    loopOr404(params.id);
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), RUNS_LIMIT_MAX);
    return control.loopRuns.listByLoop(params.id, { limit }).map(runView);
  });

  app.get("/api/loops/:id/versions", async (_req, _res, { params }) => {
    loopOr404(params.id);
    return control.loopVersions.list(params.id);
  });

  // ---- queue (registered above /api/loops/:id) ----

  app.post("/api/loop-runs/:runId/cancel", async (_req, _res, { params }) => {
    const run = await queue.cancel(params.runId);
    if (!run) throw new HttpError(404, `run not found: ${params.runId}`);
    return runSummary(run);
  });

  // ---- generic webhook (machine auth inside the global guard) ----
  // The verifier runs inside the auth guard, BEFORE the route: raw body is read once here (capped, before any
  // parsing or side effect) and stashed on req.machineBody for the handler. Signature/Bearer failure -> 401 and the
  // route is never reached. Exact method+path only.
  app.ctx.registerMachineAuth?.({
    method: "POST",
    pathRe: /^\/api\/loops\/[^/]+\/webhook$/,
    verify: async (req) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const m = /^\/api\/loops\/([^/]+)\/webhook$/.exec(path);
      const loop = m ? control.loops.get(m[1]) : undefined;
      const raw = await readRaw(req);
      req.machineBody = raw;
      // Per-loop+IP throttle after the cheap checks; an over-limit caller is told 429 before heavy verification.
      const ip = String(req.socket?.remoteAddress ?? "unknown");
      if (!limiter(`${m?.[1] ?? "?"}|${ip}`)) throw new HttpError(429, "too many webhook requests");
      await verifyWebhookCredentials(req, loop, raw, { now });
    },
  });

  app.post("/api/loops/:id/webhook", async (req, res, { params }) => {
    const loop = loopOr404(params.id);
    const raw = req.machineBody ?? Buffer.alloc(0);
    let payload;
    const text = raw.toString("utf8");
    try {
      payload = text.trim() ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text }; // non-JSON bodies are carried verbatim in a labelled field
    }
    const webhookId = String(req.headers["webhook-id"] ?? "") || `anon:${randomUUID()}`;
    if (!loop.enabled) {
      // A disabled loop's webhook is accepted (it was a valid signed request) but skipped, visibly.
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ runId: null, status: "skipped", reason: "loop disabled" }));
      return;
    }
    const { run, created } = queue.enqueue({
      loop,
      triggerKind: "webhook",
      triggerKey: `webhook:${webhookId}`,
      payload,
      entityRef: undefined,
    });
    res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ runId: run.id, status: run.status, deduplicated: !created }));
  });

  app.post("/api/loops/:id/webhook/rotate", async (_req, _res, { params }) => {
    const loop = loopOr404(params.id);
    if (loop.trigger?.kind !== "webhook") throw new HttpError(409, "loop has no webhook trigger");
    try {
      const out = await loopStore.rotateSecret(loop.id);
      if (!out) throw new HttpError(404, `loop not found: ${params.id}`);
      return { webhookSecret: out.webhookSecret };
    } catch (e) {
      throw mapError(e);
    }
  });

  // ---- schedule enqueue callback the scheduler wires in ----
  // (exposed for server.mjs wiring; the scheduler calls this with the slot ms)
  app.ctx.loopsEnqueueScheduled = (loopId, slotMs) => {
    const loop = control.loops.get(loopId);
    if (!loop || !loop.enabled || loop.trigger?.kind !== "schedule") return;
    queue.enqueue({
      loop,
      triggerKind: "schedule",
      triggerKey: scheduleTriggerKey(slotMs),
      payload: { slot: slotMs },
    });
  };
}
