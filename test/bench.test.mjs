process.env.TARSBOT_NO_DOTENV ??= "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { Desktop } from "../src/ext/desktop.mjs";
import { createApi } from "../src/api.mjs";
import { register } from "../src/routes/bench.mjs";

const MODE_A = ["desktop_screenshot", "desktop_windows", "desktop_launch", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll"];

test("bench route: creates a Bot whose tools are narrowed to the given names", async () => {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble, CodingTools, Desktop] });
  const bots = new BotRegistry(harness, { path: null });
  const api = createApi({ harness, bots, routes: [register] });
  const { port } = await api.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const post = (body) => fetch(`${base}/api/bench/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(`${base}/api/bench/health`)).json(), { ok: true });

    const res = await post({ name: "b-a", modelId: "glm-5.3", tools: MODE_A });
    assert.equal(res.status, 200);
    const bot = await res.json();
    assert.deepEqual([...bot.tools].sort(), [...MODE_A].sort());
    const conv = await bots.conversation(bot.id);
    assert.deepEqual((await conv.agent(ctx)).tools.map((t) => t.name).sort(), [...MODE_A].sort());

    assert.equal((await post({ name: "b-a", tools: MODE_A })).status, 409);
    assert.equal((await post({ name: "b-x", tools: [] })).status, 400);
    assert.equal((await post({ name: "b-y", tools: ["nope"] })).status, 400);
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});
