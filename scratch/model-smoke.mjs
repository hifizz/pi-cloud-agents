// TEST-F08-0: complete() smoke call returns usage and cost.
import { config } from "../src/config.mjs";
import { createTarsModels } from "../src/models.mjs";

const models = createTarsModels();
const model = models.getModel(config.provider, config.defaultModelId);
if (!model) throw new Error(`model not found: ${config.defaultModelId}`);

const res = await models.complete(model, {
  messages: [{ role: "user", content: "Reply with exactly: pong", timestamp: Date.now() }],
});
const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("");
const thinking = res.content.filter((c) => c.type === "thinking").length;
console.log(JSON.stringify({ model: model.id, stopReason: res.stopReason, text, thinkingBlocks: thinking, usage: res.usage, error: res.errorMessage }, null, 2));
if (res.stopReason === "error") process.exit(1);
