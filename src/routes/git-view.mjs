// Read-only git view routes (AMP13-git):
//   GET /api/bots/:id/git/status                  -> {dir, head, branch, files[], filesTruncated}
//   GET /api/bots/:id/git/diff?scope=&path=       -> {diff, truncated, symlink?}
//   GET /api/bots/:id/git/log?limit=              -> {commits[]}
//   GET /api/bots/:id/git/commit/:sha/diff        -> {diff, truncated}
//   GET /api/bots/:id/git/refs                    -> {refs[], truncated}
//   GET /api/bots/:id/git/compare?base=&path=&nameStatus= -> {files[]} | {diff, truncated}
//
// The session's working directory is resolved server-side only: the bot's issueLoop.dir / review.dir /
// worktree.dir, else the conversation agent's own cwd, else the workspace cwd. The bot must belong to a ready
// workspace with an active binding; git runs through `runtimeBash(workspaceId)` (no host bash, no fallback).
// All git commands are fixed read-only subcommands built by git-view-env.mjs — no checkout/reset/fetch/push.
// Needs app.ctx.control, app.ctx.bots and app.ctx.runtimeBash; skipped (one warn) when any is missing.
import { HttpError } from "../api.mjs";
import {
  GitViewError,
  checkRef,
  gitCompare,
  gitCommitDiff,
  gitLog,
  gitRefs,
  gitStatus,
  untrackedFileDiff,
  workingTreeDiff,
  LOG_LIMIT,
} from "../git-view-env.mjs";

let warned = false;

const DIFF_SCOPES = ["unstaged", "staged", "all", "untracked"];

function mapError(e) {
  if (e instanceof HttpError) return e;
  if (e instanceof GitViewError) {
    if (e.code === "invalid") return new HttpError(400, e.message);
    return new HttpError(502, e.message);
  }
  return e;
}

export function register(app) {
  const { control, bots } = app.ctx;
  if (!control || !bots) {
    if (!warned) {
      warned = true;
      console.warn("routes/git-view: app.ctx.control / bots is not set, git view routes are not registered");
    }
    return;
  }

  /**
   * Resolve the session's git dir and bash for `botId`. The directory comes from the server-side record only:
   * session worktree metadata first (issueLoop > review > worktree), then the bot's own cwd, then the workspace
   * cwd — never a client-supplied path.
   */
  async function sessionGit(botId) {
    const bot = bots.get(botId);
    if (!bot) throw new HttpError(404, `bot not found: ${botId}`);
    const ws = control.links.workspaceOf(String(bot.conversationId)) ?? (bot.workspaceId ? control.workspaces.get(bot.workspaceId) : undefined);
    if (!ws) throw new HttpError(409, `session ${botId} is not linked to a workspace`);
    if (ws.status !== "ready") throw new HttpError(409, `workspace is not ready (status: ${ws.status})`);
    const binding = control.bindings.current(ws.id);
    if (!binding) throw new HttpError(409, "workspace has no active runtime binding");
    if (typeof app.ctx.runtimeBash !== "function") throw new HttpError(503, "runtime bash is not available");
    const dir = bot.issueLoop?.dir ?? bot.review?.dir ?? bot.worktree?.dir ?? bot.cwd ?? ws.cwd;
    if (typeof dir !== "string" || !dir.startsWith("/")) throw new HttpError(409, `session ${botId} has no git directory`);
    let bash;
    try {
      bash = await app.ctx.runtimeBash(ws.id);
    } catch (e) {
      throw new HttpError(409, `runtime unavailable: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    return { bash, dir };
  }

  const run = (fn) => async (_req, _res, { params, query }) => {
    try {
      return await fn(await sessionGit(params.id), params, query);
    } catch (e) {
      throw mapError(e);
    }
  };

  app.get("/api/bots/:id/git/status", run(({ bash, dir }) => gitStatus(bash, dir)));

  app.get(
    "/api/bots/:id/git/diff",
    run(({ bash, dir }, _params, query) => {
      const scope = query.scope === undefined || query.scope === "" ? "unstaged" : query.scope;
      if (!DIFF_SCOPES.includes(scope)) throw new HttpError(400, `scope must be one of: ${DIFF_SCOPES.join(", ")}`);
      const path = query.path === undefined || query.path === "" ? undefined : query.path;
      if (scope === "untracked") {
        if (!path) throw new HttpError(400, "path is required for scope=untracked");
        return untrackedFileDiff(bash, dir, path);
      }
      if (scope === "all") return workingTreeDiff(bash, dir, { staged: false, path }).then(async (unstaged) => {
        const staged = await workingTreeDiff(bash, dir, { staged: true, path });
        return { diff: `${staged.diff}${staged.diff && unstaged.diff ? "\n" : ""}${unstaged.diff}`, truncated: staged.truncated || unstaged.truncated };
      });
      return workingTreeDiff(bash, dir, { staged: scope === "staged", path });
    }),
  );

  app.get(
    "/api/bots/:id/git/log",
    run(({ bash, dir }, _params, query) => {
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, "limit must be a positive integer");
      return gitLog(bash, dir, { limit: Math.min(limit, LOG_LIMIT) });
    }),
  );

  app.get("/api/bots/:id/git/commit/:sha/diff", run(({ bash, dir }, params) => gitCommitDiff(bash, dir, checkRef(params.sha, { what: "sha" }))));

  app.get("/api/bots/:id/git/refs", run(({ bash, dir }) => gitRefs(bash, dir)));

  app.get(
    "/api/bots/:id/git/compare",
    run(({ bash, dir }, _params, query) => {
      const base = checkRef(query.base, { what: "base" });
      const path = query.path === undefined || query.path === "" ? undefined : query.path;
      const nameStatus = query.nameStatus === "1" || query.nameStatus === "true";
      return gitCompare(bash, dir, base, { path, nameStatus });
    }),
  );
}
