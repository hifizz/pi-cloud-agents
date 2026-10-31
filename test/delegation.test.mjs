// Delegation (AMP13-delegation) behavior tests (offline). Uses the real HTTP server (createApi),
// a real in-memory control store, a fake Bot registry that records createBot specs and submissions,
// and a fake runtimeBash that records commands and answers file reads. No real Sprite, model or
// GitHub access.
//
// Covered (normal path only):
//  - delegate creates a FRESH conversation on the same workspace (same Sprite), own worktree + own
//    tarsbot/task-* branch, swe-2 / high, preamble removed, task + only user-picked attachments
//  - no history is inherited; the first message is the task + chosen file contents
//  - limits: max children, depth (a child cannot delegate), read-only parent, not-ready workspace
//  - message / read: explicit message into the child; explicit read sends a summary back into the
//    PARENT conversation and stores it; idle is never treated as done
//  - file endpoint: inside-worktree only, realpath guard against symlink escape, denied names, size cap
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { register as registerDelegation } from "../src/routes/delegation.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { MAX_CHILDREN, MAX_DEPTH } from "../src/delegation-env.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };
const REPO = "hifizz/tars-sandbox-playground";
const SHA = "3157db095cb9344e5b9cf0669657bf613d036b46";

/** Bot registry double: records createBot specs and submissions; entries() yields canned assistant text. */
function fakeBots({ assistantTexts = {} } = {}) {
  const records = [];
  const created = [];
  const submits = new Map();
  let nextId = 0;
  const registry = {
    created,
    submits,
    records,
    list: () => [...records],
    get: (id) => records.find((b) => b.id === id || b.name === id),
    update: (id, patch) => {
      const bot = registry.get(id);
      if (!bot) return undefined;
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete bot[k];
        else bot[k] = v;
      }
      return bot;
    },
    async createBot(spec) {
      nextId++;
      const bot = { id: `bot${nextId}`, name: spec.name, conversationId: 5000 + nextId, ...spec };
      records.push(bot);
      created.push(spec);
      return bot;
    },
    async conversation(id) {
      const bot = registry.get(id);
      if (!bot) return undefined;
      return {
        id: bot.conversationId,
        async submit(input) {
          if (!submits.has(bot.id)) submits.set(bot.id, []);
          submits.get(bot.id).push(input);
          return { id: `${bot.id}-sub${submits.get(bot.id).length}` };
        },
        async entries() {
          const text = assistantTexts[bot.id];
          return { items: text ? [
            { id: 9, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }] }] },
            { id: 7, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] }] },
          ] : [] };
        },
        async viewState() {
          return { value: { docs: { "pi.live": bot.__live ?? undefined, "pi.inbox": { items: bot.__inbox ?? [] } } }, dispose() {} };
        },
      };
    },
  };
  return registry;
}

/** runtimeBash double: records commands; answers realpath/stat/cat for the canned file set. */
function fakeRuntimeBash({ files = {}, defaultWorktreeResult = { exitCode: 0, stdout: "", stderr: "" } } = {}) {
  const calls = [];
  const bash = async (command) => {
    calls.push(command);
    const rv = /rev-parse --verify '([^']+)'/.exec(command);
    if (rv) {
      const ref = rv[1].replace(/\^\{commit\}$/, "");
      if (/^[0-9a-f]{40}$/i.test(ref)) return { exitCode: 0, stdout: `${ref}\n`, stderr: "" };
      if (ref === "HEAD" || ref === "main") return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
      return { exitCode: 128, stdout: "", stderr: "fatal: Needed a single revision" };
    }
    const m = /realpath -e -- '([^']+)'/.exec(command);
    if (m) {
      const p = m[1];
      const hit = files[p];
      if (hit === undefined) return { exitCode: 1, stdout: "", stderr: "realpath: no such file" };
      return { exitCode: 0, stdout: `${hit.canon ?? p}\n`, stderr: "" };
    }
    const s = /stat -Lc '%F\|%s' -- '([^']+)'/.exec(command);
    if (s) {
      const p = s[1];
      const hit = Object.values(files).find((f) => f.canon === p) ?? files[p];
      if (!hit || hit.dir) return { exitCode: 0, stdout: "directory|4096\n", stderr: "" };
      return { exitCode: 0, stdout: `regular file|${hit.size ?? hit.content.length}\n`, stderr: "" };
    }
    const c = /cat -- '([^']+)'/.exec(command);
    if (c) {
      const hit = Object.values(files).find((f) => f.canon === c[1]) ?? files[c[1]];
      return { exitCode: 0, stdout: hit?.content ?? "", stderr: "" };
    }
    return defaultWorktreeResult;
  };
  return { calls, bash };
}

