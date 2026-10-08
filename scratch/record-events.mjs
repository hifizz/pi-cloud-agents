// Records the real WS frame stream of the API into web/test/fixtures/*.json (used by the web reducer tests).
//   node scratch/record-events.mjs
// Scenarios: run-basic (thinking + text + bash + answer), run-tool (failing bash command), run-abort (tool interrupted
// by abort), and run-real (real model, only when TOKEN_ROUTER_API_KEY is set). Secrets are never written.
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { WebSocket } from "ws";
import { ROOT, defaultModel } from "../src/config.mjs";
import { ctx, openHarness } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { createApi, toJson } from "../src/api.mjs";

const OUT = join(ROOT, "web", "test", "fixtures");
mkdirSync(OUT, { recursive: true });

const toolCall = (name, args, id) => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

async function record({ file, prompt, responses, real = false, abortOnTool = false, timeoutMs = 60_000 }) {
  const work = mkdtempSync(join(tmpdir(), "tars-rec-"));
  let models;
  let model;
  if (real) {
    model = defaultModel();
  } else {
    const f = fauxProvider({ tokensPerSecond: 40, tokenSize: { min: 1, max: 3 } });
    models = createModels();
    models.setProvider(f.provider);
    f.setResponses(responses);
    model = { provider: "faux", modelId: "faux-1" };
  }
  const { harness } = await openHarness({
    storage: new MemoryStorage(),
    ...(models ? { models } : {}),
    extensions: [Preamble, CodingTools],
    env: (target) => new NodeExecutionEnv({ cwd: target?.cwd ?? work }),
  });
  const bots = new BotRegistry(harness, { path: null });
  const bot = await bots.createBot({ name: "rec", model, cwd: work });
  const api = createApi({ harness, bots });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

  const frames = [];
  let posted = false;
  let aborted = false;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/bots/${bot.id}/stream`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`${file}: timeout`));
    }, timeoutMs);
    ws.on("message", async (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      if (frame.type === "snapshot" && !posted) {
        posted = true;
        await post(`/api/bots/${bot.id}/input`, { text: prompt, requestId: "rec-1" });
      }
      if (frame.type === "events") {
        if (abortOnTool && !aborted && frame.events.some((e) => e.type === "tool_execution_start")) {
          aborted = true;
          await new Promise((r) => setTimeout(r, 200));
          await post(`/api/bots/${bot.id}/abort`, {});
        }
        if (frame.events.some((e) => e.type === "run_end")) {
          // linger briefly so trailing events (submission settle, usage_changed) are captured
          setTimeout(() => {
            clearTimeout(timer);
            ws.close();
          }, 400);
        }
      }
    });
    ws.on("close", resolve);
    ws.on("error", reject);
  });
  await api.close();
  await harness.close(ctx);
  rmSync(work, { recursive: true, force: true });
  const json = toJson(frames);
  if (/sk-[A-Za-z0-9]{10,}/.test(json) || (process.env.TOKEN_ROUTER_API_KEY && json.includes(process.env.TOKEN_ROUTER_API_KEY))) {
    throw new Error(`${file}: fixture appears to contain a secret; not written`);
  }
  writeFileSync(join(OUT, file), JSON.stringify(JSON.parse(json), null, 1));
  const kinds = new Set(frames.flatMap((f) => (f.type === "events" ? f.events.map((e) => e.type) : [f.type])));
  console.log(`${file}: ${frames.length} frames; event types: ${[...kinds].join(", ")}`);
}

await record({
  file: "run-basic.json",
  prompt: "List the files in the current directory and tell me what you see.",
  responses: [
    fauxAssistantMessage(
      [
        fauxThinking("The user wants a directory listing. I should run ls."),
        fauxText("Let me look at the directory."),
        fauxToolCall("bash", { command: "echo hello > notes.txt && ls" }, { id: "call-1" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxThinking("One file, notes.txt."), fauxText("The directory contains a single file: notes.txt.")]),
  ],
});

await record({
  file: "run-tool.json",
  prompt: "Run a command that fails.",
  responses: [
    toolCall("bash", { command: "echo partial output; echo oops >&2; exit 3" }, "call-fail"),
    fauxAssistantMessage([fauxText("The command failed with exit code 3.")]),
  ],
});

await record({
  file: "run-abort.json",
  prompt: "Run a very long command.",
  abortOnTool: true,
  responses: [toolCall("bash", { command: "echo started; sleep 30" }, "call-slow"), fauxAssistantMessage([fauxText("unreachable")])],
});

if (process.env.TOKEN_ROUTER_API_KEY) {
  try {
    await record({ file: "run-real.json", prompt: "What is 1+1? Answer in one short sentence.", real: true });
  } catch (e) {
    console.error(`run-real.json not recorded: ${e.message}`);
    process.exitCode = 1;
  }
} else {
  console.log("TOKEN_ROUTER_API_KEY not set; skipping run-real.json");
}
process.exit(process.exitCode ?? 0);
