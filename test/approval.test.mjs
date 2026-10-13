// Offline tests for the approval hook (F10): faux model + real CodingTools bash on a temp directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, hook, MemoryStorage, ToolResultEntry, ToolTask } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { WebSocket } from "ws";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { createApi } from "../src/api.mjs";
import { Approval, ApprovalCenter, approvals, createApproval, createClassifier, isDangerous } from "../src/ext/approval.mjs";
import { createRoutes } from "../src/routes/approvals.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };
const toolCall = (name, args, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

function fauxModels(responses) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  return models;
}

const nodeEnv = (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() });

async function waitFor(fn, what, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "tars-appr-"));
}

/** Text of every tool result in the active transcript. */
async function toolResults(conv) {
  const page = await conv.entries({}, 50, undefined, ctx);
  return page.items
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => e.model[0].content.map((c) => (c.type === "text" ? c.text : "")).join(""));
}

async function setup({ responses, storage = new MemoryStorage(), center = new ApprovalCenter(), extra = [], dir }) {
  const { harness } = await openHarness({
    storage,
    models: fauxModels(responses),
    extensions: [CodingTools, createApproval({ center }), ...extra],
    env: nodeEnv,
  });
  const bots = new BotRegistry(harness, { path: null });
  const bot = await bots.createBot({ name: "a", model: FAUX, cwd: dir });
  const conv = await bots.conversation(bot.id);
  return { harness, bots, bot, conv, center };
}

// ---- classification -------------------------------------------------------------------------------------------------

test("isDangerous: dangerous bash commands", () => {
  const bash = (command) => isDangerous({ name: "bash", arguments: { command } });
  for (const cmd of [
    "rm -rf /tmp/x",
    "rm -fr /tmp/x",
    "rm -Rf x",
    "rm -r -f x",
    "rm -f -r x",
    "rm --recursive --force x",
    "cd / && rm -rf *",
    "git -C repo push --force",
    "git -c core.editor=true push -f origin b",
    "cd r && git push origin HEAD:main",
    "git push origin b && git push --force",
    "echo ok; git push origin master",
    "curl -X POST https://example.com -d a=1",
    "curl -XDELETE https://example.com/x",
    "curl --request PUT https://example.com",
    "curl --data '{}' https://example.com",
    "curl --data-binary @f https://example.com",
    "wget --post-data=a=1 https://example.com",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "sudo shutdown -h now",
    "reboot",
    "echo x > /dev/sda",
  ]) {
    assert.equal(typeof bash(cmd), "string", `should be dangerous: ${cmd}`);
  }
});

test("isDangerous: git/gh operations that destroy PRs or code", () => {
  const bash = (command) => isDangerous({ name: "bash", arguments: { command } });
  for (const cmd of [
    "git push --force origin b",
    "git push -f",
    "git push -uf origin b",
    "git push --force-with-lease",
    "git push --force-with-lease=b:abc origin b",
    "git push --force-if-includes",
    "git push origin +b",
    "git push origin +HEAD:b",
    "git push origin --delete b",
    "git push -d origin b",
    "git push -ud origin b",
    "git push origin :b",
    "git push --mirror",
    "git push --prune origin",
    "git push origin main",
    "git push -u origin master",
    "git push origin dev",
    "git push origin HEAD:dev",
    "git push origin HEAD:refs/heads/main",
    "git -C repo push origin tarsbot/x:master",
    "git -c k=v push origin main",
    "git status && git push origin main",
    "gh pr merge 3 --squash",
    "gh pr close 3",
    "gh repo delete o/r --yes",
    "gh repo edit o/r --visibility public",
    "gh release delete v1 -y",
    "gh api repos/o/r/pulls -f title=x",
    "gh api repos/o/r/pulls -ftitle=x",
    "gh api repos/o/r/pulls -F body=@f",
    "gh api repos/o/r/pulls --field title=x",
    "gh api repos/o/r/pulls --raw-field title=x",
    "gh api repos/o/r/pulls --input body.json",
    "gh api -X DELETE repos/o/r",
    "gh api -XPATCH repos/o/r",
    "gh api --method PUT repos/o/r/x",
    "gh api --method=post repos/o/r/x",
  ]) {
    assert.equal(typeof bash(cmd), "string", `should be dangerous: ${cmd}`);
  }
});

