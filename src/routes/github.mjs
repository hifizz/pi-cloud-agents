// GET /api/github/repos                     -> [{fullName, defaultBranch, private}]
// GET /api/github/branches?repo=owner/name  -> [{name, sha}]
// Needs app.ctx.github (createGithubClient); not registered (one console.warn) when it is missing.
// Also exports `mapGithubError`, shared with src/routes/workspaces.mjs. No token ever reaches a response: GithubError
// messages are already redacted, and "unauthorized" is replaced by a fixed text.
import { HttpError } from "../api.mjs";
import { GithubError } from "../github.mjs";

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

let warned = false;

/** Turn a GithubError into an HttpError; any other error is returned unchanged. */
export function mapGithubError(e) {
  if (!(e instanceof GithubError)) return e;
  switch (e.code) {
    case "not_found":
      return new HttpError(404, e.message);
    case "unauthorized":
      return new HttpError(502, "GitHub 凭据不可用（请检查服务端的 GitHub 配置）");
    case "rate_limited":
      return new HttpError(429, `GitHub 请求被限流，请稍后重试：${e.message}`);
    case "conflict":
      return new HttpError(409, e.message);
    default:
      return new HttpError(502, e.message);
  }
}

export function register(app) {
  const { github } = app.ctx;
  if (!github) {
    if (!warned) {
      warned = true;
      console.warn("routes/github: app.ctx.github is not set, GitHub routes are not registered");
    }
    return;
  }

  app.get("/api/github/repos", async () => {
    try {
      return await github.listRepos();
    } catch (e) {
      throw mapGithubError(e);
    }
  });

  app.get("/api/github/branches", async (_req, _res, { query }) => {
    const repo = typeof query?.repo === "string" ? query.repo.trim() : "";
    if (!repo) throw new HttpError(400, "repo is required");
    if (!REPO_RE.test(repo)) throw new HttpError(400, "repo must look like owner/name");
    try {
      return await github.listBranches(repo);
    } catch (e) {
      throw mapGithubError(e);
    }
  });
}
