// Thin GitHub REST client (global fetch only, no dependencies). Contract: docs/M1-PLAN.md §4.2.
//
// Design points:
// - The token is never put into error messages, return values or logs. Every message that leaves this module goes
//   through `redact()`, including the text of errors thrown by `fetch` itself.
// - A PR is keyed by (repo, head branch). `ensurePull` never treats a timeout / network error / 5xx as "the PR was not
//   created": it looks the PR up again and only reports failure if it is really not there.

const DEFAULT_API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "pi-cloud-agents";
const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const DEFAULT_REPO_LIMIT = 100;
const DEFAULT_BRANCH_LIMIT = 300;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GithubError extends Error {
  /**
   * @param {"not_found"|"unauthorized"|"rate_limited"|"conflict"|"unknown"} code
   * @param {string} message already redacted
   * @param {{ status?: number }} [opts]
   */
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = "GithubError";
    this.code = code;
    this.status = status;
  }
}

/** Replace the token (and anything that looks like a GitHub credential) in `text`. */
function makeRedactor(token) {
  const literal = typeof token === "string" && token.length >= 4 ? token : "";
  return (value) => {
    let text = typeof value === "string" ? value : value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "");
    if (literal) text = text.split(literal).join("[REDACTED]");
    return text
      .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[REDACTED]")
      .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, "[REDACTED]")
      .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]");
  };
}

function assertRepo(repo) {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    throw new GithubError("not_found", `invalid repository name (expected owner/name): ${String(repo).slice(0, 100)}`);
  }
}

const encodeRef = (name) => String(name).split("/").map(encodeURIComponent).join("/");

function normalizePull(raw) {
  return {
    number: raw.number,
    url: raw.html_url ?? raw.url,
    state: raw.state,
    merged: Boolean(raw.merged ?? raw.merged_at),
    headRef: raw.head?.ref ?? null,
    baseRef: raw.base?.ref ?? null,
  };
}

/** True when the server definitively refused the request (so nothing was created). */
function isDefinitiveRejection(err) {
  const s = err?.status;
  return typeof s === "number" && s >= 400 && s < 500 && s !== 408;
}