async function makeEnv({ files, assistantTexts, parentSpec } = {}) {
  const store = openControlStore({ path: null });
  const bots = fakeBots({ assistantTexts });
  const rt = fakeRuntimeBash({ files });

  const project = store.projects.upsert({ repo: REPO, defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "seed-del",
    projectId: project.id,
    name: "delegation ws",
    baseBranch: "main",
    branch: "tarsbot/ws-abc123",
    cwd: "/home/sprite/workspace/tars-sandbox-playground",
    model: FAUX,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-eae56f671c" });

  // The parent session: an issue-loop execution with its own worktree dir (server-recorded, not client data).
  const parent = {
    id: "p1",
    name: "parent-session",
    conversationId: 4242,
    model: FAUX,
    workspaceId: workspace.id,
    issueLoop: { issue: 3, baseBranch: "main", pinnedSha: SHA, dir: "/home/sprite/issue-loop/ws_x/execution-y", branch: "tarsbot/issue-3-p1" },
    ...parentSpec,
  };
  bots.records.push(parent);
  store.links.link({ conversationId: "4242", workspaceId: workspace.id, botId: "p1" });

  const inject = (app) =>
    Object.assign(app.ctx, {
      workspaces: { get: (id) => store.workspaces.get(id), list: () => store.workspaces.list() },
      control: store,
      runtimeBash: () => rt.bash,
    });
  const api = createApi({ harness: {}, bots, routes: [inject, registerDelegation] });
  const { port } = await api.listen(0);
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    assert.ok(!text.includes(tmpdir()), "response carries a server path");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  return {
    store,
    bots,
    rt,
    ws: workspace,
    parent,
    call,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    async close() {
      await api.close();
      store.close();
    },
  };
}

// ---- create ----------------------------------------------------------------------------------------------------------

test("delegate: fresh child session on the same Sprite, own worktree + tarsbot/task branch, swe-2/high, preamble removed", async () => {
  const env = await makeEnv();
  try {
    const { status, json } = await env.post("/api/bots/p1/delegation", { task: "实现工具函数并补测试" });
    assert.equal(status, 200, json?.error);
    const t = json.task;
    assert.equal(t.state, "running");
    // own worktree + own child branch built from the resolved actual SHA (base resolved once, server-side)
    assert.ok(env.rt.calls.some((c) => c.includes(`rev-parse --verify '${SHA}^{commit}'`)), "the base is resolved to a SHA before the worktree add");
    const add = env.rt.calls.find((c) => c.includes("worktree add -b"));
    assert.ok(add, `no worktree command: ${JSON.stringify(env.rt.calls)}`);
    assert.match(add, /worktree add -b 'tarsbot\/task-[0-9a-f]{8}' '([^']+)' '3157db095cb9344e5b9cf0669657bf613d036b46'/, `branched at the pinned SHA: ${add}`);
    assert.ok(!/\bcheckout\b|\breset\b/.test(add), "no checkout/reset of any existing dir");
    const dir = /worktree add -b '[^']+' '([^']+)'/.exec(add)[1];
    assert.notEqual(dir, env.parent.issueLoop.dir, "child has its own directory");
    assert.ok(dir.startsWith("/home/sprite/delegation/"), `child dir under delegation root: ${dir}`);
    // fresh conversation (createBot, not fork): swe-2 on the parent's provider, thinking high, preamble removed
    const spec = env.bots.created[0];
    assert.equal(spec.model.modelId, "swe-2", "child defaults to swe-2");
    assert.equal(spec.model.provider, "faux", "child keeps the parent's provider");
    assert.equal(spec.thinkingLevel, "high");
    assert.equal(spec.cwd, dir);
    assert.deepEqual(spec.extensions.remove.map((e) => e.name), ["tarsbot.preamble"]);
    assert.equal(spec.workspaceId, env.ws.id);
    // shared session-worktree metadata that every reader resolves (Header / EnvironmentPane / Files-Git):
    // the child carries `worktree` with the ACTUAL resolved SHA and its own branch
    const child = env.bots.get(t.child.botId);
    assert.equal(child.worktree.dir, dir);
    assert.equal(child.worktree.pinnedSha, SHA);
    assert.equal(child.worktree.baseBranch, "main");
    assert.match(child.worktree.branch, /^tarsbot\/task-[0-9a-f]{8}$/);
    assert.equal(child.delegation.role, "child");
    assert.equal(child.delegation.parentBotId, "p1");
    assert.equal(child.delegation.depth, 1);
    assert.equal(child.status, "executing");
    // same workspace link => same active binding => same Sprite
    assert.equal(env.store.links.workspaceOf(String(child.conversationId))?.id, env.ws.id);
    // first message: the task verbatim + boundaries, never the parent's history
    const msg = env.bots.submits.get(child.id)[0].content;
    assert.ok(msg.includes("实现工具函数并补测试"), "message carries the task");
    assert.ok(msg.includes(child.delegation.parentBotId === "p1" ? "parent-session" : ""), "message names the parent session");
    assert.match(msg, /不要进入或修改父会话的目录/, "boundary rule present");
    assert.match(msg, /do not run `git push`/, "no-push rule present");
    // parent record holds the task view, including the resolved pin
    assert.equal(env.bots.get("p1").delegation.tasks.length, 1);
    assert.equal(env.bots.get("p1").delegation.tasks[0].childBotId, child.id);
    assert.equal(env.bots.get("p1").delegation.tasks[0].pinnedSha, SHA, "task record carries the resolved SHA");
  } finally {
    await env.close();
  }
});

test("delegate: chosen worktree files are inlined, validated and labelled; unchosen files never read", async () => {
  const dir = "/home/sprite/issue-loop/ws_x/execution-y";
  const env = await makeEnv({
    files: {
      [`${dir}/src/util.ts`]: { content: "export const x = 1;\n" },
      [`${dir}/.env`]: { content: "SECRET=1" },
    },
  });
  try {
    const { status, json } = await env.post("/api/bots/p1/delegation", { task: "改造 util.ts", contextPaths: ["src/util.ts"] });
    assert.equal(status, 200, json?.error);
    const child = env.bots.get(json.task.child.botId);
    const msg = env.bots.submits.get(child.id)[0].content;
    assert.ok(msg.includes("export const x = 1;"), "chosen file content is inlined");
    assert.ok(msg.includes(`来源 ${dir}/src/util.ts`), "the attachment source path is labelled");
    // denied names refused, nothing else read
    const denied = await env.post("/api/bots/p1/delegation/file", { path: ".env" });
    assert.equal(denied.status, 400);
    assert.match(denied.json.error, /not transferable|protected/);
    const outside = await env.post("/api/bots/p1/delegation/file", { path: "/etc/passwd" });
    assert.equal(outside.status, 400);
    // a symlink that resolves outside the worktree is refused by the realpath guard
    const env2 = await makeEnv({ files: { [`${dir}/link`]: { canon: "/home/sprite/workspace/other-repo/secret", content: "x" } } });
    try {
      const r = await env2.post("/api/bots/p1/delegation/file", { path: "link" });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /outside|symlink/);
    } finally {
      await env2.close();
    }
    // no stray reads: only realpath/stat/cat for the files we asked about plus worktree adds
    assert.ok(!env.rt.calls.some((c) => c.includes(".env") && c.startsWith("cat")), ".env was never catted");
  } finally {
    await env.close();
  }
});

test("attachments: .env.* variants and protected dirs are refused before any read; a secret reached only by symlink is refused after realpath", async () => {
  const dir = "/home/sprite/issue-loop/ws_x/execution-y";
  const env = await makeEnv({
    files: {
      // a symlink inside the worktree that lands on a protected NAME inside the repo
      [`${dir}/notes.md`]: { canon: "/home/sprite/workspace/tars-sandbox-playground/.env.production", content: "SECRET=1" },
      // a symlink into a protected SEGMENT inside the repo
      [`${dir}/cfg`]: { canon: "/home/sprite/workspace/tars-sandbox-playground/.ssh/id_rsa", content: "KEY" },
      [`${dir}/.env.production`]: { content: "SECRET=1" },
      [`${dir}/id_rsa.pub`]: { content: "ssh-rsa AAAA" },
    },
  });
  try {
    for (const p of [".env.production", ".env.local", "id_rsa", "id_rsa.pub", ".ssh/config", ".git/config"]) {
      const r = await env.post("/api/bots/p1/delegation/file", { path: p });
      assert.equal(r.status, 400, `${p} must be refused`);
      assert.match(r.json.error, /not transferable|protected/, `${p}: ${r.json.error}`);
    }
    // a benign-looking name that RESOLVES to a protected target is refused after realpath
    const r1 = await env.post("/api/bots/p1/delegation/file", { path: "notes.md" });
    assert.equal(r1.status, 400);
    assert.match(r1.json.error, /not transferable/);
    const r2 = await env.post("/api/bots/p1/delegation/file", { path: "cfg" });
    assert.equal(r2.status, 400);
    assert.match(r2.json.error, /protected directory|not transferable/);
    // nothing was ever read to disk: no cat ran for any of these
    assert.ok(!env.rt.calls.some((c) => /^cat /.test(c)), "no file content was ever read");
  } finally {
    await env.close();
  }
});

test("delegate: limits — child cannot delegate (depth), max children, read-only parent, not-ready workspace", async () => {
  const env = await makeEnv();
  try {
    // depth: a child session itself cannot delegate
    env.bots.records.push({
      id: "kid",
      name: "kid",
      conversationId: 7001,
      model: FAUX,
      delegation: { role: "child", parentBotId: "p1", taskId: "dt_x", depth: MAX_DEPTH },
    });
    env.store.links.link({ conversationId: "7001", workspaceId: env.ws.id, botId: "kid" });
    let r = await env.post("/api/bots/kid/delegation", { task: "nested" });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /depth|child/i);

    // read-only parent cannot delegate
    env.bots.records.push({ id: "ro", name: "ro", conversationId: 7002, model: FAUX, readOnly: true });
    env.store.links.link({ conversationId: "7002", workspaceId: env.ws.id, botId: "ro" });
    r = await env.post("/api/bots/ro/delegation", { task: "x" });
    assert.equal(r.status, 409);

    // max children: fill the parent's record with MAX_CHILDREN tasks
    env.bots.get("p1").delegation = {
      depth: 0,
      tasks: Array.from({ length: MAX_CHILDREN }, (_, i) => ({ id: `dt_${i}`, task: `t${i}`, state: "running", createdAt: "" })),
      results: [],
    };
    r = await env.post("/api/bots/p1/delegation", { task: "one more" });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /child limit|上限/i);
    env.bots.get("p1").delegation = { depth: 0, tasks: [], results: [] };

    // not-ready workspace refuses
    env.store.workspaces.update(env.ws.id, { status: "preparing" });
    r = await env.post("/api/bots/p1/delegation", { task: "x" });
    assert.equal(r.status, 409);
    env.store.workspaces.update(env.ws.id, { status: "ready" });

    // unlinked bot cannot delegate
    env.bots.records.push({ id: "stray", name: "stray", conversationId: 7999, model: FAUX });
    r = await env.post("/api/bots/stray/delegation", { task: "x" });
    assert.equal(r.status, 409);

    // empty task rejected without touching the Sprite
    r = await env.post("/api/bots/p1/delegation", { task: "   " });
    assert.equal(r.status, 400);
    assert.equal(env.bots.created.length, 0, "no child was created by the rejected calls");
  } finally {
    await env.close();
  }
});

