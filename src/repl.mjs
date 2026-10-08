// Command-line chat with a Bot (debug client). Usage: node src/repl.mjs [botName]
// Commands: /bots  /new <name>  /use <name>  /history  /steer <text>  /abort  /quit
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { watchEvents } from "@earendil-works/pi-durable";
import { ctx } from "./harness.mjs";
import { BotRegistry } from "./bots.mjs";
import { bootstrap } from "./runtime.mjs";

const { harness } = await bootstrap();
const bots = new BotRegistry(harness);
const rl = createInterface({ input: stdin, output: stdout });

let current = bots.get(process.argv[2] ?? "") ?? bots.list()[0];
if (!current) current = await bots.createBot({ name: "tars" });
let stream;

function textOf(message) {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  return (c ?? []).map((b) => (b.type === "text" ? b.text : b.type === "toolCall" ? `[call ${b.name}]` : "")).join("");
}

async function attach() {
  await stream?.stop();
  stream = await watchEvents(harness, current.conversationId, ctx);
  stream.start(async (events) => {
    for (const e of events) {
      if (e.type === "message_update") {
        for (const ch of e.changes) {
          if (ch.type === "text_delta") stdout.write(ch.delta);
          else if (ch.type === "thinking_delta") stdout.write(`\x1b[2m${ch.delta}\x1b[0m`);
        }
      } else if (e.type === "message_end") stdout.write("\n");
      else if (e.type === "tool_execution_start") stdout.write(`\x1b[36m→ ${e.toolName} ${JSON.stringify(e.args).slice(0, 200)}\x1b[0m\n`);
      else if (e.type === "tool_execution_update" && e.output) {
        const t = "set" in e.output ? e.output.set : (e.output.append ?? "");
        if (t) stdout.write(`\x1b[2m${t.slice(-500)}\x1b[0m`);
      } else if (e.type === "tool_execution_end") stdout.write(`\x1b[36m← ${e.toolName} done\x1b[0m\n`);
      else if (e.type === "task_failed") stdout.write(`\x1b[31m! ${e.kind}: ${e.message}\x1b[0m\n`);
      else if (e.type === "auto_retry_start") stdout.write(`\x1b[33m(retry ${e.attempt}: ${e.errorMessage})\x1b[0m\n`);
    }
  });
}

async function history() {
  const conv = await bots.conversation(current.id);
  const page = await conv.entries({}, 50, undefined, ctx);
  for (const entry of [...page.items].reverse()) {
    const msg = entry.model?.[0];
    if (msg?.role === "user" || msg?.role === "assistant") console.log(`${msg.role}: ${textOf(msg).slice(0, 300)}`);
  }
}

console.log(`TARSBot REPL — bot "${current.name}" (${current.model.modelId}). /help for commands.`);
await attach();
rl.setPrompt("> ");
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!line) {
    rl.prompt();
    continue;
  }
  const conv = await bots.conversation(current.id);
  if (line === "/quit") break;
  if (line === "/help") console.log("/bots /new <name> /use <name> /history /steer <text> /abort /quit");
  else if (line === "/bots") for (const b of bots.list()) console.log(`${b.id} ${b.name} ${b.model.modelId}`);
  else if (line.startsWith("/new ")) {
    current = await bots.createBot({ name: line.slice(5).trim() });
    await attach();
  } else if (line.startsWith("/use ")) {
    current = bots.get(line.slice(5).trim()) ?? current;
    await attach();
  } else if (line === "/history") await history();
  else if (line === "/abort") await conv.abort(ctx);
  else if (line.startsWith("/steer ")) await conv.submit({ type: "input", content: line.slice(7), whenBusy: "steer" }, ctx);
  else {
    const sub = await conv.submit({ type: "input", content: line }, ctx);
    const settled = await sub.wait(ctx);
    if (settled.status !== "done") console.log(`(${settled.status}${settled.reason ? `: ${settled.reason}` : ""})`);
  }
  rl.prompt();
}
await stream?.stop();
await harness.close(ctx);
rl.close();
