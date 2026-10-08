import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Routines, createRoutine, listRoutines } from "../src/ext/routines.mjs";

const f = fauxProvider();
const models = createModels();
models.setProvider(f.provider);
f.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("ok")])));
const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Routines] });
const bots = new BotRegistry(harness, { path: null });
const bot = await bots.createBot({ name: "r", model: { provider: "faux", modelId: "faux-1" } });
await createRoutine(harness, { botConversationId: bot.conversationId, prompt: "tick", everyMs: 300 });
const g = await harness.taskGraph(ctx);
g.subscribe((v) => {
  for (const n of Object.values(v.tasks)) if (n.kind?.includes("routine")) console.log("graph", n.id, n.state?.status, n.abort ?? "");
});
await new Promise((r) => setTimeout(r, 1600));
console.log(JSON.stringify((await listRoutines(harness)).map((r) => ({ s: r.status, n: r.fireCount }))));
await harness.close(ctx);
