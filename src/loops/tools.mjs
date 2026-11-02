// Scoped GitHub write tools for loop Sessions (Issue14 Phase2).
//
// The extension is added to a loop run's agent ONLY when capabilities.github has at least one switch on —
// tool presence is the first permission boundary. Every tool additionally re-checks the run's persisted
// capabilities + scopeToTrigger server-side before touching GitHub, and the token is held by the server
// `github` client (never in the session env).
//
// All tool names start with send_* so the Approval extension's DEFAULT_TOOL_NAMES wildcard ("send_*")
// requires a human approval for every call — Phase2 mandates approval on every GitHub write (no autoApprove).
//
// The scope rule: when capabilities.github.scopeToTrigger is true (default), comment/label/PR-open operations
// may only target the entity that triggered the run (or, for open_pr, the run's own branch). Trigger-less runs
// (manual/schedule/webhook without a GitHub entity) get a clear refusal.
import { randomUUID } from "node:crypto";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { approvals, createClassifier } from "../ext/approval.mjs";
import { shellQuote as shellQuoteStr } from "../env.mjs";

/**
 * Loop-scoped bash boundaries, applied ONLY to loop-run sessions (routine sessions untouched):
 *   - HARD BLOCK (no approval path): every GitHub remote shell route — `gh` CLI entirely,
 *     `git push/fetch/pull/remote`, and curl/wget requests to github.com. GitHub writes for loops go
 *     exclusively through the send_github_* tools (server-side token, fixed arguments, approval each).
 *     The session's bash also runs with GH_TOKEN stripped (execEnv), so no credential exists to route around.
 *   - The hard block answers `{block}` — a human cannot approve around a disabled capability.
 */
const LOOP_GH_BLOCK = [
  { pattern: /\bgh\s+[a-z]/i, reason: "gh CLI is disabled in loop sessions (use the send_github_* tools)" },
  { pattern: /\bgit\s+push\b/, reason: "git push is disabled in loop sessions (branches are published by the run)" },
  { pattern: /\bgit\s+(?:fetch|pull|remote)\b/, reason: "git remote operations are disabled in loop sessions" },
  { pattern: /\b(?:curl|wget)\b[^\n;|&]*github\.com/i, reason: "direct GitHub HTTP calls are disabled in loop sessions" },
];

/** Approval-gated secondary guard for any GitHub-write shell route the hard block missed (aliases/wrappers). */
const LOOP_GH_WRITE_APPROVAL = [
  { pattern: /\bhub\s+[a-z]/i, reason: "hub CLI GitHub operations need approval in loop sessions" },
];

const loopBlockClassifier = createClassifier({ bash: LOOP_GH_BLOCK, toolNames: [] });
const loopApprovalClassifier = createClassifier({ bash: LOOP_GH_WRITE_APPROVAL, toolNames: [] });

// Late-bound deps — LoopApproval is installed in the registry at harness-open time, while the tools'
// deps (botOfConversation etc.) arrive with createLoops. Shared binding below.
let boundTools;
export function bindLoopGithubTools(deps) {
  boundTools = deps;
}
const toolsDeps = () => {
  if (!boundTools) throw new Error("loop github tools are not bound (createLoops not wired)");
  return boundTools;
};

/**
 * Loop-scoped session guard: hard-blocks GitHub remote shell routes and approval-gates residual write
 * commands — loop-run conversations only (bot carries loopRun); routine sessions no-op. The memo key is
 * loop-scoped so it never collides with the global hook's "approval" memo on the same task; the same shared
 * ApprovalCenter serves both (one human queue).
 */