export function createGithubClient({ token = process.env.GITHUB_TOKEN, fetch: fetchImpl = globalThis.fetch, apiBase = DEFAULT_API_BASE, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const secret = typeof token === "string" ? token.trim() : "";
  const redact = makeRedactor(secret);
  const base = String(apiBase).replace(/\/+$/, "");

  /** Perform one request; returns { status, data } for 2xx, throws GithubError otherwise. */
  async function request(method, path, { query, body, allow404 = false } = {}) {
    if (!secret) throw new GithubError("unauthorized", "GITHUB_TOKEN is not configured");
    if (typeof fetchImpl !== "function") throw new GithubError("unknown", "no fetch implementation available");
    let url = `${base}${path}`;
    if (query) url += `?${query}`;
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${secret}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
    };
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (timeoutMs > 0 && typeof AbortSignal?.timeout === "function") init.signal = AbortSignal.timeout(timeoutMs);

    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      const name = err?.name === "TimeoutError" || err?.name === "AbortError" ? "request timed out" : "network error";
      // Never keep `err` as cause: it may carry request headers.
      throw new GithubError("unknown", redact(`GitHub ${method} ${path}: ${name}: ${err?.message ?? err}`));
    }

    const status = res.status;
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      throw new GithubError("unknown", redact(`GitHub ${method} ${path}: failed to read response (${status}): ${err?.message ?? err}`), { status });
    }
    let data;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }

    if (status >= 200 && status < 300) {
      if (data === undefined && text) {
        throw new GithubError("unknown", `GitHub ${method} ${path}: unparseable response body (${status})`, { status });
      }
      return { status, data, headers: res.headers };
    }
    if (status === 404 && allow404) return { status, data: null, headers: res.headers };
    throw httpError(method, path, res, status, data, text);
  }

  function httpError(method, path, res, status, data, text) {
    const parts = [];
    if (typeof data?.message === "string") parts.push(data.message);
    if (Array.isArray(data?.errors)) {
      for (const e of data.errors) {
        if (typeof e === "string") parts.push(e);
        else if (typeof e?.message === "string") parts.push(e.message);
      }
    }
    const detail = parts.length ? parts.join("; ") : String(text ?? "").slice(0, 200);
    const msg = redact(`GitHub ${method} ${path} -> ${status}${detail ? `: ${detail}` : ""}`);
    const header = (n) => (typeof res.headers?.get === "function" ? res.headers.get(n) : null);

    let code = "unknown";
    if (status === 401) code = "unauthorized";
    else if (status === 429) code = "rate_limited";
    else if (status === 403) {
      const limited = header("x-ratelimit-remaining") === "0" || header("retry-after") != null || /rate limit/i.test(detail);
      code = limited ? "rate_limited" : "unauthorized";
    } else if (status === 404) code = "not_found";
    else if (status === 422 && /already exists/i.test(detail)) code = "conflict";
    return new GithubError(code, msg, { status });
  }

  async function paginate(path, extraQuery, limit, mapItem) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
      // Constant per_page: page numbers are only meaningful relative to a fixed page size.
      const perPage = PAGE_SIZE;
      const { data } = await request("GET", path, { query: `${extraQuery}per_page=${perPage}&page=${page}` });
      if (!Array.isArray(data)) throw new GithubError("unknown", `GitHub GET ${path}: expected a list`);
      for (const item of data) {
        out.push(mapItem(item));
        if (out.length >= limit) break;
      }
      if (data.length < perPage) break;
    }
    return out;
  }

  const gh = {
    async listRepos({ limit = DEFAULT_REPO_LIMIT } = {}) {
      return paginate("/user/repos", "sort=pushed&direction=desc&", limit, (r) => ({
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: Boolean(r.private),
      }));
    },

    async listBranches(repo, { limit = DEFAULT_BRANCH_LIMIT } = {}) {
      assertRepo(repo);
      return paginate(`/repos/${repo}/branches`, "", limit, (b) => ({ name: b.name, sha: b.commit?.sha ?? null }));
    },

    /** One issue (not a PR). Returns {number,title,body,url,state,author,comments} or null when missing. */
    async getIssue(repo, number) {
      assertRepo(repo);
      const n = Number(number);
      if (!Number.isInteger(n) || n <= 0) throw new GithubError("not_found", `invalid issue number: ${String(number).slice(0, 40)}`);
      const { data } = await request("GET", `/repos/${repo}/issues/${n}`, { allow404: true });
      if (!data || data.pull_request) return null;
      return {
        number: data.number,
        title: data.title ?? "",
        body: data.body ?? "",
        url: data.html_url ?? `https://github.com/${repo}/issues/${n}`,
        state: data.state,
        author: data.user?.login ?? null,
        comments: data.comments ?? 0,
      };
    },

    /** Comments of one issue, oldest first: [{author, body, url}]. */
    async listIssueComments(repo, number, { limit = 100 } = {}) {
      assertRepo(repo);
      const n = Number(number);
      if (!Number.isInteger(n) || n <= 0) throw new GithubError("not_found", `invalid issue number: ${String(number).slice(0, 40)}`);
      return paginate(`/repos/${repo}/issues/${n}/comments`, "", limit, (c) => ({
        author: c.user?.login ?? null,
        body: c.body ?? "",
        url: c.html_url ?? null,
      }));
    },

    async getBranch(repo, name) {
      assertRepo(repo);
      const { data } = await request("GET", `/repos/${repo}/branches/${encodeRef(name)}`, { allow404: true });
      if (!data) return null;
      return { name: data.name, sha: data.commit?.sha ?? null };
    },

    async findPullByHead(repo, headBranch) {
      assertRepo(repo);
      const owner = repo.split("/")[0];
      const head = `${owner}:${headBranch}`;
      const { data } = await request("GET", `/repos/${repo}/pulls`, {
        query: `head=${encodeURIComponent(head)}&state=all&sort=created&direction=desc&per_page=${PAGE_SIZE}`,
      });
      if (!Array.isArray(data)) throw new GithubError("unknown", `GitHub GET /repos/${repo}/pulls: expected a list`);
      // Defensive: some servers ignore the head filter; only keep exact matches.
      const pulls = data.filter((p) => p?.head?.ref === headBranch).map(normalizePull);
      if (!pulls.length) return null;
      return pulls.find((p) => p.state === "open") ?? pulls[0];
    },

    async createPull(repo, { head, base, title, body, draft } = {}) {
      assertRepo(repo);
      const payload = { title, head, base, body: body ?? "" };
      if (draft) payload.draft = true;
      const { data } = await request("POST", `/repos/${repo}/pulls`, { body: payload });
      if (!data || typeof data.number !== "number") {
        throw new GithubError("unknown", `GitHub POST /repos/${repo}/pulls: unexpected response`, { status: 200 });
      }
      return normalizePull(data);
    },

    async ensurePull({ repo, head, base, title, body, draft } = {}, { intents, requestId } = {}) {
      if (!intents || typeof intents.begin !== "function" || typeof intents.settle !== "function") {
        throw new TypeError("ensurePull requires an intents store");
      }
      if (!requestId) throw new TypeError("ensurePull requires a requestId");
      assertRepo(repo);

      const { intent, created: intentCreated } = intents.begin({ requestId, kind: "github.pr", target: `${repo}#${head}` });
      const alreadyConfirmed = !intentCreated && intent?.state === "confirmed";
      // If an earlier attempt may have sent the request, a failure now is still "unknown", not "failed".
      const maybeSentBefore = !intentCreated && intent && intent.state !== "planned" && intent.state !== "failed";
      const settle = (state, evidence) => {
        if (alreadyConfirmed && state === "confirmed") return;
        intents.settle(requestId, { state, evidence });
      };
      const failureState = (definitive) => (definitive && !maybeSentBefore ? "failed" : "unknown");

      const accept = (pull, created) => {
        if (pull.state === "closed" || pull.merged) {
          const err = new GithubError(
            "conflict",
            `a ${pull.merged ? "merged" : "closed"} pull request already exists for ${repo}#${head} (#${pull.number}); use a new branch or new work`,
          );
          settle("failed", { number: pull.number, url: pull.url, error: err.message });
          throw err;
        }
        settle("confirmed", { number: pull.number, url: pull.url });
        return { pull, created };
      };

      // 1. Already there?
      let existing;
      try {
        existing = await gh.findPullByHead(repo, head);
      } catch (err) {
        settle(failureState(isDefinitiveRejection(err)), { error: err.message });
        throw err;
      }
      if (existing) return accept(existing, false);

      // 2. Create. From here on a failure may still mean the PR exists.
      if (typeof intents.markSent === "function") intents.markSent(requestId);
      let createError;
      let createdPull;
      try {
        createdPull = await gh.createPull(repo, { head, base, title, body, draft });
      } catch (err) {
        if (!(err instanceof GithubError)) {
          settle("unknown", { error: redact(err) });
          throw new GithubError("unknown", redact(err));
        }
        createError = err;
      }
      if (createdPull) return accept(createdPull, true);

      // A definite refusal (401/403/404/422 validation...) created nothing; no need to look again.
      if (isDefinitiveRejection(createError) && createError.code !== "conflict") {
        settle(failureState(true), { error: createError.message });
        throw createError;
      }

      // 3. Timeout / network error / 5xx / "already exists": look again before declaring anything.
      let found;
      try {
        found = await gh.findPullByHead(repo, head);
      } catch {
        found = undefined;
      }
      if (found) return accept(found, createError.code !== "conflict");
      settle("unknown", { error: createError.message });
      throw createError;
    },

    /** A repo's default branch name, or null. */
    async getRepo(repo) {
      assertRepo(repo);
      const { data } = await request("GET", `/repos/${repo}`, { allow404: true });
      if (!data) return null;
      return { fullName: data.full_name, defaultBranch: data.default_branch ?? null };
    },

    /** Open issues only (PRs filtered out), up to `limit` items across paginated requests. The /issues endpoint mixes
     * PRs in and is capped at one page by default, so this always paginates and always excludes pull_request entries.
     * Not "all" issues: bounded by `limit` (and the shared MAX_PAGES ceiling), like every other list here. */
    async listIssues(repo, { limit = 500 } = {}) {
      assertRepo(repo);
      return paginate(`/repos/${repo}/issues`, "state=open&sort=created&direction=desc&", limit, (i) => ({
        number: i.number,
        title: i.title ?? "",
        url: i.html_url ?? null,
        state: i.state,
        author: i.user?.login ?? null,
        comments: i.comments ?? 0,
        isPull: Boolean(i.pull_request),
      })).then((list) => list.filter((i) => !i.isPull).map(({ isPull: _isPull, ...rest }) => rest));
    },

    /** Open, unmerged pull requests, up to `limit` items across paginated requests (same MAX_PAGES ceiling).
     * Includes the title (normalizePull is the older shape). */
    async listPulls(repo, { limit = 200 } = {}) {
      assertRepo(repo);
      return paginate(`/repos/${repo}/pulls`, "state=open&sort=created&direction=desc&", limit, (p) => ({ ...normalizePull(p), title: p.title ?? "" }));
    },

    /** Open PRs whose base is `base` branch (the pull request(s) tracking the selected baseline). */
    async listPullsByBase(repo, baseBranch, { limit = 50 } = {}) {
      assertRepo(repo);
      return paginate(`/repos/${repo}/pulls`, `state=open&base=${encodeURIComponent(baseBranch)}&sort=created&direction=desc&`, limit, normalizePull);
    },
  };
  return gh;
}
