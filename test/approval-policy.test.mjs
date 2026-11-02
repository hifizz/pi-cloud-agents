// Offline tests for the per-session approval policy ("ask" | "auto" | "bypass") and
// PATCH /api/bots/:id/approval-policy. "auto" auto-approves only recoverable (soft) classifications; a stored
// "auto" written before the three-level policy takes the new narrower meaning by design (no data migration).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { createApi } from "../src/api.mjs";
import { ApprovalCenter, createApproval } from "../src/ext/approval.mjs";
import { register as registerBotsPolicy } from "../src/routes/bots-policy.mjs";

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
  return mkdtempSync(join(tmpdir(), "tars-apprpol-"));
}

/** Text of every tool result in the active transcript. */
async function toolResults(conv) {
  const page = await conv.entries({}, 50, undefined, ctx);
  return page.items
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => e.model[0].content.map((c) => (c.type === "text" ? c.text : "")).join(""));
}

async function setup({ responses, storage = new MemoryStorage(), center = new ApprovalCenter(), dir, getPolicy }) {
  const { harness } = await openHarness({
    storage,
    models: fauxModels(responses),
    extensions: [CodingTools, createApproval({ center, getPolicy })],
    env: nodeEnv,
  });
  const bots = new BotRegistry(harness, { path: null });
  const bot = await bots.createBot({ name: "a", model: FAUX, cwd: dir });
  const conv = await bots.conversation(bot.id);
  return { harness, bots, bot, conv, center };
}

