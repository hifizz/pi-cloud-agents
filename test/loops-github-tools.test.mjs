// Phase 2 (Issue14): scoped GitHub write tools — capability gate, scopeToTrigger, approval naming, and the
// GitHub webhook HMAC verifier (machine auth inside the global guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { openControlStore } from "../src/control/store.mjs";
import { createLoopGithubTools } from "../src/loops/tools.mjs";
import { verifyGithubWebhook } from "../src/loops/github-webhook.mjs";
import { isDangerous } from "../src/ext/approval.mjs";

const WS_MODEL = { provider: "faux", modelId: "faux-1" };

function env({ githubCaps = {}, entity = { kind: "issue", number: 5 }, scopeToTrigger = true } = {}) {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "ws-1", projectId: project.id, name: "w", baseBranch: "main", branch: "b",
    cwd: "/home/sprite/w", model: WS_MODEL,
  });
  const capabilities = { code: "readwrite", web: true, scopeToTrigger, github: githubCaps };
  const loop = { id: "loop-1", workspaceId: workspace.id, capabilities };
  const run = store.loopRuns.enqueue({
    loopId: loop.id, loopVersion: 1, workspaceId: workspace.id,
    triggerKind: "github_issue", triggerKey: "gh:issue.opened:5",
    payload: { entity, baseBranch: "main", repo: "hifizz/tars-sandbox-playground" },
    entityRef: `${entity.kind}:${entity.number}`,
  }).run;
  const calls = [];
  const github = {
    createIssueComment: async (repo, n, body) => (calls.push(["comment", repo, n, body]), { id: 1, url: `u/c${n}` }),
    addIssueLabels: async (repo, n, labels) => (calls.push(["label", repo, n, labels]), labels),
    createIssue: async (repo, spec) => (calls.push(["issue", repo, spec]), { number: 99, url: "u/i99" }),
    createPull: async (repo, spec) => (calls.push(["pr", repo, spec]), { number: 42, url: "u/pr42" }),
  };
  const bot = { id: "bot-1", conversationId: "conv-1", loopRun: { loopId: loop.id, runId: run.id, dir: "/home/sprite/loops/w/rw-abc" } };
  const deps = {
    loopRuns: store.loopRuns,
    loops: { get: () => loop },
    github,
    botOfConversation: async () => bot,
    workspaceOf: () => workspace,
    record: (id, patch) => store.loopRuns.update(id, { payload: { ...store.loopRuns.get(id).payload, ...patch }, ...(patch.prNumber ? { prNumber: patch.prNumber } : {}) }),
  };
  return { store, run, calls, deps, loop, workspace };
}

// Find a tool by name on the built extension.
const toolOf = (ext, name) => ext.tools.find((t) => t.name === name);
const execTool = (ext, name, args, api = { conversationId: "conv-1" }) => toolOf(ext, name).execute(args, api, {});

test("tool names match the send_* approval wildcard — every GitHub write requires human approval", () => {
  const ext = createLoopGithubTools(env().deps);
  const names = ext.tools.map((t) => t.name);
  for (const n of names) assert.match(n, /^send_/, `${n} must be approval-gated by the send_* wildcard`);
  assert.equal(isDangerous({ name: "send_github_comment" }), "tool send_github_comment has external side effects");
  assert.equal(isDangerous({ name: "send_github_open_pr" }), "tool send_github_open_pr has external side effects");
});

