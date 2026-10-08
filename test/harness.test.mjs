import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";

function faux(responses) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  return { models, model: { provider: "faux", modelId: "faux-1" } };
}

test("createBot + submit answers (MemoryStorage + faux)", async () => {
  const { models, model } = faux([fauxAssistantMessage([fauxText("Paris")])]);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble] });
  const bots = new BotRegistry(harness, { path: null });
  const bot = await bots.createBot({ name: "t1", model });
  const conv = await bots.conversation(bot.id);
  const settled = await (await conv.submit({ type: "input", content: "Capital of France?" }, ctx)).wait(ctx);
  assert.equal(settled.status, "done");
  await harness.close(ctx);
});

test("TEST-F01-0: history survives reopen (SQLite)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tars-"));
  const db = join(dir, "t.sqlite");
  const botsPath = join(dir, "bots.json");
  try {
    let { models, model } = faux([fauxAssistantMessage([fauxText("Paris")])]);
    let { harness } = await openHarness({ storage: await openNodeSqliteStorage(db), models, extensions: [Preamble] });
    let bots = new BotRegistry(harness, { path: botsPath });
    const bot = await bots.createBot({ name: "persist", model });
    const conv = await bots.conversation(bot.id);
    await (await conv.submit({ type: "input", content: "Capital of France?", requestId: "q1" }, ctx)).wait(ctx);
    await harness.close(ctx);

    ({ models } = faux([]));
    ({ harness } = await openHarness({ storage: await openNodeSqliteStorage(db), models, extensions: [Preamble] }));
    bots = new BotRegistry(harness, { path: botsPath });
    const again = await bots.conversation("persist");
    assert.ok(again, "bot restored from bots.json");
    const page = await again.entries({}, 50, undefined, ctx);
    const roles = page.items.map((e) => e.model?.[0]?.role).filter(Boolean);
    assert.ok(roles.includes("user") && roles.includes("assistant"), `roles: ${roles}`);
    // requestId dedupe across restart (REQ-F01-4): same request returns same submission, no new model call
    const s1 = await again.submit({ type: "input", content: "Capital of France?", requestId: "q1" }, ctx);
    const s1b = await again.submit({ type: "input", content: "Capital of France?", requestId: "q1" }, ctx);
    assert.equal(s1.id, s1b.id);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
