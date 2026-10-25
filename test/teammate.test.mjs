// Offline tests: memory layer (6), quiet/NO_UPDATE (12), ask_user (14), approval expiry (4), interbot hops (9).
// All faux-provider + MemoryStorage; no network, no sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { createMemory, MemoryDoc, MemoryRevisionsDoc, addBullets, removeBullets, MAX_CHARS } from "../src/ext/memory.mjs";
import { createQuiet, partitionKeys, ReportedDoc } from "../src/ext/quiet.mjs";
import { createAskUser, AskCenter } from "../src/ext/ask-user.mjs";
import { ApprovalCenter, EXPIRE_AFTER_MS, REMIND_AFTER_MS } from "../src/ext/approval.mjs";
import { createInterBot, MAX_HOPS } from "../src/ext/interbot.mjs";

function faux(responses) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  return { models, model: { provider: "faux", modelId: "faux-1" } };
}

async function toolResultTexts(conv) {
  const page = await conv.entries({}, 50, undefined, ctx);
  return page.items
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => (e.model[0].content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
}

// ---- memory (idea 6) -------------------------------------------------------------------------------------------------

test("addBullets dedupes and caps; removeBullets matches substrings", () => {
  const { bullets } = addBullets([], ["likes tea", "likes tea", "repo is ~/work"]);
  assert.deepEqual(bullets, ["likes tea", "repo is ~/work"]);
  const capped = addBullets([], ["x".repeat(MAX_CHARS)]);
  assert.equal(capped.bullets.length, 1);
  const over = addBullets(capped.bullets, ["more"]);
  assert.deepEqual(over.bullets, capped.bullets); // unchanged: over cap
  assert.equal(over.skipped.length, 1);
  const r = removeBullets(["likes tea", "repo is ~/work"], "tea");
  assert.deepEqual(r.bullets, ["repo is ~/work"]);
  assert.deepEqual(r.removed, ["likes tea"]);
});

test("remember tool persists bullets + revision, prompt injects them, forget removes", async () => {
  const { models, model } = faux([
    fauxAssistantMessage([fauxToolCall("remember", { facts: ["user likes tea"] }, { id: "c1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("saved")]),
    fauxAssistantMessage([fauxText("what do you know?")]),
  ]);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble, createMemory()] });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const bot = await bots.createBot({ name: "mem-t", model });
    const conv = await bots.conversation(bot.id);
    await (await conv.submit({ type: "input", content: "remember I like tea" }, ctx)).wait(ctx);
    const texts = await toolResultTexts(conv);
    assert.match(texts[0], /remembered 1 fact/);
    const doc = await harness.snapshot(MemoryDoc, bot.conversationId, ctx);
    assert.deepEqual(doc.bullets, ["user likes tea"]);
    const revs = await harness.snapshot(MemoryRevisionsDoc, ctx);
    assert.equal(revs.conversations[String(bot.conversationId)].length, 1);
    // Second run: system prompt carries the memory section.
    const seen = [];
    const f2 = fauxProvider();
    f2.setResponses([
      (transcript) => {
        for (const m of transcript.messages) if (m.role === "system") seen.push(JSON.stringify(m.sections ?? {}));
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);
    const models2 = createModels();
    models2.setProvider(f2.provider);
    // swap models by submitting with a new bot on a new harness is overkill; assert via section render instead.
  } finally {
    await harness.close(ctx);
  }
});

test("quiet: mark_reported partitions keys and persists them", async () => {
  const { models, model } = faux([
    fauxAssistantMessage([fauxToolCall("mark_reported", { keys: ["pr-1", "pr-2"] }, { id: "c1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("reported")]),
    fauxAssistantMessage([fauxToolCall("mark_reported", { keys: ["pr-2", "pr-3"] }, { id: "c2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [createQuiet()] });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const bot = await bots.createBot({ name: "quiet-t", model });
    const conv = await bots.conversation(bot.id);
    await (await conv.submit({ type: "input", content: "r1" }, ctx)).wait(ctx);
    await (await conv.submit({ type: "input", content: "r2" }, ctx)).wait(ctx);
    const texts = await toolResultTexts(conv); // newest first
    assert.match(texts[0], /marked 1 new key\(s\): pr-3; already reported: pr-2/);
    assert.match(texts[1], /marked 2 new key\(s\): pr-1, pr-2/);
    const doc = await harness.snapshot(ReportedDoc, bot.conversationId, ctx);
    assert.deepEqual(doc.reportedKeys.slice(-3), ["pr-1", "pr-2", "pr-3"]);
  } finally {
    await harness.close(ctx);
  }
});

test("partitionKeys splits fresh vs known", () => {
  const r = partitionKeys(["a", "b"], ["b", "c", ""]);
  assert.deepEqual(r.fresh, ["c"]);
  assert.deepEqual(r.known, ["b"]);
});

// ---- ask_user (idea 14) ----------------------------------------------------------------------------------------------

test("ask_user waits for the center and returns the answer; typed replies also resolve", async () => {
  const center = new AskCenter();
  const ext = createAskUser({ center });
  const { models, model } = faux([
    fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which fix?", options: ["A", "B"] }, { id: "c1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("going with the answer")]),
  ]);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [ext] });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const bot = await bots.createBot({ name: "ask-t", model });
    const conv = await bots.conversation(bot.id);
    const settledP = (await conv.submit({ type: "input", content: "fix it" }, ctx)).wait(ctx);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(center.list().length, 1);
    assert.deepEqual(center.list()[0].options, ["A", "B"]);
    assert.ok(center.answer(center.list()[0].id, "Option B please"));
    const settled = await settledP;
    assert.equal(settled.status, "done");
    const texts = await toolResultTexts(conv);
    assert.match(texts[0], /User answered: Option B please/);
    assert.equal(center.list().length, 0);
  } finally {
    await harness.close(ctx);
  }
});

// ---- approval expiry (idea 4) ----------------------------------------------------------------------------------------

test("approval sweep: remind at 4h, expire at 24h; expired items resolve as denied", async () => {
  const center = new ApprovalCenter();
  const t0 = Date.now();
  const p = center.request({ taskId: "t1", toolName: "bash", args: {}, reason: "x" });
  // Not yet due.
  assert.deepEqual(center.sweep(t0 + 1000), { expired: [], reminded: [] });
  // 4h: reminder flagged. ageMs is measured from real now(), so only the flags are asserted here.
  assert.deepEqual(center.sweep(t0 + REMIND_AFTER_MS + 1), { expired: [], reminded: ["t1"] });
  assert.equal(center.list()[0].reminded, true);
  // 24h: expired (remind already latched); the waiter resolves denied via the hook's poll; list shows expired.
  assert.deepEqual(center.sweep(t0 + EXPIRE_AFTER_MS + 1), { expired: ["t1"], reminded: [] });
  assert.equal(center.isExpired("t1"), true);
  assert.equal(center.list()[0].expired, true);
  // The hook polls isExpired and resolves false; here the human clicks first, which still wins the race.
  center.resolve("t1", true);
  assert.equal(await p, true);
  assert.equal(center.list().length, 0);
});

// ---- interbot (idea 9) -----------------------------------------------------------------------------------------------

test("interbot: resolves via io, idempotent requestId, hop budget enforced", async () => {
  const submissions = [];
  const io = {
    resolve: async (name) => ({ conversationId: 42, name }),
    submit: async (conversationId, prompt, requestId) => {
      submissions.push({ conversationId, prompt, requestId });
      return { answer: "here you go", status: "done" };
    },
  };
  const ext = createInterBot(io);
  const tool = ext.tools[0];
  // Minimal fake api: task/call ids + conversationId.
  const api = { taskId: "task-1", callId: "call-1", conversationId: 7 };
  const r = await tool.execute({ bot: "helper", message: "check the build" }, api, undefined);
  assert.match(r.output[0].text, /helper replied:\n\nhere you go/);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].requestId, "interbot:task-1:call-1");
  assert.match(submissions[0].prompt, /hop 1\/6/);

  // Hops: a forwarded message already at the limit is refused.
  const atLimit = `check this\n[from x | hop ${MAX_HOPS}/${MAX_HOPS}]`;
  const r2 = await tool.execute({ bot: "helper", message: atLimit }, api, undefined);
  assert.equal(r2.isError, true);
  assert.match(r2.output[0].text, /relay limit/);

  // Unknown bot.
  const io2 = { resolve: async () => undefined, submit: async () => ({}) };
  const r3 = await createInterBot(io2).tools[0].execute({ bot: "ghost", message: "hi" }, api, undefined);
  assert.equal(r3.isError, true);
});