export const LoopApproval = defineExtension({
  name: "tarsbot.loops.approval",
  hooks: [
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        if (!boundTools) return undefined;
        const bot = await boundTools.botOfConversation?.(api.conversationId, context);
        if (!bot?.loopRun?.runId) return undefined; // routine sessions keep the global rules only
        const blocked = loopBlockClassifier(call);
        if (blocked !== undefined) return { block: `Loop boundary: ${blocked}` };
        const reason = loopApprovalClassifier(call);
        if (reason === undefined) return undefined;
        let ok = await api.memo("loop-approval", context);
        if (ok === undefined) {
          const verdict = await approvals.request({
            taskId: api.taskId,
            conversationId: api.conversationId,
            toolName: call.name,
            args: call.arguments,
            reason,
            signal: context?.abortSignal,
          });
          ok = await api.memo("loop-approval", verdict, context);
        }
        if (ok === false) return { block: `User denied: ${reason}` };
        return undefined;
      },
    }),
  ],
});

const BODY_LIMIT = 4000;
const TITLE_LIMIT = 200;
const LABELS_LIMIT = 10;

const err = (msg) => {
  throw new Error(String(msg));
};
const refuse = (msg) => ({ output: [{ type: "text", text: `REFUSED: ${msg}` }], details: { refused: true } });

/** Pull {loopId, runId, repo, entityRef, capabilities} for this conversation's loop run, or undefined. */
async function runContext(deps, api, context) {
  const bot = await deps.botOfConversation?.(api.conversationId, context);
  const lr = bot?.loopRun;
  if (!lr?.runId) return undefined;
  const run = deps.loopRuns.get(lr.runId);
  if (!run) return undefined;
  const loop = deps.loops.get(run.loopId);
  // Capabilities come from the run's enqueue-time SNAPSHOT (payload.capabilities), never the live loop —
  // editing a loop must not widen the permissions of a run that already exists.
  const caps = run.payload?.capabilities ?? loop?.capabilities ?? {};
  return { run, loop, caps, entity: run.payload?.entity ?? null, ws: deps.workspaceOf?.(run.workspaceId) };
}

const checkScope = (ctx, kind, number) => {
  const scoped = ctx.caps.scopeToTrigger !== false; // default on; lives at capabilities.scopeToTrigger
  if (!scoped) return null;
  const entity = ctx.entity;
  if (!entity || entity.kind !== kind || entity.number !== number) {
    return `scopeToTrigger: this run may only act on its triggering ${entity ? `${entity.kind} #${entity.number}` : "entity (none recorded)"} — ${kind} #${number} is out of scope`;
  }
  return null;
};

const capCheck = (ctx, key) => {
  const caps = ctx.caps.github ?? {};
  return caps[key] === true ? null : `capabilities.github.${key} is disabled for this loop`;
};

/**
 * @param {{ loopRuns: object, loops: object, github: object, botOfConversation: (id, ctx) => Promise<object|undefined>,
 *   workspaceOf?: (id) => object, record?: (runId, patch) => void }} deps
 *   record() persists run artifacts (pr_number / suggested draft) into loop_runs.
 */
export function createLoopGithubTools(deps) {
  return buildGithubTools(() => deps);
}

// The registry needs ONE extension object at harness-open time, before createLoops exists — the shared
// singleton resolves boundTools lazily inside each tool execute. Loop sessions add THIS object via
// extensions.add (persisted by name, resolved through the registry).
export const LoopGithubToolsExt = buildGithubTools(toolsDeps);

