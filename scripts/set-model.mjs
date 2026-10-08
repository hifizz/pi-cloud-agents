// Switch a Bot's model (server must be stopped: single-writer storage).
// Usage: node scripts/set-model.mjs <bot> <modelId>
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../src/config.mjs";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";

const [name, modelId] = process.argv.slice(2);
if (!name || !modelId) throw new Error("usage: set-model.mjs <bot> <modelId>");
const { harness } = await openHarness({ resume: false });
const bots = new BotRegistry(harness);
const bot = bots.get(name);
if (!bot) throw new Error(`bot not found: ${name}`);
const model = { provider: config.provider, modelId };
await (await bots.conversation(bot.id)).configure({ model }, ctx);
await harness.close(ctx);
const file = JSON.parse(readFileSync(config.botsPath, "utf8"));
for (const b of file.bots) if (b.id === bot.id) b.model = model;
writeFileSync(config.botsPath, JSON.stringify(file, null, 2));
console.log(`${bot.name} -> ${modelId}`);