test("comment tool: capability off -> refuse; wrong entity -> scopeToTrigger refuse; on-scope -> calls github", async () => {
  // comment disabled
  let e = env({ githubCaps: { comment: false } });
  let ext = createLoopGithubTools(e.deps);
  await assert.rejects(execTool(ext, "send_github_comment", { kind: "issue", number: 5, body: "hi" }), /comment.*disabled/);

  // comment enabled but wrong entity (issue #6 while trigger was #5)
  e = env({ githubCaps: { comment: true } });
  ext = createLoopGithubTools(e.deps);
  const refused = await execTool(ext, "send_github_comment", { kind: "issue", number: 6, body: "hi" });
  assert.match(refused.output[0].text, /REFUSED.*scopeToTrigger/, "out-of-scope entity is refused");
  assert.equal(e.calls.length, 0, "no github call happened");

  // on-scope
  const ok = await execTool(ext, "send_github_comment", { kind: "issue", number: 5, body: "looks good" });
  assert.match(ok.output[0].text, /Commented on issue #5/);
  assert.deepEqual(e.calls[0], ["comment", "hifizz/tars-sandbox-playground", 5, "looks good"]);
});

test("scopeToTrigger=false lifts the entity restriction (still approval-gated, still the bound repo)", async () => {
  const e = env({ githubCaps: { comment: true }, scopeToTrigger: false });
  const ext = createLoopGithubTools(e.deps);
  const ok = await execTool(ext, "send_github_comment", { kind: "issue", number: 99, body: "hi" });
  assert.match(ok.output[0].text, /Commented on issue #99/);
});

test("open_pr tool: requires openPr cap + pushed branch; head/base are run-owned; records pr_number", async () => {
  const e = env({ githubCaps: { openPr: true } });
  // A REAL generated run branch shape: loops/<slug>/run_<hex> (underscores!).
  const realBranch = "loops/gh/run_a1b2c3d4e5f6g7h8";
  e.store.loopRuns.update(e.run.id, { branch: realBranch });
  const pushed_cmds = [];
  const pushOptions = [];
  e.deps.runtimeBash = async () => Object.assign(async (cmd, options) => {
    pushed_cmds.push(cmd);
    pushOptions.push(options);
    return { exitCode: 0, stdout: "", stderr: "" };
  }, { supportsEnv: true });
  const ext = createLoopGithubTools(e.deps);
  // Not pushed yet -> refused
  const notYet = await execTool(ext, "send_github_open_pr", { title: "feat: x" });
  assert.match(notYet.output[0].text, /not pushed|send_git_push/, "open_pr requires the controlled push first");
  // Controlled push — staged: tokenless bundle export → fresh clean bare repo → token push from it.
  const pushed = await execTool(ext, "send_git_push", {});
  assert.match(pushed.output[0].text, new RegExp(`Pushed ${realBranch.replace(/\//g, "\\/")}`));
  const bundleCmd = pushed_cmds.find((c) => c.includes("bundle create"));
  const pushCmd = pushed_cmds.find((c) => / push '/.test(c));
  assert.ok(bundleCmd.includes(`git -C '/home/sprite/loops/w/rw-abc'`), "bundle is exported from the run worktree");
  assert.ok(bundleCmd.includes(`refs/heads/${realBranch}`), "bundle carries the exact ref");
  assert.match(pushCmd, /git -C '\/tmp\/tars-loop-push-[a-f0-9-]+\/clean'/);
  assert.deepEqual(pushOptions.slice(0, 4).map(o => o.env), Array(4).fill({ GH_TOKEN: "", GITHUB_TOKEN: "" }));
  assert.equal(pushOptions[4].env, undefined, "only the clean-context push receives provider credentials");
  assert.match(pushCmd, /GIT_CONFIG_NOSYSTEM=1/, "system config disabled");
  assert.match(pushCmd, /GIT_CONFIG_GLOBAL=\/dev\/null/, "global config disabled");
  assert.match(pushCmd, /GIT_TERMINAL_PROMPT=0/, "no interactive prompt");
  assert.match(pushCmd, /core\.hooksPath=\/dev\/null/, "hooks disabled");
  assert.ok(pushCmd.includes(`-c 'credential.helper=' -c 'credential.helper=!`), "helper list reset THEN the server helper appended — the first wins, agent helpers never run");
  assert.match(pushCmd, /insteadOf=https:\/\/github\.com\/hifizz\/tars-sandbox-playground\.git/, "longest-prefix identity rewrite");
  assert.match(pushCmd, /push 'https:\/\/github\.com\/hifizz\/tars-sandbox-playground\.git'/, "explicit https remote, never origin");
  assert.match(pushCmd, new RegExp(`refs/heads/${realBranch}:refs/heads/${realBranch}`), "exact refspec");
  assert.ok(!pushCmd.includes("token=") && !pushCmd.includes("ghp_"), "token never in argv — env only");
  // open_pr uses the run's own head/base; a foreign head arg is not even accepted as a parameter
  const ok = await execTool(ext, "send_github_open_pr", { title: "feat: x", head: "main" });
  assert.match(ok.output[0].text, /PR #42/);
  const prCall = e.calls.find((c) => c[0] === "pr");
  assert.equal(prCall[2].head, realBranch, "head is always the run's branch — args cannot override");
  assert.equal(prCall[2].base, "main", "base is the run's recorded baseBranch");
  assert.equal(e.store.loopRuns.get(e.run.id).prNumber, 42, "run records the PR artifact");
});

test("open_issue + label tools honor their capability switches", async () => {
  const e = env({ githubCaps: { openIssue: true, label: true } });
  const ext = createLoopGithubTools(e.deps);
  await execTool(ext, "send_github_open_issue", { title: "new bug", labels: ["bug"] });
  const labeled = await execTool(ext, "send_github_label", { kind: "issue", number: 5, labels: ["triaged"] });
  assert.match(labeled.output[0].text, /Labeled issue #5/);
  const denied = env({ githubCaps: { openIssue: false } });
  const ext2 = createLoopGithubTools(denied.deps);
  await assert.rejects(execTool(ext2, "send_github_open_issue", { title: "x" }), /openIssue.*disabled/);
});

test("send_task_draft saves a draft on the run; a non-loop conversation gets a hard error", async () => {
  const e = env({ githubCaps: {} });
  const ext = createLoopGithubTools(e.deps);
  const r = await execTool(ext, "send_task_draft", { task: "refactor the parser" });
  assert.match(r.output[0].text, /draft saved/i);
  assert.equal(e.store.loopRuns.get(e.run.id).payload.suggestedTask.task, "refactor the parser");

  const orphan = createLoopGithubTools({ ...e.deps, botOfConversation: async () => ({ id: "b", conversationId: "c", loopRun: undefined }) });
  await assert.rejects(orphan.tools[0].execute({ kind: "issue", number: 1, body: "x" }, { conversationId: "c" }, {}), /not a loop session/);
});

// ---- GitHub webhook HMAC verification ----

const fakeReq = (body, headers = {}) => {
  const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const stream = (async function* () { yield raw; })();
  return { headers, machineBody: undefined, [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), socket: { remoteAddress: "1.2.3.4" } };
};

const sign = (body, secret) => `sha256=${createHmac("sha256", secret).update(typeof body === "string" ? body : JSON.stringify(body)).digest("hex")}`;

test("github webhook: valid HMAC passes; bad signature 401; missing secret 503; missing delivery/event 400", async () => {
  const env1 = { TARSBOT_GITHUB_WEBHOOK_SECRET: "s3cret" };
  const body = JSON.stringify({ action: "opened", issue: { number: 1 } });
  const req = fakeReq(body, { "x-github-event": "issues", "x-github-delivery": "d-1", "x-hub-signature-256": sign(body, "s3cret") });
  const out = await verifyGithubWebhook(req, { env: env1 });
  assert.equal(out.deliveryId, "d-1");
  assert.equal(out.event, "issues");
  assert.ok(req.machineBody.length > 0, "raw body stashed for the route");

  const bad = fakeReq(body, { "x-github-event": "issues", "x-github-delivery": "d-2", "x-hub-signature-256": sign(body, "wrong") });
  await assert.rejects(verifyGithubWebhook(bad, { env: env1 }), /401|invalid/i);

  const noSecret = fakeReq(body, { "x-github-event": "issues", "x-github-delivery": "d-3", "x-hub-signature-256": sign(body, "s3cret") });
  await assert.rejects(verifyGithubWebhook(noSecret, { env: {} }), /503|not configured/);

  const noDelivery = fakeReq(body, { "x-github-event": "issues", "x-hub-signature-256": sign(body, "s3cret") });
  await assert.rejects(verifyGithubWebhook(noDelivery, { env: env1 }), /400|X-GitHub-Delivery/);
});

test("capabilities are read from the RUN's enqueue snapshot, never the live loop (no privilege expansion on edit)", async () => {
  const e = env({ githubCaps: { comment: true } });
  // The run payload carries the snapshot; editing the loop's capabilities afterwards must not widen the run.
  const snapshotCaps = { code: "readwrite", web: true, scopeToTrigger: true, github: { comment: true, label: false, openIssue: false, openPr: false } };
  e.store.loopRuns.update(e.run.id, { payload: { ...e.store.loopRuns.get(e.run.id).payload, capabilities: snapshotCaps } });
  // The "live" loop now claims every github cap — a snapshot-aware tool must still refuse label/openPr.
  e.deps.loops = { get: () => ({ id: "loop-1", workspaceId: e.workspace.id, capabilities: { code: "readwrite", web: true, scopeToTrigger: true, github: { comment: true, label: true, openIssue: true, openPr: true } } }) };
  const ext = createLoopGithubTools(e.deps);
  const ok = await execTool(ext, "send_github_comment", { kind: "issue", number: 5, body: "hi" });
  assert.match(ok.output[0].text, /Commented/, "snapshot-allowed cap still works");
  await assert.rejects(execTool(ext, "send_github_label", { kind: "issue", number: 5, labels: ["x"] }), /label.*disabled/, "widened live cap must NOT apply to the existing run");
});

test("loop-scoped hard block: gh/git-push/github-curl calls are denied (no approval path) for loop sessions", async () => {
  const e = scopedEnv();
  const { bindLoopGithubTools, LoopApproval } = await import("../src/loops/tools.mjs");
  bindLoopGithubTools(e.deps);
  const hook0 = LoopApproval.hooks[0].handlers.beforeTool;
  for (const cmd of ["gh pr create --title x", "git push -u origin loops/x/1", "git fetch origin", "curl -X POST https://api.github.com/repos/r/issues", "gh issue comment 1 -b x"]) {
    const r = await hook0({ name: "bash", arguments: { command: cmd } }, { conversationId: "conv-1", taskId: "t1" }, {});
    assert.ok(r?.block, `${cmd} must be hard-blocked, got ${JSON.stringify(r)}`);
  }
  // A normal git commit and a routine session are untouched.
  const ok = await hook0({ name: "bash", arguments: { command: "git commit -m x" } }, { conversationId: "conv-1", taskId: "t1" }, {});
  assert.equal(ok, undefined, "local git commit stays allowed");
  const orphan = await hook0({ name: "bash", arguments: { command: "gh pr create --title x" } }, { conversationId: "other", taskId: "t1" }, {});
  assert.equal(orphan, undefined, "non-loop conversation is unaffected");
});

// A resolver that maps only conv-1 to the loop bot; anything else is a routine conversation.
const scopedEnv = () => {
  const e = env({});
  const bot = { id: "bot-1", conversationId: "conv-1", loopRun: { loopId: "loop-1", runId: e.run.id } };
  e.deps.botOfConversation = async (convId) => (convId === "conv-1" ? bot : undefined);
  return e;
};