test("delegate: a worktree failure records a visible failed task, not a silent no-op", async () => {
  const env = await makeEnv();
  env.rt.bash = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: branch exists" });
  try {
    const r = await env.post("/api/bots/p1/delegation", { task: "x" });
    assert.equal(r.status, 500);
    const task = env.bots.get("p1").delegation.tasks[0];
    assert.equal(task.state, "failed");
    assert.match(task.error, /branch exists|failed/);
    assert.equal(env.bots.created.length, 0, "no bot was created");
  } finally {
    await env.close();
  }
});

// ---- message / read ---------------------------------------------------------------------------------------------------

test("message + read: explicit message reaches the child; explicit read sends the summary into the PARENT conversation", async () => {
  const env = await makeEnv({ assistantTexts: { bot1: "完成了：新增 util.ts 并通过测试" } });
  try {
    const created = await env.post("/api/bots/p1/delegation", { task: "实现工具函数" });
    const taskId = created.json.task.id;
    const childId = created.json.task.child.botId;
    assert.equal(childId, "bot1");

    // explicit follow-up message into the child (literal user text, labelled)
    const m = await env.post(`/api/delegation/${taskId}/message`, { message: "请也更新 README" });
    assert.equal(m.status, 200, m.json?.error);
    const lastChild = env.bots.submits.get(childId).at(-1).content;
    assert.ok(lastChild.includes("请也更新 README"), "the follow-up reached the child verbatim");
    assert.match(lastChild, /来自父会话用户的跟进消息/, "the follow-up is labelled");

    // empty message rejected
    assert.equal((await env.post(`/api/delegation/${taskId}/message`, { message: " " })).status, 400);
    assert.equal((await env.post("/api/delegation/dt_nope/message", { message: "x" })).status, 404);

    // explicit read: a summary goes back into the PARENT conversation and lands on the record
    const r = await env.post(`/api/delegation/${taskId}/read`, { note: "请按结果收尾" });
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(r.json.result.summary, "完成了：新增 util.ts 并通过测试");
    const parentMsg = env.bots.submits.get("p1").at(-1).content;
    assert.ok(parentMsg.includes("完成了：新增 util.ts 并通过测试"), "the summary went back into the parent conversation");
    assert.match(parentMsg, /子任务结果（delegation read/, "the back-message is labelled");
    assert.ok(parentMsg.includes("请按结果收尾"), "the human note is carried");
    const stored = env.bots.get("p1").delegation.tasks.find((t) => t.id === taskId);
    assert.equal(stored.state, "read");
    assert.equal(stored.result.summary, "完成了：新增 util.ts 并通过测试");
    assert.equal(env.bots.get("p1").delegation.results.length, 1);
  } finally {
    await env.close();
  }
});

