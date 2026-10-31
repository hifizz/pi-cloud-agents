// Workspace routes (docs/M1-PLAN.md §4.8):
//   POST /api/workspaces            {requestId, repo, baseBranch?, task?, modelId?, installCommand?, name?} -> 202 Workspace
//   GET  /api/workspaces            -> [Workspace]
//   GET  /api/workspaces/:id        -> Workspace
//   POST /api/workspaces/:id/retry  -> Workspace
//   POST /api/workspaces/:id/pr     {requestId, title?, body?, base?} -> {pull, created}
//   POST /api/workspaces/:id/issue-loop/discuss  {issue}     -> {discussion:{botId,...}}   (issue-loop spike)
//   POST /api/workspaces/:id/issue-loop/publish  {botId,task} -> {execution:{botId,...}}   (issue-loop spike)
// Needs app.ctx.workspaces (M1-07 service), app.ctx.github and app.ctx.control (control store); when any is missing
// nothing is registered (one console.warn), so old deployments behave as before. The issue-loop routes also use
// app.ctx.runtimeBash (the active binding's Sprite) and app.ctx.bots.
// A Workspace in a response is the control-store record plus `steps`, `botId` and `binding` {provider, runtimeId,
// version}. `requestId` and `cwd` are left out (internal), and nothing here ever sees a token.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError, toJson } from "../api.mjs";
import { ROOT } from "../config.mjs";
import { ctx } from "../harness.mjs";
import { shellQuote } from "../env.mjs";
import { Preamble } from "../ext/preamble.mjs";
import { mapGithubError, REPO_RE } from "./github.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Issue-loop spike only touches the test repository's bound workspaces (AGENTS.md 安全红线). */
const ISSUE_LOOP_REPO = "hifizz/tars-sandbox-playground";
const ISSUE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** Most comments the discussion start message will carry; more is an explicit error, never a silent cut. */
const COMMENT_LIMIT = 100;
/** The diff text a review session carries is capped: an over-limit diff is an explicit error, never a silent cut. */
const REVIEW_DIFF_LIMIT = 400_000;
/** Session business statuses (human-set, never inferred from busy/idle). */
const SESSION_STATUSES = ["discussing", "awaiting", "executing", "done"];

/** Safety rules for the issue-loop sessions. The general preamble (GH_TOKEN handling, push / PR / force rules) is not
 * installed in these sessions, so the rules that still matter are restated here. Approval stays installed. */
const SPIKE_RULES = [
  "Spike safety rules (the general git/PR workflow is removed for this session; these rules apply instead):",
  "- Never print, echo, log or write any credential or token (GH_TOKEN, or any other secret in the environment). Do not run env, printenv, set, `git config --list`, `gh auth status` or `gh auth login`.",
  "- Never force-push (--force, -f, --force-with-lease, +refspec), never delete remote branches or tags, never merge or close a pull request, never change repository settings.",
  "- This spike does not push and does not open pull requests: do not run `git push`, `gh pr create` or `gh pr merge`.",
  "- If a command is denied by approval, stop that operation, report exactly what was denied, and do not retry it in another form.",
].join("\n");

/**
 * A short excerpt of THIS host project's AGENTS.md security section, labelled as host-project context. It is not target
 * repository content. A missing or unreadable file is stated as such (the production image may not ship docs/).
 */