test("policy auto: dangerous call runs without a pending approval", async () => {
  const dir = tmp();
  const victim = join(dir, "x");
  mkdirSync(victim);
  try {
    const { harness, bot, conv, center } = await setup({
      dir,
      getPolicy: (id) => (id === bot.conversationId ? "auto" : undefined),
      responses: [toolCall("bash", { command: `rm -rf ${victim}` }), fauxAssistantMessage([fauxText("removed")])],
    });
    const settled = await (await conv.submit({ type: "input", content: "clean up" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    assert.equal(existsSync(victim), false, "tool ran without a human verdict");
    assert.deepEqual(center.list(), [], "nothing ever entered the approval center");
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy auto: a hard (irreversible) call still parks for a human", async () => {
  // "auto" narrows to recoverable classifications; force pushes stay gated like under "ask".
  const dir = tmp();
  const marker = join(dir, "pushed");
  try {
    const { harness, bot, conv, center } = await setup({
      dir,
      getPolicy: (id) => (id === bot.conversationId ? "auto" : undefined),
      responses: [toolCall("bash", { command: `git push --force; touch ${marker}` }), fauxAssistantMessage([fauxText("ok")])],
    });
    const sub = await conv.submit({ type: "input", content: "push it" }, ctx);
    const [item] = await waitFor(() => (center.list().length ? center.list() : undefined), "pending approval for hard call");
    assert.match(item.reason, /rewrites remote history/);
    assert.equal(existsSync(marker), false, "hard call must not run under auto");
    center.resolve(item.taskId, true);
    const settled = await sub.wait(ctx);
    assert.equal(settled.status, "done");
    assert.equal(existsSync(marker), true, "runs once a human approves");
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy bypass: every dangerous call runs without a pending approval, hard included", async () => {
  const dir = tmp();
  const marker = join(dir, "pushed");
  try {
    const { harness, bot, conv, center } = await setup({
      dir,
      getPolicy: (id) => (id === bot.conversationId ? "bypass" : undefined),
      responses: [toolCall("bash", { command: `git push --force; touch ${marker}` }), fauxAssistantMessage([fauxText("ok")])],
    });
    const settled = await (await conv.submit({ type: "input", content: "push it" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    assert.equal(existsSync(marker), true, "hard call ran under bypass");
    assert.deepEqual(center.list(), [], "nothing ever entered the approval center");
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy bypass writes the durable approval memo: the memo itself records true", async () => {
  const dir = tmp();
  const db = join(dir, "t.sqlite");
  const victim = join(dir, "x");
  mkdirSync(victim);
  try {
    const { harness, conv } = await setup({
      dir,
      storage: await openNodeSqliteStorage(db),
      getPolicy: () => "bypass",
      responses: [toolCall("bash", { command: `rm -rf ${victim}` }), fauxAssistantMessage([fauxText("removed")])],
    });
    const settled = await (await conv.submit({ type: "input", content: "clean up" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    assert.equal(existsSync(victim), false, "tool ran under bypass");
    const results = await toolResults(conv);
    assert.ok(results.length >= 1 && !results.some((r) => /User denied/.test(r)), "no denial block in the transcript");
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy ask / unknown / throwing lookups keep the human question", async () => {
  for (const [name, getPolicy] of [
    ["ask", () => "ask"],
    ["unknown", () => "yolo"],
    ["throwing", () => { throw new Error("registry down"); }],
  ]) {
    const dir = tmp();
    const victim = join(dir, "x");
    mkdirSync(victim);
    try {
      const { harness, conv, center } = await setup({
        dir,
        getPolicy,
        responses: [toolCall("bash", { command: `rm -rf ${victim}` }), fauxAssistantMessage([fauxText("ok")])],
      });
      const sub = await conv.submit({ type: "input", content: "clean up" }, ctx);
      const [item] = await waitFor(() => (center.list().length ? center.list() : undefined), `pending under ${name}`);
      assert.ok(existsSync(victim), `${name}: not executed while pending`);
      center.resolve(item.taskId, true);
      await sub.wait(ctx);
      await harness.close(ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("policy bypass does not resurrect a denied memo verdict", async () => {
  // First-write-wins still holds: if a human denial reached the memo first, a later bypass policy cannot flip it.
  const dir = tmp();
  const db = join(dir, "t.sqlite");
  const victim = join(dir, "x");
  mkdirSync(victim);
  try {
    const { harness, conv, center } = await setup({
      dir,
      storage: await openNodeSqliteStorage(db),
      responses: [toolCall("bash", { command: `rm -rf ${victim}` }), fauxAssistantMessage([fauxText("not deleting")])],
    });
    const sub = await conv.submit({ type: "input", content: "clean up" }, ctx);
    const [item] = await waitFor(() => (center.list().length ? center.list() : undefined), "pending approval");
    center.resolve(item.taskId, false);
    await sub.wait(ctx);
    await harness.close(ctx);
    assert.ok(existsSync(victim));

    // Restart with bypass: the memo already says denied, so the hook must block again without asking or running.
    const { harness: h2 } = await openHarness({
      storage: await openNodeSqliteStorage(db),
      models: fauxModels([fauxAssistantMessage([fauxText("done")])]),
      extensions: [CodingTools, createApproval({ getPolicy: () => "bypass" })],
      env: nodeEnv,
    });
    await h2.waitForIdle(ctx);
    assert.ok(existsSync(victim), "a memoized denial beats a later bypass policy");
    await h2.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BotRegistry.policyOf returns the stored ask/auto/bypass value, undefined otherwise", async () => {
  const { models } = (() => {
    const f = fauxProvider();
    const m = createModels();
    m.setProvider(f.provider);
    f.setResponses([]);
    return { models: m };
  })();
  const { harness } = await openHarness({ storage: new MemoryStorage(), models });
  const bots = new BotRegistry(harness, { path: null });
  const plain = await bots.createBot({ name: "plain", model: FAUX });
  const auto = await bots.createBot({ name: "auto", model: FAUX, approvalPolicy: "auto" });
  const bypass = await bots.createBot({ name: "bypass", model: FAUX, approvalPolicy: "bypass" });
  assert.equal(bots.policyOf(plain.conversationId), undefined, "no field means ask");
  assert.equal(bots.policyOf(auto.conversationId), "auto");
  assert.equal(bots.policyOf(bypass.conversationId), "bypass");
  assert.equal(bots.policyOf("nonexistent"), undefined, "unknown conversation means ask");
  assert.equal(bots.get("plain").approvalPolicy, undefined);
  assert.equal(bots.get("auto").approvalPolicy, "auto");
  assert.equal(bots.get("bypass").approvalPolicy, "bypass");
  await harness.close(ctx);
});

test("PATCH /api/bots/:id/approval-policy: update persists, 400/404, ask keeps the field", async () => {
  const dir = tmp();
  const botsPath = join(dir, "bots.json");
  try {
    const { models } = (() => {
      const f = fauxProvider();
      const m = createModels();
      m.setProvider(f.provider);
      f.setResponses([]);
      return { models: m };
    })();
    const { harness } = await openHarness({ storage: new MemoryStorage(), models });
    const bots = new BotRegistry(harness, { path: botsPath });
    const bot = await bots.createBot({ name: "target", model: FAUX });
    const api = createApi({ harness: {}, bots, routes: [registerBotsPolicy] });
    const { port } = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const patch = async (path, body) => {
      const res = await fetch(base + path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    try {
      assert.equal((await patch(`/api/bots/${bot.id}/approval-policy`, { policy: "yolo" })).status, 400);
      assert.equal((await patch(`/api/bots/${bot.id}/approval-policy`, {})).status, 400);
      assert.equal((await patch(`/api/bots/${bot.id}/approval-policy`, { policy: 1 })).status, 400);
      assert.equal((await patch("/api/bots/nope/approval-policy", { policy: "auto" })).status, 404);

      const ok = await patch(`/api/bots/${bot.id}/approval-policy`, { policy: "auto" });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.bot.approvalPolicy, "auto");
      assert.equal(bots.policyOf(bot.conversationId), "auto");

      // Survives a registry reload from bots.json.
      const bots2 = new BotRegistry(harness, { path: botsPath });
      assert.equal(bots2.get(bot.id).approvalPolicy, "auto");
      assert.equal(bots2.policyOf(bot.conversationId), "auto");
      assert.ok(readFileSync(botsPath, "utf8").includes('"approvalPolicy": "auto"'));

      // bypass round-trips through the same route.
      const bypassed = await patch(`/api/bots/${bot.id}/approval-policy`, { policy: "bypass" });
      assert.equal(bypassed.status, 200);
      assert.equal(bypassed.body.bot.approvalPolicy, "bypass");
      assert.equal(bots.policyOf(bot.conversationId), "bypass");

      // Switching back to ask keeps the field visible on the record.
      const back = await patch(`/api/bots/${bot.id}/approval-policy`, { policy: "ask" });
      assert.equal(back.status, 200);
      assert.equal(back.body.bot.approvalPolicy, "ask");
      assert.equal(bots.policyOf(bot.conversationId), "ask");
    } finally {
      await api.close();
      await harness.close(ctx);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard rejection blocks the route (auth contract)", async () => {
  const api = createApi({ harness: {}, bots: { update: () => ({}) }, routes: [registerBotsPolicy] });
  api.app.guard(() => {
    const e = new Error("unauthorized");
    e.status = 401;
    throw e;
  });
  const { port } = await api.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bots/x/approval-policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: "auto" }),
    });
    assert.notEqual(res.status, 200, "guard must intercept before the handler");
  } finally {
    await api.close();
  }
});

test("update() ignores keys it does not own, policy included only via whitelist", async () => {
  const { models } = (() => {
    const f = fauxProvider();
    const m = createModels();
    m.setProvider(f.provider);
    f.setResponses([]);
    return { models: m };
  })();
  const { harness } = await openHarness({ storage: new MemoryStorage(), models });
  const bots = new BotRegistry(harness, { path: null });
  const bot = await bots.createBot({ name: "x", model: FAUX });
  bots.update(bot.id, { name: "hijacked", approvalPolicy: "auto" });
  assert.equal(bots.get(bot.id).name, "x", "update() must not touch non-whitelisted keys");
  assert.equal(bots.get(bot.id).approvalPolicy, "auto");
  await harness.close(ctx);
});