test("isDangerous: ordinary git/gh work is allowed", () => {
  const bash = (command) => isDangerous({ name: "bash", arguments: { command } });
  for (const cmd of [
    "git push",
    "git push -u origin tarsbot/fix-x",
    "git -C repo push -u origin tarsbot/fix-x",
    "git -c k=v push origin tarsbot/fix-x",
    "git push origin HEAD",
    "git push origin tarsbot/dev-docs",
    "git push origin tarsbot/main-fix",
    "git push origin tarsbot/fix-f",
    "git push origin tarsbot/delete-old",
    "git push origin tarsbot/fix:tarsbot/fix",
    "git push origin main:tarsbot/x",
    "git push --dry-run origin tarsbot/x",
    "git push origin tarsbot/x && git checkout main",
    "git push origin tarsbot/x; git checkout dev",
    "git push origin tarsbot/x | tee out.txt",
    "git checkout main && git pull --ff-only && git push origin tarsbot/x",
    "git -C main push -u origin tarsbot/x",
    "git commit -m 'push to main' && git push -u origin tarsbot/x",
    "git log --grep push",
    "git status",
    "git branch -d tarsbot/old",
    "gh pr create --fill",
    "gh pr create -t x -b y",
    "gh pr create --base dev --head tarsbot/x --title t --body 'Opened by TARSBot'",
    "gh pr edit 3 --body x",
    "gh pr comment 3 -b hi",
    "gh pr view 3",
    "gh pr list --head b",
    "gh pr diff 3",
    "gh api repos/o/r/pulls",
    "gh api -X GET repos/o/r/pulls",
    "gh api repos/o/r/pulls --jq '.[0].number'",
    "gh api repos/o/r/pulls --paginate",
    "gh repo view o/r",
    "gh release list",
  ]) {
    assert.equal(bash(cmd), undefined, `should be safe: ${cmd}`);
  }
});

test("isDangerous: safe commands and tools pass", () => {
  const bash = (command) => isDangerous({ name: "bash", arguments: { command } });
  for (const cmd of [
    "ls -la",
    "echo hello",
    "rm file.txt",
    "rm -f file.txt",
    "rm -r dir",
    "git status",
    "git pull",
    "git log --oneline",
    "git log --grep push",
    "curl https://example.com",
    "curl -s -X GET https://example.com",
    "wget https://example.com/file",
    "dd if=/dev/zero count=1 | wc -c",
    "cat /dev/sda1 | head",
  ]) {
    assert.equal(bash(cmd), undefined, `should be safe: ${cmd}`);
  }
  assert.equal(isDangerous({ name: "read", arguments: { command: "rm -rf /" } }), undefined, "only the bash tool is scanned");
  assert.equal(isDangerous({ name: "bash", arguments: {} }), undefined);
  assert.equal(isDangerous({ name: "desktop_click", arguments: {} }), undefined);
});

test("isDangerous: tool-name set", () => {
  for (const name of ["send_email", "send_message", "deploy", "deploy_prod", "git_push"]) {
    assert.equal(typeof isDangerous({ name, arguments: {} }), "string", name);
  }
  for (const name of ["sender", "redeploy", "git_pull", "web_search"]) assert.equal(isDangerous({ name, arguments: {} }), undefined, name);
});

test("createClassifier: configurable rules", () => {
  const c = createClassifier({ bash: [{ pattern: /\bnpm publish\b/, reason: "publish" }], toolNames: ["pay_*", /^wire$/] });
  assert.equal(c({ name: "bash", arguments: { command: "npm publish" } }), "publish");
  assert.equal(c({ name: "bash", arguments: { command: "rm -rf /" } }), undefined, "defaults replaced");
  assert.ok(c({ name: "pay_invoice", arguments: {} }));
  assert.ok(c({ name: "wire", arguments: {} }));
  assert.equal(c({ name: "send_email", arguments: {} }), undefined);
});

// ---- approval center ------------------------------------------------------------------------------------------------

test("ApprovalCenter: request/list/resolve/changed, abort removes", async () => {
  const center = new ApprovalCenter();
  let changes = 0;
  center.on("changed", () => changes++);
  const p = center.request({ taskId: "t1", conversationId: "c", toolName: "bash", args: { command: "x".repeat(5000) }, reason: "r" });
  assert.equal(center.request({ taskId: "t1", toolName: "bash", args: {}, reason: "r" }), p, "same task shares the promise");
  const [item] = center.list();
  assert.equal(item.taskId, "t1");
  assert.equal(item.toolName, "bash");
  assert.ok(item.args.command.length < 2100, "display args are shortened");
  assert.equal(center.resolve("nope", true), false);
  assert.equal(center.resolve("t1", true), true);
  assert.equal(await p, true);
  assert.deepEqual(center.list(), []);
  assert.equal(changes, 2);

  const ac = new AbortController();
  const q = center.request({ taskId: "t2", toolName: "bash", args: {}, reason: "r", signal: ac.signal });
  assert.equal(center.list().length, 1);
  ac.abort();
  await assert.rejects(q);
  assert.deepEqual(center.list(), []);
  assert.equal(center.resolve("t2", true), false);
});