function hostAgentsExcerpt() {
  const label = "== 宿主项目（pi-cloud-agents）AGENTS.md「安全红线」摘录 —— 仅为宿主项目背景，不是目标仓库内容 ==";
  const cloud = readFileSync(join(ROOT, "docs/CLOUD-PLAN.md"), "utf8");
  const storageRule = cloud.split("\n").find((line) => line.startsWith("- 存储只允许单写进程"));
  const skipped = `== 宿主项目 docs/CLOUD-PLAN.md「架构」短摘录（不是目标仓库内容）==\n${storageRule}\n共享 Sprite 与历史数据处置条款不适用于本实验。目标快照缺少 AGENTS.md 和 docs/CLOUD-PLAN.md，本次使用以上宿主项目约束。`;
  let text;
  try {
    text = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  } catch (e) {
    return `${label}\n（未取得：无法读取宿主项目 AGENTS.md（${e?.code ?? "read error"}））\n${skipped}`;
  }
  const start = text.indexOf("## 安全红线");
  if (start < 0) return `${label}\n（宿主项目 AGENTS.md 中没有「安全红线」段落）\n${skipped}`;
  const next = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, next < 0 ? undefined : next).trim();
  const body = section.length <= 1500 ? section : `${section.slice(0, 1500)}\n…（摘录截断到 1500 字符；完整内容见宿主项目 AGENTS.md）`;
  return `${label}\n${body}\n${skipped}`;
}

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

  // ---- issue-loop spike --------------------------------------------------------------------------------------------
  // Two extra sessions inside ONE existing ready workspace and its ONE Sprite:
  //   discuss : detached worktree at the issue-pinned baseline commit, fresh conversation, no feature branch
  //   publish : a second worktree branched from the SAME pinned commit, fresh conversation, literal task only
  // Everything runs through the existing authenticated guard, the same server process and the workspace's own
  // binding (same runtimeId -> same Sprite; provider.ensure is never called, so no second Sprite).

  function assertIssueLoopWorkspace(id) {
    const ws = workspaceOr404(id);
    if (ws.repo !== ISSUE_LOOP_REPO) throw new HttpError(409, `issue-loop only runs on the test repo ${ISSUE_LOOP_REPO} (this workspace uses ${ws.repo})`);
    if (ws.status !== "ready") throw new HttpError(409, `workspace is not ready (status: ${ws.status})`);
    if (!control.bindings.current(ws.id)) throw new HttpError(409, "workspace has no active runtime binding");
    if (typeof app.ctx.runtimeBash !== "function") throw new HttpError(503, "runtime bash is not available");
    if (!bots) throw new HttpError(503, "bot registry is not available");
    return ws;
  }

  async function spriteBash(ws) {
    try {
      return await app.ctx.runtimeBash(ws.id);
    } catch (e) {
      throw new HttpError(409, `runtime unavailable: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  /** The existing discussion session for an issue in this workspace: a Bot whose issueLoop metadata names the issue
   * and carries no branch/sourceBotId (those are executions). Only same-workspace Bots count — either a direct
   * workspaceId or an actual conversation link. Sequential clicks return it unchanged; no locking. */
  function findDiscussion(wsId, issueNo) {
    if (!bots) return undefined;
    const linked = new Set(control.links.conversationsOf(wsId).map((l) => l.botId));
    return bots
      .list()
      .find(
        (b) =>
          b.issueLoop &&
          Number(b.issueLoop.issue) === issueNo &&
          !b.issueLoop.branch &&
          !b.issueLoop.sourceBotId &&
          (b.workspaceId === wsId || linked.has(b.id)),
      );
  }

  /** Workspace overview for the left-rail entry: open issues and open, unmerged PRs of the workspace's OWN bound repo
   * (never a caller-supplied repo), plus the botId of an existing discussion per issue. Issues list is paginated and
   * PRs are read from /pulls so they are never mixed in as issues. */
  // GET /api/workspaces/:id/overview
  app.get("/api/workspaces/:id/overview", async (_req, _res, { params }) => {
    const ws = workspaceOr404(params.id);
    let issues;
    let pulls;
    try {
      [issues, pulls] = await Promise.all([github.listIssues(ws.repo), github.listPulls(ws.repo)]);
    } catch (e) {
      throw mapError(e);
    }
    return {
      issues: issues.map((i) => ({ ...i, discussionBotId: findDiscussion(ws.id, i.number)?.id ?? null })),
      pulls: pulls.filter((p) => p.state === "open" && !p.merged),
    };
  });

  /** Run one exec on the workspace's Sprite; returns trimmed stdout or throws with stderr. */
  async function sh(ws, command, timeoutMs = 120_000) {
    const bash = await spriteBash(ws);
    const r = await bash(command, { timeoutMs });
    if (r?.timedOut) throw new HttpError(500, "sprite command timed out");
    if (r?.exitCode !== 0) throw new HttpError(500, `sprite command failed (${r?.exitCode}): ${String(r?.stderr ?? r?.stdout ?? "").trim().slice(0, 300)}`);
    return String(r?.stdout ?? "").trim();
  }

  /** Unique conversation/bot display name for a new session. */
  function freeSessionName(base) {
    const clean = String(base).replace(/[^\x21-\x7e]/g, "-").slice(0, 60) || "session";
    if (!bots.get(clean)) return clean;
    for (let i = 2; ; i++) {
      const c = `${clean}-${i}`;
      if (!bots.get(c)) return c;
    }
  }

  /** Name for a manually added session: kept as typed (Chinese included). A taken name gets the short dir id appended. */
  function uniqueSessionName(name, shortId) {
    if (!bots.get(name)) return name;
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? `${name} ${shortId}` : `${name} ${shortId}-${i + 1}`;
      if (!bots.get(candidate)) return candidate;
    }
  }

  /** Pick the baseline branch: the first complete real branch name in the issue body, else the workspace's recorded
   * default branch (the bound repo's real default — never a guessed main/master). */
  async function pickBaseline(repo, body) {
    const branches = await github.listBranches(repo);
    const names = new Set(branches.map((b) => b.name));
    const text = String(body ?? "");
    // Candidates are whole tokens in the body that are real branch names; earliest wins, ties prefer the longer name.
    const candidates = [];
    const wordRe = /[A-Za-z0-9][A-Za-z0-9._/-]*/g;
    let m;
    while ((m = wordRe.exec(text))) {
      const token = m[0].replace(/[._/-]+$/, "");
      if (token && names.has(token) && ISSUE_BRANCH_RE.test(token)) candidates.push({ token, index: m.index });
    }
    let branch;
    let reason;
    if (candidates.length) {
      candidates.sort((a, b) => a.index - b.index || b.token.length - a.token.length);
      branch = candidates[0].token;
      reason = `issue 正文中最先出现的真实分支名 “${branch}”`;
    } else {
      // The repository's real default branch, read directly. No fallback: a missing default is a visible error, never
      // the workspace's own (possibly feature) baseBranch and never a guessed main/master.
      const info = await github.getRepo(repo);
      if (!info?.defaultBranch) throw new HttpError(502, `无法读取 ${repo} 的默认分支，停止`);
      branch = info.defaultBranch;
      reason = `使用仓库默认分支 ${branch}（正文未出现有效分支名）`;
    }
    return { branch, reason, all: [...names] };
  }

  /** Resolve a branch to its SHA or throw. */
  async function pinnedSha(repo, branch) {
    const b = await github.getBranch(repo, branch);
    if (!b?.sha || !SHA_RE.test(b.sha)) throw new HttpError(502, `无法取得分支 ${branch} 的 commit SHA，停止`);
    return b.sha;
  }

  /** Build the discussion start message: issue + baseline + related PRs + sibling sessions + host docs excerpt. */
  async function discussionMessage({ ws, issue, comments, baseline, relatedPulls, siblings, docsNote }) {
    // comments are the full list read from GitHub (a failed read never gets here); the body is never cut silently
    const commentLines =
      comments.length === 0
        ? "（无评论）"
        : comments.map((c, i) => `  ${i + 1}. ${c.author ?? "unknown"}: ${String(c.body).trim()}`).join("\n");
    // Open PRs whose base is the selected baseline branch. This is NOT a search for PRs referencing the issue.
    const prLines =
      relatedPulls === null
        ? "（未取得：读取所选基线的 open PR 失败）"
        : relatedPulls.length === 0
          ? "（所选基线没有 open PR；不代表 issue 没有关联 PR）"
          : relatedPulls.map((p) => `  - #${p.number} ${p.url ?? ""} (head ${p.headRef} → base ${p.baseRef})`).join("\n");
    const sibLines =
      siblings.length === 0
        ? "（同空间仅此会话）"
        : siblings.map((s) => `  - ${s.name}：${s.busy === null ? "busy/queued 未取得" : `${s.busy ? "busy" : "not busy"}，queued ${s.queued}`}`).join("\n");
    return [
      `Issue 讨论（issue-loop spike）。不要开始实现：先分析问题、相关代码和待确认事项。`,
      ``,
      `== Issue 来源 ==`,
      `${issue.url}`,
      `标题: ${issue.title}`,
      ``,
      `== Issue 正文 ==`,
      String(issue.body).trim() || "（空）",
      ``,
      `== 评论 ==`,
      commentLines,
      ``,
      `== 基线 ==`,
      `分支: ${baseline.branch}（${baseline.reason}）`,
      `commit: ${baseline.sha}`,
      `工作目录: ${baseline.dir}（detached HEAD，无新功能分支；不要切换或 reset 原仓库目录）`,
      ``,
      `== 所选基线的 open PR（不是关联搜索）==`,
      prLines,
      ``,
      `== 同空间其他会话（不复制其聊天）==`,
      sibLines,
      ``,
      `== 安全规则 ==`,
      SPIKE_RULES,
      ``,
      `== 审批 ==`,
      `审批扩展仍然生效；被拒绝的操作不重试。`,
      ``,
      `== 宿主项目摘录（不是目标仓库内容）==`,
      docsNote,
      ``,
      `请先阅读当前目录（detached @ ${baseline.sha.slice(0, 12)}）的相关代码与本 issue，给出问题分析、可能涉及的代码位置和待确认事项；在你确认前不要写实现代码。`,
    ].join("\n");
  }

  /** Create (or reuse) the detached-baseline discussion session of one issue. Returns the `discussion` object the
   * route response carries. Shared with the github-events sync (auto-create on new issues); not a generic service. */
  async function startDiscussion(ws, issueNo) {
    // Sequential repeat of the same click: the same workspace + issue discussion already exists. Return it without
    // touching GitHub or the Sprite — no worktree command and no start message is sent again.
    const existing = findDiscussion(ws.id, issueNo);
    if (existing) {
      const meta = existing.issueLoop;
      return {
        botId: existing.id,
        name: existing.name,
        conversationId: existing.conversationId,
        workspaceId: ws.id,
        issue: issueNo,
        baseBranch: meta.baseBranch,
        pinnedSha: meta.pinnedSha,
        dir: meta.dir,
        existing: true,
      };
    }

    // Every GitHub read here is required: a failure stops the request with the real error (no empty-list fallback).
    let issue;
    let comments;
    try {
      issue = await github.getIssue(ws.repo, issueNo);
      if (issue) comments = await github.listIssueComments(ws.repo, issueNo, { limit: COMMENT_LIMIT + 1 });
    } catch (e) {
      throw mapError(e);
    }
    // A list that reaches the limit is not the whole discussion: stop visibly instead of sending a silently cut list.
    if (comments && comments.length > COMMENT_LIMIT) {
      throw new HttpError(409, `issue #${issueNo} has more than ${COMMENT_LIMIT} comments; the spike does not truncate them silently`);
    }
    if (!issue) throw new HttpError(404, `issue #${issueNo} not found (or is a PR) in ${ws.repo}`);

    let baseline;
    try {
      baseline = await pickBaseline(ws.repo, issue.body);
      baseline.sha = await pinnedSha(ws.repo, baseline.branch);
    } catch (e) {
      throw mapError(e);
    }

    // Open PRs whose base is the selected baseline branch (context only). Not an issue-reference search.
    let relatedPulls;
    try {
      relatedPulls = await github.listPullsByBase(ws.repo, baseline.branch);
    } catch (e) {
      relatedPulls = null; // stated as 未取得 in the start message, never as "none"
    }

    const dirId = sha256(`${ws.id}:${issueNo}:${baseline.sha}`).slice(0, 8);
    const dir = `${app.ctx.homeDir?.() ?? "/home/sprite"}/issue-loop/${ws.id}/discussion-${dirId}`;
    baseline.dir = dir;

    // Detached worktree at the pinned commit, outside the original repo dir. Never touches ws.cwd, never makes a branch.
    const repoDir = shellQuote([ws.cwd]);
    // Fetch the baseline BRANCH (a refspec that always resolves), then detach the worktree at the pinned SHA object.
    const addCmd =
      `mkdir -p ${shellQuote([posixDir(dir)])} && ` +
      `git -C ${repoDir} fetch origin ${shellQuote([baseline.branch])} && ` +
      `git -C ${repoDir} worktree add --detach ${shellQuote([dir])} ${shellQuote([baseline.sha])}`;
    try {
      await sh(ws, addCmd);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      throw e; // recorded: the worktree may or may not exist; nothing auto-deleted
    }

    const name = freeSessionName(`issue-${issueNo}-discuss`);
    const message = await discussionMessage({
      ws,
      issue,
      comments,
      baseline,
      relatedPulls,
      siblings: await siblingSessions(ws.id),
      docsNote: hostAgentsExcerpt(),
    });

    const bot = await bots.createBot({
      name,
      model: ws.model,
      cwd: dir,
      instructions: `Issue 讨论 Session（detached 基线 ${baseline.branch} @ ${baseline.sha}）。分析 issue 与代码，不开始实现。\n${SPIKE_RULES}`,
      // Drop the generic cd/clone/pull/branch/PR workflow preamble. AgentChange.extensions.remove takes Extension objects
      // (names are read from `.name`), so the real Preamble object is passed; a plain string would silently remove nothing.
      extensions: { remove: [Preamble] },
      workspaceId: ws.id,
      status: "discussing",
      issueLoop: { issue: issueNo, baseBranch: baseline.branch, pinnedSha: baseline.sha, dir },
    });
    control.links.link({ conversationId: String(bot.conversationId), workspaceId: ws.id, botId: bot.id });
    const conv = await bots.conversation(bot.id);
    if (!conv) throw new HttpError(500, "conversation not found for new discussion session");
    await conv.submit({ type: "input", content: message }, ctx);

    return {
      botId: bot.id,
      name: bot.name,
      conversationId: bot.conversationId,
      workspaceId: ws.id,
      issue: issueNo,
      baseBranch: baseline.branch,
      baselineReason: baseline.reason,
      pinnedSha: baseline.sha,
      dir,
    };
  }

  // POST /api/workspaces/:id/issue-loop/discuss {issue}
  app.post("/api/workspaces/:id/issue-loop/discuss", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const issueNo = Number(b.issue);
    if (!Number.isInteger(issueNo) || issueNo <= 0) throw new HttpError(400, "issue must be a positive integer");
    const ws = assertIssueLoopWorkspace(params.id);
    return { discussion: await startDiscussion(ws, issueNo) };
  });

  /** Other sessions in this workspace: name plus busy/queued read from the conversation view. Unreadable -> null (never
   * reported as idle). Idle is not "finished": the system has no business completion state. */
  async function siblingSessions(wsId, exceptBotId) {
    const links = control.links.conversationsOf(wsId);
    const byConv = new Map(links.map((l) => [l.conversationId, l]));
    const out = [];
    for (const bot of bots.list()) {
      if (bot.id === exceptBotId || !byConv.has(String(bot.conversationId))) continue;
      let busy = null;
      let queued = null;
      try {
        const conv = await bots.conversation(bot.id);
        const view = conv ? await conv.viewState(ctx) : undefined;
        try {
          busy = view?.value?.docs?.["pi.live"]?.run != null;
          queued = view?.value?.docs?.["pi.inbox"]?.items?.length ?? 0;
        } finally {
          view?.dispose?.();
        }
      } catch {
        // leave null: the start message says the status could not be read
      }
      out.push({ name: bot.name, busy, queued });
    }
    return out;
  }

  const posixDir = (p) => p.replace(/\/[^/]*$/, "") || "/";

  // ---- add session (SPIKE-add-session) -----------------------------------------------------------------------------
  // A blank, manually added session in an existing ready workspace: fresh conversation, no issue, no first message, no
  // model call. It gets its own detached worktree at the repo default branch's current commit on the SAME Sprite, so it
  // never touches the workspace's own directory or feature branch.

  // POST /api/workspaces/:id/sessions {name}
  app.post("/api/workspaces/:id/sessions", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const name = optString(b, "name", 60) ?? "新 Session";
    const ws = assertIssueLoopWorkspace(params.id);

    // The repo's real default branch and its current commit: the same two reads the discussion route uses.
    let baseBranch;
    let sha;
    try {
      const info = await github.getRepo(ws.repo);
      if (!info?.defaultBranch) throw new HttpError(502, `无法读取 ${ws.repo} 的默认分支，停止`);
      baseBranch = info.defaultBranch;
      sha = await pinnedSha(ws.repo, baseBranch);
    } catch (e) {
      throw mapError(e);
    }

    // Random id: every add gets its own directory, so repeated adds never collide.
    const dirId = randomUUID().slice(0, 8);
    const dir = `${app.ctx.homeDir?.() ?? "/home/sprite"}/sessions/${ws.id}/session-${dirId}`;
    // Detached at the pinned commit, outside the workspace directory. Never touches ws.cwd's branch or checkout.
    const addCmd =
      `mkdir -p ${shellQuote([posixDir(dir)])} && ` +
      `git -C ${shellQuote([ws.cwd])} fetch origin ${shellQuote([baseBranch])} && ` +
      `git -C ${shellQuote([ws.cwd])} worktree add --detach ${shellQuote([dir])} ${shellQuote([sha])}`;
    await sh(ws, addCmd);

    const bot = await bots.createBot({
      name: uniqueSessionName(name, dirId),
      model: ws.model,
      cwd: dir,
      instructions: `手动添加的 Session（detached @ ${sha}，仓库默认分支 ${baseBranch}）。工作目录 ${dir}。按用户的第一条消息执行。\n${SPIKE_RULES}`,
      extensions: { remove: [Preamble] },
      workspaceId: ws.id,
      status: "discussing",
      worktree: { baseBranch, pinnedSha: sha, dir },
    });
    // Linked at once, same as the issue-loop routes: an unlinked Bot carrying workspaceId is adopted by the service.
    control.links.link({ conversationId: String(bot.conversationId), workspaceId: ws.id, botId: bot.id });

    return {
      session: { botId: bot.id, name: bot.name, conversationId: bot.conversationId, workspaceId: ws.id, baseBranch, pinnedSha: sha, dir },
    };
  });

  // POST /api/workspaces/:id/issue-loop/publish {botId, task}
  app.post("/api/workspaces/:id/issue-loop/publish", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const srcId = typeof b.botId === "string" ? b.botId.trim() : "";
    const task = typeof b.task === "string" ? b.task : undefined;
    if (!srcId) throw new HttpError(400, "botId is required");
    if (task === undefined || task === null || typeof task !== "string") throw new HttpError(400, "task must be a string");
    if (!task.trim()) throw new HttpError(400, "task is required");
    const ws = assertIssueLoopWorkspace(params.id);

    const src = bots.get(srcId);
    if (!src) throw new HttpError(404, `discussion session not found: ${srcId}`);
    const meta = src.issueLoop;
    if (!meta || !SHA_RE.test(String(meta.pinnedSha ?? ""))) throw new HttpError(409, `session ${srcId} has no pinned baseline (not an issue-loop discussion)`);
    const link = control.links.workspaceOf(String(src.conversationId));
    if (!link || link.id !== ws.id) throw new HttpError(409, `session ${srcId} does not belong to workspace ${ws.id}`);

    const issueNo = meta.issue;
    const pinnedSha = String(meta.pinnedSha);
    const dirId = sha256(`${ws.id}:${issueNo}:${src.id}:${task.slice(0, 200)}`).slice(0, 8);
    const branch = `tarsbot/issue-${issueNo}-${src.id}`;
    const dir = `${app.ctx.homeDir?.() ?? "/home/sprite"}/issue-loop/${ws.id}/execution-${dirId}`;

    const repoDir = shellQuote([ws.cwd]);
    const addCmd = `mkdir -p ${shellQuote([posixDir(dir)])} && git -C ${repoDir} worktree add -b ${shellQuote([branch])} ${shellQuote([dir])} ${shellQuote([pinnedSha])}`;
    try {
      await sh(ws, addCmd);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      throw e;
    }

    const name = freeSessionName(`issue-${issueNo}-exec`);
    const bot = await bots.createBot({
      name,
      model: ws.model,
      cwd: dir,
      instructions: `Issue 执行 Session：分支 ${branch}，从 pinned commit ${pinnedSha} 检出。工作目录 ${dir}。按用户任务执行。\n${SPIKE_RULES}`,
      extensions: { remove: [Preamble] },
      workspaceId: ws.id,
      status: "executing",
      issueLoop: { issue: issueNo, baseBranch: meta.baseBranch, pinnedSha, dir, branch, sourceBotId: src.id },
    });
    control.links.link({ conversationId: String(bot.conversationId), workspaceId: ws.id, botId: bot.id });
    const conv = await bots.conversation(bot.id);
    if (!conv) throw new HttpError(500, "conversation not found for new execution session");
    // The first user message is the human's task verbatim: no issue text, no discussion history, no hand-off.
    await conv.submit({ type: "input", content: task }, ctx);

    return {
      execution: {
        botId: bot.id,
        name: bot.name,
        conversationId: bot.conversationId,
        workspaceId: ws.id,
        sourceBotId: src.id,
        issue: issueNo,
        branch,
        pinnedSha,
        dir,
      },
    };
  });

  // ---- PR review (SPIKE-review-loop) ---------------------------------------------------------------------------------
  // One-click PR review inside ONE existing ready workspace and its ONE Sprite: fetch the real PR from the bound repo,
  // pin its head SHA, check it out detached in a fresh worktree and start a fresh review-only session. No new Sprite,
  // no branch, no comment/approval/merge on GitHub. Same workspaceId + PR number + head SHA reuses the session; a
  // moved head creates a new review. Sequential repeat clicks only — no concurrency lock.

  /** Build the review start message: PR metadata + the real diff, labelled and capped. */
  function reviewMessage({ ws, pull, dir, diff }) {
    return [
      `PR Review Session（review-loop spike）。只审查，不改代码、不提交、不推送、不在 GitHub 上评论、不审批或合并这个 PR。`,
      ``,
      `== Pull Request ==`,
      `#${pull.number} ${pull.url}`,
      `标题: ${pull.title || "（无标题）"}`,
      `作者: ${pull.author ?? "unknown"} · 状态: ${pull.state ?? "unknown"}`,
      `base: ${pull.baseRef ?? "?"} @ ${pull.baseSha ?? "?"}`,
      `head: ${pull.headRef ?? "?"} @ ${pull.headSha}`,
      ``,
      `== PR 正文 ==`,
      String(pull.body ?? "").trim() || "（空）",
      ``,
      `== 工作目录 ==`,
      `${dir}（detached HEAD @ ${pull.headSha}，PR head；不要切换或 reset 原仓库目录 ${ws.cwd}）`,
      ``,
      `== 真实 diff（${REVIEW_DIFF_LIMIT} 字符上限；超限则整体失败，不静默截断）==`,
      diff.trim() || "（diff 为空）",
      ``,
      `== 安全规则 ==`,
      SPIKE_RULES,
      ``,
      `== 审批 ==`,
      `审批扩展仍然生效；被拒绝的操作不重试。`,
      ``,
      `请审查以上 diff 与当前目录中的相关代码，列出：具体问题（带证据与文件位置）、影响、以及建议的人工验证方式。不要修改任何文件。`,
    ].join("\n");
  }

  /** A bot's review metadata matches when it reviews this PR at this head SHA in this workspace. Same-workspace
   * membership mirrors findDiscussion: a direct workspaceId OR an actual conversation link — a record that lost its
   * workspaceId (crash between createBot and link, or an older link-adopted record) must still be reused, never
   * duplicated into a second review session. */
  const isSameReview = (bot, wsId, prNumber, headSha, linked) =>
    bot?.review && bot.review.pr === prNumber && bot.review.headSha === headSha && (bot.workspaceId === wsId || linked.has(bot.id));

  /** Create (or reuse) the detached review session of one PR at its current head SHA. Returns the `review` object the
   * route response carries. Shared with the github-events sync (auto-create on new PRs); not a generic service. */
  async function startReview(ws, prNumber) {
    // The PR number must be a real PR in this workspace's own repo — no arbitrary links, no guessed fields.
    let pull;
    try {
      pull = await github.getPull(ws.repo, prNumber);
    } catch (e) {
      throw mapError(e);
    }
    if (!pull) throw new HttpError(404, `pull request #${prNumber} not found in ${ws.repo}`);
    if (!pull.headSha || !SHA_RE.test(pull.headSha)) throw new HttpError(502, `无法取得 PR #${prNumber} 的 head SHA，停止`);

    // Same workspace + PR + head SHA: reuse the existing review session (sequential repeat click).
    const linked = new Set(control.links.conversationsOf(ws.id).map((l) => l.botId));
    const existing = bots.list().find((bot) => isSameReview(bot, ws.id, prNumber, pull.headSha, linked));
    if (existing) {
      return {
        botId: existing.id,
        name: existing.name,
        conversationId: existing.conversationId,
        workspaceId: ws.id,
        pr: prNumber,
        title: pull.title,
        url: pull.url,
        headSha: pull.headSha,
        baseSha: pull.baseSha,
        dir: existing.review.dir,
        reused: true,
      };
    }

    // The real diff for the review message. No fallback: a failed or missing diff fails the request outright —
    // a review session must never start without the diff it is supposed to review.
    let diff;
    try {
      diff = await github.getPullDiff(ws.repo, prNumber);
    } catch (e) {
      throw mapError(e);
    }
    if (diff === null) throw new HttpError(502, `无法取得 PR #${prNumber} 的 diff，停止；不创建不带 diff 的 review`);
    if (diff.length > REVIEW_DIFF_LIMIT) {
      throw new HttpError(409, `PR #${prNumber} diff exceeds ${REVIEW_DIFF_LIMIT} characters; the spike does not truncate it silently`);
    }

    // Detached worktree at the pinned head SHA. refs/pull/<n>/head resolves the head object for same-repo and fork PRs.
    const dirId = sha256(`${ws.id}:review:${prNumber}:${pull.headSha}`).slice(0, 8);
    const dir = `${app.ctx.homeDir?.() ?? "/home/sprite"}/reviews/${ws.id}/pr-${prNumber}-${dirId}`;
    const repoDir = shellQuote([ws.cwd]);
    const addCmd =
      `mkdir -p ${shellQuote([posixDir(dir)])} && ` +
      `git -C ${repoDir} fetch origin ${shellQuote([`pull/${prNumber}/head`])} && ` +
      `git -C ${repoDir} worktree add --detach ${shellQuote([dir])} ${shellQuote([pull.headSha])}`;
    await sh(ws, addCmd);

    const name = freeSessionName(`pr-${prNumber}-review`);
    const message = reviewMessage({ ws, pull, dir, diff });
    const bot = await bots.createBot({
      name,
      model: ws.model,
      cwd: dir,
      instructions:
        `PR Review Session：${ws.repo} PR #${prNumber}（detached @ ${pull.headSha}）。只审查代码，不修改、不提交、不推送、不评论 GitHub、不审批不合并。\n${SPIKE_RULES}`,
      extensions: { remove: [Preamble] },
      workspaceId: ws.id,
      status: "discussing",
      review: { pr: prNumber, title: pull.title, baseBranch: pull.baseRef ?? undefined, headSha: pull.headSha, dir },
    });
    control.links.link({ conversationId: String(bot.conversationId), workspaceId: ws.id, botId: bot.id });
    const conv = await bots.conversation(bot.id);
    if (!conv) throw new HttpError(500, "conversation not found for new review session");
    await conv.submit({ type: "input", content: message }, ctx);

    return {
      botId: bot.id,
      name: bot.name,
      conversationId: bot.conversationId,
      workspaceId: ws.id,
      pr: prNumber,
      title: pull.title,
      url: pull.url,
      headSha: pull.headSha,
      baseSha: pull.baseSha,
      dir,
      reused: false,
    };
  }

  // POST /api/workspaces/:id/review {pr} -> {review:{botId,name,conversationId,workspaceId,pr,title,url,headSha,baseSha,dir,reused}}
  app.post("/api/workspaces/:id/review", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const prNumber = Number(b.pr);
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new HttpError(400, "pr must be a positive integer");
    const ws = assertIssueLoopWorkspace(params.id);
    return { review: await startReview(ws, prNumber) };
  });

  // ---- session status + execution result (SPIKE-review-loop) ----------------------------------------------------------
  // Four business labels a human sets on a session: 讨论中 / 待确认 / 执行中 / 已完成. They are explicit human state,
  // never inferred from busy/idle. Stored on the Bot record (bots.json); no schema migration — a session without a
  // stored status shows its origin default on the client.

  // POST /api/workspaces/:id/sessions/:botId/status {status} -> {botId,status}
  app.post("/api/workspaces/:id/sessions/:botId/status", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const status = typeof b.status === "string" ? b.status : "";
    if (!SESSION_STATUSES.includes(status)) throw new HttpError(400, `status must be one of: ${SESSION_STATUSES.join(", ")}`);
    const ws = assertIssueLoopWorkspace(params.id);
    const bot = bots.get(params.botId);
    if (!bot) throw new HttpError(404, `session not found: ${params.botId}`);
    const link = control.links.workspaceOf(String(bot.conversationId));
    if (!link || link.id !== ws.id) throw new HttpError(409, `session ${params.botId} does not belong to workspace ${ws.id}`);
    if (typeof bots.update !== "function") throw new HttpError(503, "bot registry cannot persist status");
    bots.update(bot.id, { status });
    return { botId: bot.id, status };
  });

  // POST /api/workspaces/:id/sessions/:botId/result {summary, tests?, pr?} -> {result:{...}}
  // Human-reported execution result for an execution session. Tests are labelled human-entered text, never a
  // passed/failed verdict. `pr` is verified against the workspace's own repo before it is stored — no arbitrary links.
  app.post("/api/workspaces/:id/sessions/:botId/result", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const summary = typeof b.summary === "string" ? b.summary.trim() : "";
    if (!summary) throw new HttpError(400, "summary is required");
    if (summary.length > 20_000) throw new HttpError(400, "summary is too long (max 20000 characters)");
    const tests = optString(b, "tests", 20_000);
    const ws = assertIssueLoopWorkspace(params.id);
    const bot = bots.get(params.botId);
    if (!bot) throw new HttpError(404, `session not found: ${params.botId}`);
    const link = control.links.workspaceOf(String(bot.conversationId));
    if (!link || link.id !== ws.id) throw new HttpError(409, `session ${params.botId} does not belong to workspace ${ws.id}`);
    if (!bot.issueLoop?.sourceBotId) throw new HttpError(409, `session ${params.botId} is not an execution session (no source issue)`);
    if (typeof bots.update !== "function") throw new HttpError(503, "bot registry cannot persist the result");

    let pull;
    if (b.pr !== undefined && b.pr !== null && b.pr !== "") {
      const prNumber = Number(b.pr);
      if (!Number.isInteger(prNumber) || prNumber <= 0) throw new HttpError(400, "pr must be a positive integer");
      try {
        pull = await github.getPull(ws.repo, prNumber);
      } catch (e) {
        throw mapError(e);
      }
      if (!pull) throw new HttpError(404, `pull request #${prNumber} not found in ${ws.repo}`);
      pull = { number: pull.number, title: pull.title, url: pull.url, state: pull.state, headSha: pull.headSha };
    }

    const result = {
      summary,
      // Explicitly human-entered text. Never rendered as an automated pass/fail badge; absent means 未记录.
      testsReportedByHuman: tests ?? null,
      pull: pull ?? null,
      issue: bot.issueLoop.issue,
      sourceBotId: bot.issueLoop.sourceBotId,
      reportedAt: new Date().toISOString(),
    };
    bots.update(bot.id, { executionResult: result });
    return { result: { botId: bot.id, ...result } };
  });

  // Narrow reuse surface for the github-events route (AMP13-events): it may start the same discussion / review
  // sessions the buttons above start. Only these two functions are exposed — the workspace service itself is not.
  app.ctx.workspaceSessions = { startDiscussion, startReview };
}