function buildGithubTools(getDeps) {
  const D = getDeps;
  const need = (ctx, cap) => {
    const deps = D();
    if (!ctx) err("not a loop session (no loop run bound to this conversation)");
    const capMsg = capCheck(ctx, cap);
    if (capMsg) {
      const e = new Error(capMsg);
      e.refuse = true;
      throw e;
    }
    const ws = ctx.ws;
    const repo = ws?.repo ?? ctx.run?.payload?.repo ?? null;
    if (!repo) err("workspace has no bound repository");
    return repo;
  };

  const commentTool = defineTool({
    name: "send_github_comment",
    deferred: true,
    description:
      "Post ONE comment on a GitHub issue or pull request in the bound repository. Requires human approval. " +
      "When scopeToTrigger is on, only the entity that triggered this run may be commented on.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("issue"), Type.Literal("pr")], { description: "issue or pr" }),
      number: Type.Integer({ minimum: 1 }),
      body: Type.String({ minLength: 1, description: `Markdown comment body (max ${BODY_LIMIT} chars)` }),
    }),
    replay: "live",
    async execute(args, api, context) {
      const ctx = await runContext(D(), api, context);
      const repo = need(ctx, "comment");
      const scope = checkScope(ctx, args.kind, args.number);
      if (scope) return refuse(scope);
      const body = String(args.body);
      if (body.length > BODY_LIMIT) err(`body exceeds ${BODY_LIMIT} characters`);
      const r = await D().github.createIssueComment(repo, args.number, body);
      // Record the produced comment id so ingestion can drop OUR OWN comment events — the PAT actor is a
      // normal user, so the written id is the only reliable self-feedback marker.
      if (r?.id != null) D().markProduced?.(`produced:${r.id}`);
      D().record?.(ctx.run.id, { commented: [...(ctx.run.payload?.commented ?? []), { kind: args.kind, number: args.number, id: r.id ?? null, url: r.url }] });
      return { output: [{ type: "text", text: `Commented on ${args.kind} #${args.number}: ${r.url}` }], details: r };
    },
  });

  const labelTool = defineTool({
    name: "send_github_label",
    deferred: true,
    description: "Add labels to a GitHub issue or PR in the bound repository. Requires human approval.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("issue"), Type.Literal("pr")]),
      number: Type.Integer({ minimum: 1 }),
      labels: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: LABELS_LIMIT }),
    }),
    replay: "live",
    async execute(args, api, context) {
      const ctx = await runContext(D(), api, context);
      const repo = need(ctx, "label");
      const scope = checkScope(ctx, args.kind, args.number);
      if (scope) return refuse(scope);
      const labels = args.labels.map((l) => String(l));
      for (const l of labels) if (l.length > 100) err("label exceeds 100 characters");
      const applied = await D().github.addIssueLabels(repo, args.number, labels);
      return { output: [{ type: "text", text: `Labeled ${args.kind} #${args.number}: ${applied.join(", ")}` }], details: { labels: applied } };
    },
  });

  const openIssueTool = defineTool({
    name: "send_github_open_issue",
    deferred: true,
    description: "Open ONE new GitHub issue in the bound repository. Requires human approval.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, description: `Issue title (max ${TITLE_LIMIT} chars)` }),
      body: Type.Optional(Type.String({ description: `Body (max ${BODY_LIMIT} chars)` })),
      labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: LABELS_LIMIT })),
    }),
    replay: "live",
    async execute(args, api, context) {
      const ctx = await runContext(D(), api, context);
      const repo = need(ctx, "openIssue");
      const title = String(args.title);
      const body = String(args.body ?? "");
      if (title.length > TITLE_LIMIT) err(`title exceeds ${TITLE_LIMIT} characters`);
      if (body.length > BODY_LIMIT) err(`body exceeds ${BODY_LIMIT} characters`);
      const r = await D().github.createIssue(repo, {
        title,
        body,
        labels: Array.isArray(args.labels) ? args.labels.map((l) => String(l).slice(0, 100)) : undefined,
      });
      return { output: [{ type: "text", text: `Opened issue #${r.number}: ${r.url}` }], details: r };
    },
  });

  const pushTool = defineTool({
    name: "send_git_push",
    deferred: true,
    description:
      "Push this run's own branch (loops/<slug>/<runId>) to the bound GitHub remote — the ONLY push path in " +
      "a loop session. Server-fixed remote URL and exact refspec; git hooks, credential helpers, config " +
      "redirects and interactive prompts are disabled for the push. Requires human approval.",
    parameters: Type.Object({}),
    replay: "live",
    async execute(_args, api, context) {
      const ctx = await runContext(D(), api, context);
      if (!ctx) err("not a loop session (no loop run bound to this conversation)");
      const capMsg = capCheck(ctx, "openPr");
      if (capMsg) { const e = new Error(capMsg); e.refuse = true; throw e; }
      const branch = ctx.run.branch;
      // Actual generated run ids are run_<hex> (underscore) — the lock must accept real branches, nothing else.
      if (!branch || !/^loops\/[a-z0-9][a-z0-9_-]*\/[a-z0-9_-]+$/i.test(branch)) err(`refusing to push a non-run branch: ${branch}`);
      const ws = ctx.ws;
      const repo = ws?.repo ?? ctx.run?.payload?.repo ?? null;
      if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) err("workspace has no bound repository");
      const bot = await D().botOfConversation?.(api.conversationId, context);
      const workDir = bot?.loopRun?.dir ?? ctx.run.payload?.dir;
      if (!workDir) err("run has no worktree dir to push from");
      const bash = await D().runtimeBash?.(ctx.run.workspaceId);
      if (!bash) err("workspace runtime is unavailable");
      if (bash.supportsEnv !== true) err("workspace runtime cannot isolate push credentials");

      // The worktree's .git is agent-controlled (hooks, credential helpers, insteadOf rewrites, http.proxy,
      // extraHeader). The proven-false -c-append approach is replaced: we (1) export the run branch as a
      // TOKENLESS bundle from the worktree (a pure object dump — no remote, no credentials, no hooks), (2)
      // import it into a FRESH service-owned bare repo with no agent config, and (3) push from THAT clean
      // repo with the token-carrying command. The token only ever touches a git context the agent never
      // wrote to.
      const repoUrl = `https://github.com/${repo}.git`;
      const helper = "!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f";
      const stage = `/tmp/tars-loop-push-${randomUUID()}`;
      const bundle = `${stage}/b`;
      const ref = `refs/heads/${branch}`;
      const env0 = "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0";
      const steps = [
        // Stage 1 (tokenless): dump the exact ref. Bundle creation never reads a remote or asks credentials.
        `umask 077; mkdir ${shellQuoteStr([stage])}`,
        `${env0} git -C ${shellQuoteStr([workDir])} -c core.hooksPath=/dev/null bundle create ${shellQuoteStr([bundle])} ${shellQuoteStr([ref])}`,
        // Stage 2 (tokenless): fresh bare repo — no config copied, no agent hooks/helpers.
        `${env0} git -C ${shellQuoteStr([stage])} init --bare clean`,
        `${env0} git -C ${shellQuoteStr([`${stage}/clean`])} fetch ${shellQuoteStr([bundle])} ${shellQuoteStr([`${ref}:${ref}`])}`,
        // Stage 3 (token in ENV only): push the exact ref to the server-fixed URL. -c entries override every
        // agent config key that could fire or redirect; the helper reads $GH_TOKEN from env, never argv.
        `${env0} git -C ${shellQuoteStr([`${stage}/clean`])}` +
          ` -c core.hooksPath=/dev/null -c core.askPass=false -c protocol.version=2 -c http.proxy=` +
          ` -c ${shellQuoteStr([`credential.helper=`])}` +
          ` -c ${shellQuoteStr([`credential.helper=${helper}`])}` +
          ` -c ${shellQuoteStr([`url.${repoUrl}.insteadOf=${repoUrl}`])}` +
          ` push ${shellQuoteStr([repoUrl])} ${shellQuoteStr([`${ref}:${ref}`])}`,
      ];
      let last = null;
      try {
        for (const [index, cmd] of steps.entries()) {
          last = await bash(cmd, { timeoutMs: 120_000, ...(index < steps.length - 1 ? { env: { GH_TOKEN: "", GITHUB_TOKEN: "" } } : {}) });
          if (last?.timedOut) err("push timed out");
          if ((last?.exitCode ?? 1) !== 0) err(`push step failed (${last.exitCode}): ${String(last.stderr ?? last.stdout ?? "").slice(0, 300)}`);
        }
      } finally {
        await bash(`rm -rf ${shellQuoteStr([stage])}`, { timeoutMs: 15_000, env: { GH_TOKEN: "", GITHUB_TOKEN: "" } }).catch(() => {});
      }
      D().record?.(ctx.run.id, { pushed: { branch, remote: repoUrl, at: new Date().toISOString() } });
      return { output: [{ type: "text", text: `Pushed ${branch} to ${repoUrl}.` }], details: { branch, remote: repoUrl } };
    },
  });

  const openPrTool = defineTool({
    name: "send_github_open_pr",
    deferred: true,
    description:
      "Open ONE pull request from this run's own branch (head) against its base branch. Head and base are " +
      "always the run's recorded values — never a model-chosen ref, regardless of scopeToTrigger. The branch " +
      "must have been published with send_git_push first. Requires human approval; records the PR on the run.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, description: `PR title (max ${TITLE_LIMIT} chars)` }),
      body: Type.Optional(Type.String({ description: `Body (max ${BODY_LIMIT} chars)` })),
      draft: Type.Optional(Type.Boolean()),
    }),
    replay: "live",
    async execute(args, api, context) {
      const ctx = await runContext(D(), api, context);
      const repo = need(ctx, "openPr");
      // Head/base are run-owned invariants — never args — so scopeToTrigger=false cannot point the PR at a
      // foreign branch or base.
      const head = String(ctx.run.branch ?? "").trim();
      const base = String(ctx.run.payload?.baseBranch ?? "").trim();
      if (!head) err("this run has no branch to open a PR from");
      if (!base) err("this run has no recorded base branch");
      if (!ctx.run.payload?.pushed) {
        return refuse("the run's branch is not pushed yet — call send_git_push first");
      }
      const title = String(args.title);
      const body = String(args.body ?? "");
      if (title.length > TITLE_LIMIT) err(`title exceeds ${TITLE_LIMIT} characters`);
      if (body.length > BODY_LIMIT) err(`body exceeds ${BODY_LIMIT} characters`);
      // Body carries a clickable run link + the triggering entity so the PR is traceable without session text.
      const entity = ctx.entity;
      const runUrl = `${String(D().publicUrl ?? "").replace(/\/+$/, "")}/?loopRun=${ctx.run.id}`;
      const trailer = [
        "",
        "---",
        `Loop run: ${runUrl} (\`${ctx.run.id}\`, branch \`${head}\`)`,
        entity?.number ? `Trigger: ${entity.kind} #${entity.number}${entity.url ? ` — ${entity.url}` : ""}` : "",
      ].filter(Boolean).join("\n");
      const pr = await D().github.createPull(repo, { head, base, title, body: body + trailer, draft: args.draft === true });
      D().record?.(ctx.run.id, { prNumber: pr.number, prUrl: pr.url });
      return { output: [{ type: "text", text: `Opened PR #${pr.number}: ${pr.url}` }], details: pr };
    },
  });

  const suggestTaskTool = defineTool({
    name: "send_task_draft",
    deferred: true,
    description:
      "Save a suggested follow-up task for the human to confirm and publish. Nothing executes — the draft is " +
      "attached to this run and the user publishes it explicitly (draft → publish confirmation).",
    parameters: Type.Object({
      task: Type.String({ minLength: 1, description: `The task text the human may publish verbatim (max ${BODY_LIMIT} chars)` }),
      summary: Type.Optional(Type.String({ description: "One-line summary of why this task is suggested" })),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const ctx = await runContext(D(), api, context);
      if (!ctx) err("not a loop session (no loop run bound to this conversation)");
      const draft = { task: String(args.task).slice(0, BODY_LIMIT), summary: String(args.summary ?? "").slice(0, 500) };
      D().record?.(ctx.run.id, { suggestedTask: draft });
      return { output: [{ type: "text", text: "Task draft saved; waiting for the user to publish it." }], details: draft };
    },
  });

  return defineExtension({
    name: "tarsbot.loop.github",
    tools: [commentTool, labelTool, openIssueTool, pushTool, openPrTool, suggestTaskTool],
    sections: [
      {
        title: "Loop GitHub Tools",
        body: [
          "GitHub writes go through the send_github_* tools only (server-side token, human approval each call).",
          "When scopeToTrigger is on, comment/label/PR actions must target the entity that triggered this run.",
        ].join("\n"),
      },
    ],
  });
}