test("read: no assistant reply is stated as 未取得 (never a fake success), and a busy child is reported as still running", async () => {
  const env = await makeEnv();
  try {
    const created = await env.post("/api/bots/p1/delegation", { task: "x" });
    const taskId = created.json.task.id;
    const child = env.bots.get(created.json.task.child.botId);
    child.__live = { run: { id: 1 } }; // still running at read time

    const r = await env.post(`/api/delegation/${taskId}/read`, {});
    assert.equal(r.status, 200, r.json?.error);
    assert.match(r.json.result.summary, /未取得/, "no fake success when the child has no reply");
    assert.equal(r.json.result.childBusyAtRead, true, "the read records the child was still busy");
    const parentMsg = env.bots.submits.get("p1").at(-1).content;
    assert.match(parentMsg, /仍在运行/, "the parent message states the child was still running");
    assert.ok(!/已完成/.test(r.json.result.summary), "idle is never reported as done");
  } finally {
    await env.close();
  }
});

test("list: GET returns parent facts and task states; the canDelegate flag follows depth and workspace state", async () => {
  const env = await makeEnv();
  try {
    const created = await env.post("/api/bots/p1/delegation", { task: "task a" });
    assert.equal(created.status, 200);
    const { status, json } = await env.get("/api/bots/p1/delegation");
    assert.equal(status, 200, json?.error);
    assert.equal(json.parent.botId, "p1");
    assert.equal(json.parent.canDelegate, true);
    assert.equal(json.parent.depth, 0);
    assert.equal(json.parent.dir, env.parent.issueLoop.dir, "panel sees the server-recorded dir");
    assert.equal(json.tasks.length, 1);
    assert.equal(json.tasks[0].task, "task a");
    assert.equal(json.tasks[0].state, "running");
    assert.equal(json.tasks[0].child.botId, created.json.task.child.botId);
    // a child session lists itself as not-delegatable (its depth reaches the cap)
    const child = await env.get(`/api/bots/${created.json.task.child.botId}/delegation`);
    assert.equal(child.status, 200);
    assert.equal(child.json.parent.depth, 1, "the child carries depth 1");
    assert.equal(child.json.parent.canDelegate, MAX_DEPTH > 1, "canDelegate only follows the depth cap");
    // at the cap itself delegation is off for the panel too
    env.bots.get(created.json.task.child.botId).delegation.depth = MAX_DEPTH;
    const capped = await env.get(`/api/bots/${created.json.task.child.botId}/delegation`);
    assert.equal(capped.json.parent.canDelegate, false, "a child at the depth cap cannot delegate");
    // a not-ready workspace reports canDelegate false
    env.store.workspaces.update(env.ws.id, { status: "preparing" });
    const notReady = await env.get("/api/bots/p1/delegation");
    assert.equal(notReady.json.parent.canDelegate, false);
  } finally {
    await env.close();
  }
});

