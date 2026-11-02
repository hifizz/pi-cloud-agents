// Offline tests for the per-session thinking level: PATCH /api/bots/:id/thinking-level,
// GET /api/bots/:id/thinking-levels, level normalization on model switch and fork, and the
// real request body sent upstream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { createApi } from "../src/api.mjs";
import { defaultThinkingLevel, supportedThinkingLevels, tokenRouterProvider } from "../src/models.mjs";
import { register as registerBotsModel } from "../src/routes/bots-model.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };

function fauxModels() {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  return models;
}

async function setup(botsPath = null) {
  const { harness } = await openHarness({ storage: new MemoryStorage(), models: fauxModels() });
  const bots = new BotRegistry(harness, { path: botsPath });
  const bot = await bots.createBot({ name: "target", model: FAUX });
  const api = createApi({ harness: {}, bots, routes: [registerBotsModel] });
  const { port } = await api.listen(0);
  const patch = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}` + path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}` + path);
    return { status: res.status, body: await res.json() };
  };
  return { harness, bots, bot, api, patch, get };
}

test("supportedThinkingLevels: only swe-2 has verified tiers; everything else offers nothing", () => {
  assert.deepEqual(supportedThinkingLevels("swe-2"), ["medium", "high", "max"]);
  for (const id of ["glm-5.3", "glm-5.3-flash", "claude-sonnet-5-5", "gpt-5.6-terra"]) {
    assert.deepEqual(supportedThinkingLevels(id), [], `${id}: no verified wire evidence, no fake menu`);
  }
  assert.deepEqual(supportedThinkingLevels("not-a-model"), []);
  assert.deepEqual(supportedThinkingLevels(undefined), []);
});

test("defaultThinkingLevel keeps a supported level; off/absent stays provider default", () => {
  assert.equal(defaultThinkingLevel("swe-2", "medium"), "medium");
  assert.equal(defaultThinkingLevel("swe-2", "max"), "max");
  assert.equal(defaultThinkingLevel("swe-2", "low"), "medium", "swe-2 has no low; climbs up to medium");
  assert.equal(defaultThinkingLevel("swe-2", "xhigh"), "max", "xhigh climbs up to max");
  assert.equal(defaultThinkingLevel("swe-2", "off"), undefined, "provider default is never upgraded");
  assert.equal(defaultThinkingLevel("swe-2", undefined), undefined, "unset stays unset");
  assert.equal(defaultThinkingLevel("glm-5.3", "high"), undefined, "glm takes no level");
  assert.equal(defaultThinkingLevel("not-a-model", "high"), undefined);
});

