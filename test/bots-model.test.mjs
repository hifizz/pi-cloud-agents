// Offline tests for the live model switch PATCH /api/bots/:id/model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { createApi } from "../src/api.mjs";
import { availableModelIds } from "../src/models.mjs";
import { register as registerBotsModel } from "../src/routes/bots-model.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };

function fauxModels() {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses([]);
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
  return { harness, bots, bot, api, patch };
}

test("PATCH /api/bots/:id/model: whitelisted id switches the durable agent and persists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tars-model-"));
  const botsPath = join(dir, "bots.json");
  try {
    const { harness, bots, bot, api, patch } = await setup(botsPath);
    try {
      const modelId = "glm-5.3-flash";
      const ok = await patch(`/api/bots/${bot.id}/model`, { modelId });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.bot.model.modelId, modelId);
      assert.equal(ok.body.bot.model.provider, FAUX.provider, "provider keeps the record's, not the catalog's");

      const conv = await bots.conversation(bot.id);
      const agent = await conv.agent(ctx);
      assert.equal(agent.model.modelId, modelId, "durable agent change applied");

      const bots2 = new BotRegistry(harness, { path: botsPath });
      assert.equal(bots2.get(bot.id).model.modelId, modelId, "survives a registry reload from bots.json");
      assert.ok(readFileSync(botsPath, "utf8").includes(`"modelId": "${modelId}"`));
    } finally {
      await api.close();
      await harness.close(ctx);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PATCH /api/bots/:id/model: non-whitelisted id and bad bodies are 400, unknown bot is 404", async () => {
  const { harness, bots, bot, api, patch } = await setup();
  try {
    for (const body of [{ modelId: "not-a-model" }, { modelId: 1 }, {}, { model: "glm-5.3" }]) {
      assert.equal((await patch(`/api/bots/${bot.id}/model`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await patch("/api/bots/nope/model", { modelId: "glm-5.3" })).status, 404);
    assert.equal(bots.get(bot.id).model.modelId, FAUX.modelId, "rejections never touch the record");
    const agent = await (await bots.conversation(bot.id)).agent(ctx);
    assert.equal(agent.model.modelId, FAUX.modelId, "rejections never touch the conversation");
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});

test("PATCH /api/bots/:id/model accepts every catalog id", async () => {
  const { harness, bots, bot, api, patch } = await setup();
  try {
    for (const modelId of availableModelIds()) {
      const res = await patch(`/api/bots/${bot.id}/model`, { modelId });
      assert.equal(res.status, 200, modelId);
      assert.equal(res.body.bot.model.modelId, modelId);
    }
    assert.equal((await (await bots.conversation(bot.id)).agent(ctx)).model.modelId, availableModelIds().at(-1));
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});

test("guard rejection blocks the route (auth contract)", async () => {
  const api = createApi({ harness: {}, bots: { setModel: async () => ({}) }, routes: [registerBotsModel] });
  api.app.guard(() => {
    const e = new Error("unauthorized");
    e.status = 401;
    throw e;
  });
  const { port } = await api.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bots/x/model`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "glm-5.3" }),
    });
    assert.notEqual(res.status, 200, "guard must intercept before the handler");
  } finally {
    await api.close();
  }
});