// ---- real harness contract --------------------------------------------------------------------------------------------

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx as harnessCtx } from "../src/harness.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { Exec } from "../src/ext/exec.mjs";
import { Approval } from "../src/ext/approval.mjs";

test("real harness: a delegation child is a fresh conversation — own cwd, swe-2/high agent, no inherited history, Approval kept", async () => {
  const f = fauxProvider();
  f.setResponses([fauxAssistantMessage([fauxText("child-answer")])]);
  const models = createModels();
  models.setProvider(f.provider);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble, Exec, Approval] });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const parent = await bots.createBot({
      name: "parent",
      model: { provider: "faux", modelId: "faux-1" },
      cwd: "/parent",
      extensions: { remove: [] },
      delegation: { tasks: [], results: [], depth: 0 },
    });
    await (await (await bots.conversation(parent.id)).submit({ type: "input", content: "PARENT-HISTORY" }, harnessCtx)).wait(harnessCtx);

    // the spec exactly as the route builds it
    const child = await bots.createBot({
      name: "task-ab12cd34",
      model: { provider: "faux", modelId: "swe-2" },
      thinkingLevel: "high",
      cwd: "/child-worktree",
      instructions: "委派子任务 Session",
      extensions: { remove: [Preamble] },
      workspaceId: "w1",
      status: "executing",
      delegation: { role: "child", parentBotId: parent.id, taskId: "dt_x", depth: 1 },
    });
    const conv = await bots.conversation(child.id);
    const agent = await conv.agent(harnessCtx);
    assert.equal(agent.cwd, "/child-worktree", "child runs in its own worktree");
    assert.equal(agent.model.modelId, "swe-2", "child defaults to swe-2");
    assert.equal(agent.thinkingLevel, "high", "child thinking level is high");
    const names = agent.extensions.map((e) => e.name);
    assert.ok(!names.includes("tarsbot.preamble"), "preamble removed");
    assert.ok(names.includes("tarsbot.approval"), "approval kept");
    assert.ok(names.includes("tarsbot.exec"), "exec kept");
    // no inherited history
    assert.equal((await conv.entries({}, 100, undefined, harnessCtx)).items.length, 0, "child starts empty");
    assert.notEqual(String(conv.id), String(parent.conversationId));
    // delegation metadata persisted on the record
    assert.equal(child.delegation.parentBotId, parent.id);
    // update() persists the delegation key
    bots.update(parent.id, { delegation: { tasks: [{ id: "dt_x", task: "t", state: "running" }], results: [], depth: 0 } });
    assert.equal(bots.get(parent.id).delegation.tasks[0].id, "dt_x");
    // and does not touch other fields
    assert.equal(bots.get(parent.id).name, "parent");
  } finally {
    await harness.close(harnessCtx);
  }
});
