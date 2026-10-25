// Offline tests for the bdots-borrowed extensions: loop guard (1), output guard (2), fetch_markdown (16).
// Model-driven flows use the faux provider; pure helpers are tested directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { createLoopGuard, stableKey } from "../src/ext/loop-guard.mjs";
import { createOutputGuard, truncateText } from "../src/ext/output-guard.mjs";
import { createFetchMarkdown, htmlToText } from "../src/ext/fetch-markdown.mjs";
import { Preamble } from "../src/ext/preamble.mjs";

function faux(responses) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  return { models, model: { provider: "faux", modelId: "faux-1" } };
}

/** Text of every tool result in the active transcript. */
async function toolResultTexts(conv) {
  const page = await conv.entries({}, 50, undefined, ctx);
  return page.items
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => (e.model[0].content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
}

const echoTool = (name = "echo") => ({
  name,
  description: "echo",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { output: [{ type: "text", text: "ok" }] };
  },
});

test("stableKey: key order does not matter", () => {
  assert.equal(stableKey({ a: 1, b: { c: 2, d: 3 } }), stableKey({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(stableKey({ a: 1 }), stableKey({ a: 2 }));
});

test("loop guard blocks the 6th identical call and lets a changed call through", async () => {
  // Six rounds: five identical echo calls pass, the sixth is blocked with a message, then a different call resets.
  const responses = [];
  for (let i = 0; i < 5; i++) responses.push(fauxAssistantMessage([fauxToolCall("echo", { x: 1 }, { id: `c${i}` })], { stopReason: "toolUse" }));
  responses.push(fauxAssistantMessage([fauxToolCall("echo", { x: 1 }, { id: "c5" })], { stopReason: "toolUse" }));
  responses.push(fauxAssistantMessage([fauxToolCall("echo", { x: 2 }, { id: "c6" })], { stopReason: "toolUse" }));
  responses.push(fauxAssistantMessage([fauxText("done")]));
  const { models, model } = faux(responses);
  const tools = { tools: [echoTool()] };
  const guard = createLoopGuard({ maxRepeats: 5 });
  const { harness } = await openHarness({
    storage: new MemoryStorage(),
    models,
    extensions: [guard, { name: "test.echoExt", ...tools }],
  });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const bot = await bots.createBot({ name: "loop-t", model, ...tools });
    const conv = await bots.conversation(bot.id);
    const settled = await (await conv.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    const texts = await toolResultTexts(conv);
    assert.ok(texts.length >= 7, `expected >=7 results, got ${texts.length}`);
    const blocked = texts.find((t) => /same arguments/i.test(t));
    assert.ok(blocked, `no blocked result among: ${texts.map((t) => t.slice(0, 30))}`);
    // The call after the block (changed args) still ran and returned normally.
    assert.ok(texts.filter((t) => t === "ok").length >= 6);
  } finally {
    await harness.close(ctx);
  }
});

test("output guard truncates long text results with a marker", async () => {
  const long = "x".repeat(20000);
  const noisy = {
    name: "noisy",
    description: "returns a lot",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: [{ type: "text", text: long }] };
    },
  };
  const { models, model } = faux([
    fauxAssistantMessage([fauxToolCall("noisy", {}, { id: "c1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const { harness } = await openHarness({
    storage: new MemoryStorage(),
    models,
    extensions: [createOutputGuard({ maxChars: 1000 }), { name: "test.noisyExt", tools: [noisy] }],
  });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const bot = await bots.createBot({ name: "out-t", model, tools: [noisy] });
    const conv = await bots.conversation(bot.id);
    await (await conv.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    const texts = await toolResultTexts(conv);
    const text = texts[0] ?? "";
    assert.ok(text.length < 20000, `expected truncation, got ${text.length}`);
    assert.match(text, /output truncated/);
  } finally {
    await harness.close(ctx);
  }
});

test("truncateText leaves short text alone", () => {
  assert.equal(truncateText("short", 100), null);
  const t = truncateText("a".repeat(150), 100);
  assert.match(t, /output truncated/);
  assert.ok(t.startsWith("a".repeat(100)));
});

test("fetch_markdown: html stripped, errors are results not throws", async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k === "content-type" ? "text/html" : null) },
    text: async () => "<html><script>bad()</script><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>",
  });
  const ext = createFetchMarkdown({ fetch: fetchImpl });
  const tool = ext.tools[0];
  const r = await tool.execute({ url: "https://example.com/x" }, { env: undefined }, undefined);
  assert.ok(!r.isError);
  const text = r.output[0].text;
  assert.match(text, /Title/);
  assert.match(text, /Hello & welcome/);
  assert.doesNotMatch(text, /bad\(\)/);

  const bad = await tool.execute({ url: "ftp://example.com" }, {}, undefined);
  assert.equal(bad.isError, true);

  const failing = createFetchMarkdown({ fetch: async () => { throw new Error("boom"); } });
  const r2 = await failing.tools[0].execute({ url: "https://example.com" }, {}, undefined);
  assert.equal(r2.isError, true);
  assert.match(r2.output[0].text, /boom/);
});

test("htmlToText drops scripts and decodes entities", () => {
  const t = htmlToText('<style>a{}</style><p>one</p><script>x</script><p>two &lt;three&gt;</p>');
  assert.match(t, /one/);
  assert.match(t, /two <three>/);
  assert.doesNotMatch(t, /script|style/);
});
