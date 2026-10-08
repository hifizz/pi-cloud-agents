import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry, READ_ONLY_TOOLS } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { Desktop } from "../src/ext/desktop.mjs";
import { Search } from "../src/ext/search.mjs";
import { History } from "../src/ext/history.mjs";
import { createApi } from "../src/api.mjs";
import { register as registerFork } from "../src/routes/fork.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };

async function setup(responses, { routes } = {}) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  const { harness } = await openHarness({
    storage: new MemoryStorage(),
    models,
    extensions: [Preamble, CodingTools, Desktop, Search, History],
  });
  const bots = new BotRegistry(harness, { path: null });
  return { harness, bots, routes, faux: f };
}

// Submit input and wait until the whole run (tool rounds included) is finished.
async function say(bots, id, text) {
  const conv = await bots.conversation(id);
  const settled = await (await conv.submit({ type: "input", content: text }, ctx)).wait(ctx);
  await conv.waitForIdle(ctx);
  return settled;
}
const toolNames = async (bots, id) => (await (await bots.conversation(id)).agent(ctx)).tools.map((t) => t.name).sort();
const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""));

test("TEST-F07-1: readOnly fork inherits history and cannot use write tools", async () => {
  const { harness, bots } = await setup([
    fauxAssistantMessage([fauxText("Paris is the capital.")]),
    fauxAssistantMessage([fauxText("About 2 million people.")]),
    // child run: tries a tool it does not have, then gives up
    fauxAssistantMessage([fauxToolCall("write", { path: "/tmp/x", content: "hi" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("I cannot write files.")]),
  ]);
  try {
    const parent = await bots.createBot({ name: "parent", model: FAUX });
    assert.equal((await say(bots, parent.id, "Capital of France?")).status, "done");
    assert.equal((await say(bots, parent.id, "How many people live there?")).status, "done");

    const parentTools = await toolNames(bots, parent.id);
    for (const t of ["bash", "write", "edit", "desktop_click", "read", "search_history"]) assert.ok(parentTools.includes(t), `parent has ${t}`);

    const child = await bots.forkBot("parent", { name: "reviewer", readOnly: true });
    assert.equal(child.parent.botId, parent.id);
    assert.ok(child.parent.entryId);
    assert.notEqual(child.conversationId, parent.conversationId);
    assert.equal(bots.get("reviewer").id, child.id);
    assert.deepEqual(child.model, parent.model);

    // History: the fork sees the parent's transcript.
    const childConv = await bots.conversation(child.id);
    const view = await childConv.context(ctx);
    const texts = view.messages.filter((m) => m.role !== "system").map(textOf).join("\n");
    assert.match(texts, /Capital of France/);
    assert.match(texts, /2 million/);
    const entries = (await childConv.entries({}, 100, undefined, ctx)).items;
    assert.ok(entries.length >= 4);

    // Tools: only the read-only subset (by name), nothing that writes.
    const childTools = await toolNames(bots, child.id);
    assert.ok(childTools.length > 0);
    for (const t of childTools) assert.ok(READ_ONLY_TOOLS.includes(t), `unexpected tool ${t}`);
    for (const t of ["bash", "write", "edit", "desktop_click"]) assert.ok(!childTools.includes(t), `child must not have ${t}`);
    for (const t of ["read", "search_history", "web_search", "desktop_screenshot"]) assert.ok(childTools.includes(t), `child keeps ${t}`);
    // The parent is unaffected.
    assert.deepEqual(await toolNames(bots, parent.id), parentTools);

    // A call to a tool that is not offered yields an error result instead of running.
    assert.equal((await say(bots, child.id, "Please write a file")).status, "done");
    const after = (await childConv.entries({}, 100, undefined, ctx)).items;
    const toolResult = after.find((e) => e.model?.[0]?.role === "toolResult" && e.model[0].toolName === "write");
    assert.ok(toolResult, "write call got a tool result");
    assert.equal(toolResult.model[0].isError, true);
    assert.match(textOf(toolResult.model[0]), /not available/i);
    assert.equal(toolResult.data?.diagnostics?.[0]?.code, "tool_unavailable");
  } finally {
    await harness.close(ctx);
  }
});

test("forkBot at an earlier entry, with model and instructions overrides", async () => {
  const { harness, bots } = await setup([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
  try {
    const parent = await bots.createBot({ name: "p", model: FAUX });
    await say(bots, parent.id, "first question");
    const conv = await bots.conversation(parent.id);
    const atFirst = (await conv.entries({}, 100, undefined, ctx)).items.find((e) => e.model?.[0]?.role === "assistant");
    await say(bots, parent.id, "second question");

    const child = await bots.forkBot(parent.name, {
      name: "branch",
      entryId: atFirst.id,
      modelId: "faux-2",
      instructions: "Be brief.",
    });
    assert.equal(child.parent.entryId, atFirst.id);
    assert.deepEqual(child.model, { provider: "faux", modelId: "faux-2" });
    assert.equal(child.instructions, "Be brief.");
    const agent = await (await bots.conversation(child.id)).agent(ctx);
    assert.equal(agent.model.modelId, "faux-2");
    assert.equal(agent.instructions, "Be brief.");
    // Not read-only: keeps the full tool set.
    assert.ok((await toolNames(bots, child.id)).includes("write"));

    const text = (await (await bots.conversation(child.id)).context(ctx)).messages.filter((m) => m.role !== "system").map(textOf).join("\n");
    assert.match(text, /first question/);
    assert.doesNotMatch(text, /second question/);

    await assert.rejects(() => bots.forkBot("p", { name: "branch" }), /exists/);
    await assert.rejects(() => bots.forkBot("nope", { name: "x" }), /not found/);
    await assert.rejects(() => bots.forkBot("p", { name: "" }), /name is required/);
  } finally {
    await harness.close(ctx);
  }
});

test("POST /api/bots/:id/fork", async () => {
  const { harness, bots } = await setup([fauxAssistantMessage([fauxText("hello")])]);
  const api = createApi({ harness, bots, routes: [registerFork] });
  const { port } = await api.listen(0);
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    const parent = await bots.createBot({ name: "src", model: FAUX });
    assert.equal((await post("/api/bots/nope/fork", { name: "a" })).status, 404);
    // Nothing to fork from yet.
    assert.equal((await post(`/api/bots/${parent.id}/fork`, { name: "a" })).status, 400);
    await say(bots, parent.id, "hi");

    assert.equal((await post(`/api/bots/${parent.id}/fork`, {})).status, 400);
    assert.equal((await post(`/api/bots/${parent.id}/fork`, { name: "a", readOnly: "yes" })).status, 400);
    assert.equal((await post(`/api/bots/${parent.id}/fork`, { name: "a", entryId: "bogus" })).status, 400);

    const ok = await post(`/api/bots/${parent.id}/fork`, { name: "ro", readOnly: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.name, "ro");
    assert.equal(ok.json.parent.botId, parent.id);
    assert.ok(!(await toolNames(bots, ok.json.id)).includes("bash"));
    assert.equal((await post(`/api/bots/${parent.id}/fork`, { name: "ro" })).status, 409);

    // Fork at a specific entry, as the UI sends it: numeric id and numeric string both work.
    const entries = await (await bots.conversation(parent.id)).entries({}, 10, undefined, ctx);
    const at = entries.items.at(-1).id;
    const byNum = await post(`/api/bots/${parent.id}/fork`, { name: "at-num", entryId: at });
    assert.equal(byNum.status, 200, JSON.stringify(byNum.json));
    assert.equal(byNum.json.parent.entryId, at);
    const byStr = await post(`/api/bots/${parent.id}/fork`, { name: "at-str", entryId: String(at) });
    assert.equal(byStr.status, 200, JSON.stringify(byStr.json));
    assert.equal((await post(`/api/bots/${parent.id}/fork`, { name: "a", entryId: -3 })).status, 400);
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});
