// Workspace routes (docs/M1-PLAN.md §4.8):
//   POST /api/workspaces            {requestId, repo, baseBranch?, task?, modelId?, installCommand?, name?} -> 202 Workspace
//   GET  /api/workspaces            -> [Workspace]
//   GET  /api/workspaces/:id        -> Workspace
//   POST /api/workspaces/:id/retry  -> Workspace
//   POST /api/workspaces/:id/pr     {requestId, title?, body?, base?} -> {pull, created}
// Needs app.ctx.workspaces (M1-07 service), app.ctx.github and app.ctx.control (control store); when any is missing
// nothing is registered (one console.warn), so old deployments behave as before.
// A Workspace in a response is the control-store record plus `steps`, `botId` and `binding` {provider, runtimeId,
// version}. `requestId` and `cwd` are left out (internal), and nothing here ever sees a token.
import { HttpError, toJson } from "../api.mjs";
import { mapGithubError, REPO_RE } from "./github.mjs";

let warned = false;

const PR_FOOTER = "Opened by TARSBot";
const PR_SCOPE = "pr";

function jsonObject(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  return body;
}

function optString(obj, key, max) {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${key} is too long (max ${max} characters)`);
  return t || undefined;
}

/** Service and store errors carry a `code`; map them to HTTP. GithubErrors are mapped by mapGithubError. */
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
    default:
      return e;
  }
}

export function register(app) {
  const { workspaces, github, control, bots } = app.ctx;
  if (!workspaces || !github || !control) {
    if (!warned) {
      warned = true;
      console.warn("routes/workspaces: app.ctx.workspaces / github / control is not set, workspace routes are not registered");
    }
    return;
  }

  function view(ws) {
    const { requestId: _requestId, cwd: _cwd, ...rest } = ws;
    const links = control.links.conversationsOf(ws.id);
    const first = links[0];
    let botId = null;
    if (first) {
      botId = first.botId ?? bots?.list?.().find((b) => String(b.conversationId) === first.conversationId)?.id ?? null;
    }
    const b = control.bindings.current(ws.id);
    return {
      ...rest,
      steps: control.workspaces.steps(ws.id),
      botId,
      binding: b ? { provider: b.provider, runtimeId: b.runtimeId, version: b.version } : null,
    };
  }

  function workspaceOr404(id) {
    const ws = workspaces.get(id);
    if (!ws) throw new HttpError(404, `workspace not found: ${id}`);
    return ws;
  }

  app.post("/api/workspaces", async (_req, res, { body }) => {
    const b = jsonObject(body);
    if (typeof b.requestId !== "string" || !b.requestId.trim()) throw new HttpError(400, "requestId is required");
    if (typeof b.repo !== "string" || !b.repo.trim()) throw new HttpError(400, "repo is required");
    if (!REPO_RE.test(b.repo.trim())) throw new HttpError(400, "repo must look like owner/name");
    let ws;
    try {
      ws = await workspaces.create(b);
    } catch (e) {
      if (e?.code === "conflict") throw new HttpError(409, "请求编号已被不同内容使用");
      throw mapError(e);
    }
    const payload = toJson(view(ws));
    res.writeHead(202, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
    res.end(payload);
  });

  app.get("/api/workspaces", async () => workspaces.list().map(view));

  app.get("/api/workspaces/:id", async (_req, _res, { params }) => view(workspaceOr404(params.id)));

  app.post("/api/workspaces/:id/retry", async (_req, _res, { params }) => {
    workspaceOr404(params.id);
    try {
      return view(await workspaces.retry(params.id));
    } catch (e) {
      throw mapError(e);
    }
  });

  app.post("/api/workspaces/:id/pr", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const requestId = typeof b.requestId === "string" ? b.requestId.trim() : "";
    if (!requestId) throw new HttpError(400, "requestId is required");
    if (requestId.length > 200) throw new HttpError(400, "requestId is too long (max 200 characters)");
    const userTitle = optString(b, "title", 256);
    const userBody = optString(b, "body", 60_000);
    const userBase = optString(b, "base", 200);
    if (userBase && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(userBase)) throw new HttpError(400, "base is not a valid branch name");

    const ws = workspaceOr404(params.id);
    if (ws.status !== "ready") throw new HttpError(409, `workspace is not ready (status: ${ws.status})`);

    const head = ws.branch;
    const base = userBase ?? ws.baseBranch;
    const title = userTitle ?? ((ws.task ?? "").split("\n")[0].trim().slice(0, 120) || head);
    const prBody = userBody ? `${userBody}\n\n${PR_FOOTER}` : PR_FOOTER;

    try {
      // The server never pushes for the Bot. An unpushed head is a 409, unless a PR for it already exists
      // (a merged / closed one is reported by ensurePull below, and a repeated request must find its own PR).
      const pushed = await github.getBranch(ws.repo, head);
      if (!pushed) {
        const known = typeof github.findPullByHead === "function" ? await github.findPullByHead(ws.repo, head) : null;
        if (!known) throw new HttpError(409, `分支 ${head} 尚未推送到 GitHub：请先让 Bot 执行 git push -u origin ${head}`);
      }
      // namespaced: the intents table is shared with the workspace service's own keys
      const key = `${PR_SCOPE}:${ws.id}:${requestId}`;
      const prior = control.intents.get(key);
      const out = await github.ensurePull({ repo: ws.repo, head, base, title, body: prBody }, { intents: control.intents, requestId: key });
      // A repeated request answers exactly like the first one (ensurePull itself can only say "found, not created").
      if (prior?.state === "confirmed" && typeof prior.evidence?.created === "boolean") return { pull: out.pull, created: prior.evidence.created };
      if (control.intents.get(key)?.state === "confirmed") {
        control.intents.settle(key, { state: "confirmed", evidence: { number: out.pull.number, url: out.pull.url, created: out.created } });
      }
      return out;
    } catch (e) {
      // ensurePull's conflict (merged / closed PR) already says to use a new branch or new work
      throw mapError(e);
    }
  });
}