test("GET thinking-levels reads the durable agent, not just the record", async () => {
  const { harness, bots, bot, api, get, patch } = await setup();
  try {
    const first = await get(`/api/bots/${bot.id}/thinking-levels`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { levels: [], current: "off" }, "faux model: no levels, agent default off");

    await patch(`/api/bots/${bot.id}/model`, { modelId: "swe-2" });
    const second = await get(`/api/bots/${bot.id}/thinking-levels`);
    assert.deepEqual(second.body, { levels: ["medium", "high", "max"], current: "off" },
      "provider default survives a model switch (record is not upgraded)");

    await patch(`/api/bots/${bot.id}/thinking-level`, { level: "max" });
    const third = await get(`/api/bots/${bot.id}/thinking-levels`);
    assert.deepEqual(third.body, { levels: ["medium", "high", "max"], current: "max" });
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});

test("PATCH /api/bots/:id/thinking-level sets the durable agent and persists; off is a stored state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tars-thinking-"));
  const botsPath = join(dir, "bots.json");
  try {
    const { harness, bots, bot, api, patch } = await setup(botsPath);
    try {
      await patch(`/api/bots/${bot.id}/model`, { modelId: "swe-2" });
      const ok = await patch(`/api/bots/${bot.id}/thinking-level`, { level: "max" });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.bot.thinkingLevel, "max");
      const agent = await (await bots.conversation(bot.id)).agent(ctx);
      assert.equal(agent.thinkingLevel, "max", "durable agent change applied");

      const bots2 = new BotRegistry(harness, { path: botsPath });
      assert.equal(bots2.get(bot.id).thinkingLevel, "max", "survives a registry reload");
      assert.ok(readFileSync(botsPath, "utf8").includes('"thinkingLevel": "max"'));

      const cleared = await patch(`/api/bots/${bot.id}/thinking-level`, { level: "off" });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.bot.thinkingLevel, "off", "off is stored, not deleted");
      const agent2 = await (await bots.conversation(bot.id)).agent(ctx);
      assert.equal(agent2.thinkingLevel, "off", "durable level set to off: no reasoning_effort is sent");
    } finally {
      await api.close();
      await harness.close(ctx);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PATCH /api/bots/:id/thinking-level rejects unsupported levels, unknown models and unknown bots", async () => {
  const { harness, bots, bot, api, patch } = await setup();
  try {
    // Current model is faux (no levels): only "off" is allowed.
    assert.equal((await patch(`/api/bots/${bot.id}/thinking-level`, { level: "high" })).status, 400);
    assert.equal((await patch(`/api/bots/${bot.id}/thinking-level`, { level: "off" })).status, 200);

    await patch(`/api/bots/${bot.id}/model`, { modelId: "swe-2" });
    for (const body of [{ level: "low" }, { level: "xhigh" }, { level: "minimal" }, { level: 3 }, {}, { thinkingLevel: "max" }]) {
      assert.equal((await patch(`/api/bots/${bot.id}/thinking-level`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await patch("/api/bots/nope/thinking-level", { level: "max" })).status, 404);
    const agent = await (await bots.conversation(bot.id)).agent(ctx);
    assert.equal(agent.thinkingLevel, "off", "rejections never touch the conversation");
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});

test("model switch keeps provider default and normalizes a configured level deterministically", async () => {
  const { harness, bots, bot, api, patch } = await setup();
  try {
    // Provider default across a switch: nothing is configured, nothing is invented.
    await patch(`/api/bots/${bot.id}/model`, { modelId: "swe-2" });
    assert.equal(bots.get(bot.id).thinkingLevel, undefined, "no level invented on switch");
    assert.equal((await (await bots.conversation(bot.id)).agent(ctx)).thinkingLevel, "off");

    // A configured level stays when the new model supports it.
    await patch(`/api/bots/${bot.id}/thinking-level`, { level: "medium" });
    const keep = await patch(`/api/bots/${bot.id}/model`, { modelId: "swe-2" });
    assert.equal(keep.body.bot.thinkingLevel, "medium");

    // A stored level the new model cannot take is cleared from the conversation and the record.
    const cleared = await patch(`/api/bots/${bot.id}/model`, { modelId: "glm-5.3" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.bot.thinkingLevel, undefined, "glm takes no level; record field removed");
    assert.equal((await (await bots.conversation(bot.id)).agent(ctx)).thinkingLevel, "off",
      "conversation cleared too: stale level never reaches the wire");
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});

test("a configure failure leaves the record unchanged (no persisted lie)", async () => {
  const { harness, bots, bot, api } = await setup();
  try {
    await bots.setModel(bot.id, "swe-2");
    await bots.setThinkingLevel(bot.id, "max");
    assert.equal(bots.get(bot.id).thinkingLevel, "max");
    // Make the durable configure throw: no conversation behind the record.
    bots.conversation = async () => undefined;
    assert.equal(await bots.setThinkingLevel(bot.id, "high"), undefined, "missing conversation reports not-found");
    assert.equal(bots.get(bot.id).thinkingLevel, "max", "record untouched");
    bots.conversation = async () => ({ agent: async () => ({ thinkingLevel: "off" }), configure: async () => { throw new Error("commit failed"); } });
    await assert.rejects(() => bots.setModel(bot.id, "glm-5.3"), /commit failed/);
    assert.equal(bots.get(bot.id).model.modelId, "swe-2", "failed configure keeps the old model on the record");
    await assert.rejects(() => bots.setThinkingLevel(bot.id, "high"), /commit failed/);
    assert.equal(bots.get(bot.id).thinkingLevel, "max", "failed configure keeps the old level on the record");
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});

test("fork records the child agent's effective level, normalized to the child's model", async () => {
  const { harness, bots, api } = await setup();
  try {
    const parent = await bots.createBot({ name: "p", model: FAUX });
    const conv = await bots.conversation(parent.id);
    const say = async (text) => {
      const sub = await conv.submit({ type: "input", content: text }, ctx);
      await sub.wait(ctx);
      await conv.waitForIdle(ctx);
    };
    // pi.agent is rewindable: a level in effect at the fork entry is what an asOf fork inherits.
    await say("first");
    const atFirst = (await conv.entries({}, 100, undefined, ctx)).items.find((e) => e.model?.[0]?.role === "assistant");
    await conv.configure({ thinkingLevel: "high" }, ctx); // set after the fork point
    await say("second");

    // Fork at an entry before the level existed: child keeps provider default, not the parent's current level.
    const child = await bots.forkBot(parent.id, { name: "c", entryId: atFirst.id });
    const childAgent = await (await bots.conversation(child.id)).agent(ctx);
    assert.equal(childAgent.thinkingLevel, "off", "asOf fork predates the parent's level");
    assert.equal(child.thinkingLevel, undefined, "record mirrors the child agent");

    // A fork whose asOf agent carries a level the record model cannot take is normalized to off.
    const atSecond = (await conv.entries({}, 1, undefined, ctx)).items[0].id;
    const child2 = await bots.forkBot(parent.id, { name: "c2", entryId: atSecond });
    const child2Agent = await (await bots.conversation(child2.id)).agent(ctx);
    assert.equal(child2Agent.thinkingLevel, "off", "faux model takes no catalog level: normalized to off");
    assert.equal(child2.thinkingLevel, undefined, "record stays clear");

    // A fork onto a model that takes the level keeps it (swe-2 accepts medium/high/max).
    const child3 = await bots.forkBot(parent.id, { name: "c3", entryId: atSecond, modelId: "swe-2" });
    const child3Agent = await (await bots.conversation(child3.id)).agent(ctx);
    assert.equal(child3Agent.thinkingLevel, "high", "swe-2 takes high");
    assert.equal(child3.thinkingLevel, "high", "record mirrors the effective child level");
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});

test("changing one session never touches another session's level", async () => {
  const { harness, bots, api, patch } = await setup();
  try {
    const other = await bots.createBot({ name: "other", model: FAUX, thinkingLevel: "high" });
    const b = bots.get("target");
    await patch(`/api/bots/${b.id}/model`, { modelId: "swe-2" });
    await patch(`/api/bots/${b.id}/thinking-level`, { level: "max" });
    assert.equal(bots.get(other.id).thinkingLevel, "high");
    assert.equal((await (await bots.conversation(other.id)).agent(ctx)).thinkingLevel, "high");
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});

test("createBot persists spec.thinkingLevel on the record", async () => {
  const { harness } = await openHarness({ storage: new MemoryStorage(), models: fauxModels() });
  const bots = new BotRegistry(harness, { path: null });
  try {
    const bot = await bots.createBot({ name: "thinker", model: FAUX, thinkingLevel: "high" });
    assert.equal(bot.thinkingLevel, "high");
    const agent = await (await bots.conversation(bot.id)).agent(ctx);
    assert.equal(agent.thinkingLevel, "high");
  } finally {
    await harness.close(ctx);
  }
});

// The wire contract: the real tokenRouterProvider catalog plus pi-ai's openai-completions serializer.
// TOKEN_ROUTER_API_KEY is a fake; fetch is stubbed, nothing leaves the process, env is restored.
test("wire: swe-2 medium/high/max reach the body verbatim; other models keep the old request shape", async () => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  const requests = [];
  try {
    process.env.TOKEN_ROUTER_BASE_URL = "https://router.test/v1";
    process.env.TOKEN_ROUTER_API_KEY = "fake-test-key";
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    };
    const models = createModels();
    models.setProvider(tokenRouterProvider());
    const swe2 = models.getModel("tokenrouter", "swe-2");
    assert.ok(swe2, "swe-2 in the real catalog");
    for (const level of ["medium", "high", "max"]) {
      const stream = models.streamSimple(swe2, { messages: [{ role: "user", content: "hi" }] }, { reasoning: level });
      await stream.result();
      const body = requests.at(-1).body;
      assert.equal(body.model, "swe-2");
      assert.equal(body.reasoning_effort, level, `level ${level} must reach the wire verbatim`);
    }
    // Provider default ("off"/unset) sends no reasoning_effort at all.
    const s0 = models.streamSimple(swe2, { messages: [{ role: "user", content: "hi" }] }, {});
    await s0.result();
    assert.equal("reasoning_effort" in requests.at(-1).body, false);
    // Unverified models keep the pre-feature request shape: reasoning requested, nothing sent.
    for (const id of ["glm-5.3", "claude-sonnet-5-5", "gpt-5.6-terra"]) {
      const model = models.getModel("tokenrouter", id);
      const stream = models.streamSimple(model, { messages: [{ role: "user", content: "hi" }] }, { reasoning: "high" });
      await stream.result();
      const body = requests.at(-1).body;
      assert.equal(body.model, id);
      assert.equal("reasoning_effort" in body, false, `${id}: request shape unchanged until the protocol is verified`);
    }
    // extraModelIds (unknown catalog additions) get no reasoning_effort either.
    const models2 = createModels();
    models2.setProvider(tokenRouterProvider(["unknown-model"]));
    const unknown = models2.getModel("tokenrouter", "unknown-model");
    const s3 = models2.streamSimple(unknown, { messages: [{ role: "user", content: "hi" }] }, { reasoning: "high" });
    await s3.result();
    assert.equal("reasoning_effort" in requests.at(-1).body, false, "unknown models never get effort passthrough");
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
});