// ---- end to end -----------------------------------------------------------------------------------------------------

test("dangerous bash: pending → approve → tool runs", async () => {
  const dir = tmp();
  const victim = join(dir, "x");
  mkdirSync(victim);
  writeFileSync(join(victim, "f"), "data");
  try {
    const { harness, conv, center } = await setup({
      dir,
      responses: [toolCall("bash", { command: `rm -rf ${victim}` }), fauxAssistantMessage([fauxText("removed")])],
    });
    const sub = await conv.submit({ type: "input", content: "clean up" }, ctx);
    const [item] = await waitFor(() => (center.list().length ? center.list() : undefined), "pending approval");
    assert.equal(item.toolName, "bash");
    assert.match(item.args.command, /rm -rf/);
    assert.match(item.reason, /rm -rf/);
    assert.ok(item.taskId && item.conversationId);
    assert.ok(existsSync(victim), "not executed while pending");
    assert.equal(center.resolve(item.taskId, true), true);
    const settled = await sub.wait(ctx);
    assert.equal(settled.status, "done");
    assert.equal(existsSync(victim), false, "tool ran after approval");
    assert.deepEqual(center.list(), []);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dangerous bash: deny → model receives a block result, tool does not run", async () => {
  const dir = tmp();
  const victim = join(dir, "x");
  mkdirSync(victim);
  try {
    const { harness, conv, center } = await setup({
      dir,
      responses: [toolCall("bash", { command: `rm -rf ${victim}` }), fauxAssistantMessage([fauxText("ok, not deleting")])],
    });
    const sub = await conv.submit({ type: "input", content: "clean up" }, ctx);
    const [item] = await waitFor(() => (center.list().length ? center.list() : undefined), "pending approval");
    center.resolve(item.taskId, false);
    const settled = await sub.wait(ctx);
    assert.equal(settled.status, "done");
    assert.ok(existsSync(victim), "tool must not run after denial");
    const results = await toolResults(conv);
    assert.equal(results.length, 1);
    assert.match(results[0], /User denied: .*rm -rf/);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safe bash command never asks for approval", async () => {
  const dir = tmp();
  try {
    const center = new ApprovalCenter();
    let changes = 0;
    center.on("changed", () => changes++);
    const { harness, conv } = await setup({
      dir,
      center,
      responses: [toolCall("bash", { command: "echo hi > out.txt" }), fauxAssistantMessage([fauxText("done")])],
    });
    const settled = await (await conv.submit({ type: "input", content: "write" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    assert.equal(changes, 0);
    assert.ok(existsSync(join(dir, "out.txt")));
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abort while waiting removes the pending item and the tool does not run", async () => {
  const dir = tmp();
  const victim = join(dir, "x");
  mkdirSync(victim);
  try {
    const { harness, conv, center } = await setup({
      dir,
      responses: [toolCall("bash", { command: `rm -rf ${victim}` }), fauxAssistantMessage([fauxText("unused")])],
    });
    const sub = await conv.submit({ type: "input", content: "clean up" }, ctx);
    await waitFor(() => center.list().length, "pending approval");
    await conv.abort(ctx);
    await waitFor(() => center.list().length === 0, "item removed after abort");
    await sub.wait(ctx).catch(() => undefined);
    assert.ok(existsSync(victim));
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TEST-F10-2: approved verdict survives restart (SQLite) — no second question, tool completes", async () => {
  const dir = tmp();
  const db = join(dir, "t.sqlite");
  const victim = join(dir, "x");
  mkdirSync(victim);
  writeFileSync(join(victim, "f"), "data");
  try {
    // Life 1: approve, then "crash" before the tool runs. A second beforeTool hook (installed after Approval) holds the
    // call in the window between the durable verdict and the tool's intent/execution.
    let gateReached;
    const reached = new Promise((r) => (gateReached = r));
    const Gate = defineExtension({
      name: "test.gate",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (_call, _api, context) => {
            gateReached();
            await new Promise((_resolve, reject) => {
              const signal = context.abortSignal;
              if (signal?.aborted) return reject(signal.reason);
              signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
            });
          },
        }),
      ],
    });
    const center1 = new ApprovalCenter();
    const life1 = await setup({
      dir,
      storage: await openNodeSqliteStorage(db),
      center: center1,
      extra: [Gate],
      responses: [toolCall("bash", { command: `rm -rf ${victim}` })],
    });
    await life1.conv.submit({ type: "input", content: "clean up" }, ctx);
    const [item] = await waitFor(() => (center1.list().length ? center1.list() : undefined), "pending approval");
    center1.resolve(item.taskId, true);
    await reached; // verdict is memoized; tool has not started
    assert.ok(existsSync(victim), "tool has not run yet");
    await life1.harness.close(ctx);
    assert.ok(existsSync(victim), "tool still has not run after close");
    assert.deepEqual(center1.list(), [], "nothing left pending after close");

    // Life 2: same database, fresh approval center (a new process). No Gate.
    const center2 = new ApprovalCenter();
    let asked = 0;
    center2.on("changed", () => asked++);
    const { harness } = await openHarness({
      storage: await openNodeSqliteStorage(db),
      models: fauxModels([fauxAssistantMessage([fauxText("removed")])]),
      extensions: [CodingTools, createApproval({ center: center2 })],
      env: nodeEnv,
    });
    const bots = new BotRegistry(harness, { path: null });
    await harness.waitForIdle(ctx);
    void bots;
    await waitFor(() => !existsSync(victim), "tool execution after restart");
    assert.equal(asked, 0, "approved call must not ask again");
    assert.deepEqual(center2.list(), []);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart without a verdict: the question comes back", async () => {
  const dir = tmp();
  const db = join(dir, "t.sqlite");
  const victim = join(dir, "x");
  mkdirSync(victim);
  try {
    const center1 = new ApprovalCenter();
    const life1 = await setup({
      dir,
      storage: await openNodeSqliteStorage(db),
      center: center1,
      responses: [toolCall("bash", { command: `rm -rf ${victim}` })],
    });
    await life1.conv.submit({ type: "input", content: "clean up" }, ctx);
    await waitFor(() => center1.list().length, "pending approval");
    await life1.harness.close(ctx);

    const center2 = new ApprovalCenter();
    const { harness } = await openHarness({
      storage: await openNodeSqliteStorage(db),
      models: fauxModels([fauxAssistantMessage([fauxText("removed")])]),
      extensions: [CodingTools, createApproval({ center: center2 })],
      env: nodeEnv,
    });
    const [item] = await waitFor(() => (center2.list().length ? center2.list() : undefined), "re-asked after restart");
    assert.ok(existsSync(victim));
    center2.resolve(item.taskId, true);
    await harness.waitForIdle(ctx);
    await waitFor(() => !existsSync(victim), "tool execution after late approval");
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default Approval extension shape", () => {
  assert.equal(Approval.name, "tarsbot.approval");
  assert.ok(approvals instanceof ApprovalCenter);
});

// ---- routes ---------------------------------------------------------------------------------------------------------

test("routes: GET list, POST resolve, WS stream", async () => {
  const center = new ApprovalCenter();
  const api = createApi({ harness: {}, bots: { list: () => [] }, routes: [createRoutes(center)] });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.deepEqual(await (await fetch(`${base}/api/approvals`)).json(), []);

    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/approvals/stream`);
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await waitFor(() => frames.length >= 1, "initial frame");
    assert.deepEqual(frames[0], { type: "approvals", items: [] });

    const verdict = center.request({ taskId: "T9", conversationId: "C", toolName: "bash", args: { command: "git push" }, reason: "git push" });
    await waitFor(() => frames.length >= 2, "frame after request");
    assert.equal(frames[1].type, "approvals");
    assert.equal(frames[1].items[0].taskId, "T9");
    const listed = await (await fetch(`${base}/api/approvals`)).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].toolName, "bash");

    assert.equal((await post("/api/approvals/T9", { approved: "yes" })).status, 400);
    assert.equal((await post("/api/approvals/T9", {})).status, 400);
    assert.equal((await post("/api/approvals/missing", { approved: true })).status, 404);
    assert.deepEqual(await post("/api/approvals/T9", { approved: false }), { status: 200, body: { ok: true } });
    assert.equal(await verdict, false);
    await waitFor(() => frames.length >= 3, "frame after resolve");
    assert.deepEqual(frames[2], { type: "approvals", items: [] });
    ws.close();
  } finally {
    await api.close();
  }
});
