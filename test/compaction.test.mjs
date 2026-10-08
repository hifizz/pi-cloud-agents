import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CompactionEntry, MemoryStorage, ResetEntry } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { History, searchEntries, entryText } from "../src/ext/history.mjs";
import { createApi } from "../src/api.mjs";

const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""));
const lastUser = (t) => t.messages.findLast((m) => m.role === "user");

/** Faux model with a tiny window: answers chats with long text, writes summaries when asked to summarize. */
function tinyFaux(extra = []) {
  const f = fauxProvider({ models: [{ id: "tiny", contextWindow: 3000, maxTokens: 1000 }] });
  const queue = [...extra];
  const respond = async (transcript) => {
    const first = transcript.messages[0];
    if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization")) {
      return fauxAssistantMessage("## Goal\nPlan a week in Lisbon.");
    }
    const next = queue.shift();
    if (next) return typeof next === "function" ? next(transcript) : next;
    return fauxAssistantMessage(`Answer to "${textOf(lastUser(transcript) ?? { content: "" })}": ${"details ".repeat(200)}`);
  };
  f.setResponses(Array.from({ length: 100 }, () => respond));
  const models = createModels();
  models.setProvider(f.provider);
  return models;
}

const MODEL = { provider: "faux", modelId: "tiny" };
// Automatic compaction off-thresholds: only manual compaction fires in these tests.
const settings = { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 400, backgroundTokens: 0 } };

async function setup(extra) {
  const models = tinyFaux(extra);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [History], settings });
  const bots = new BotRegistry(harness, { path: null });
  return { harness, bots };
}

async function ask(conv, text) {
  const settled = await (await conv.submit({ type: "input", content: text }, ctx)).wait(ctx);
  await conv.waitForIdle(ctx);
  return settled;
}

const allEntries = async (conv) => (await conv.entries({}, 1000, undefined, ctx)).items;

test("TEST-F09-1: manual compact() writes a pi.compaction entry and the chat continues", async () => {
  const { harness, bots } = await setup();
  try {
    const bot = await bots.createBot({ name: "long", model: MODEL });
    const conv = await bots.conversation(bot.id);
    for (const q of ["Where should we stay?", "What should we eat?", "Which day trips?", "Any museums?"]) {
      assert.equal((await ask(conv, q)).status, "done");
    }
    const before = (await conv.context(ctx)).messages.length;

    const taskId = await conv.compact("Keep the hotel shortlist", ctx);
    const { state } = await harness.waitForTask(taskId, ctx);
    assert.equal(state.outcome.status, "completed");
    await conv.waitForIdle(ctx);

    const entries = await allEntries(conv);
    const compaction = entries.find((e) => CompactionEntry.is(e));
    assert.ok(compaction, "pi.compaction entry exists");
    assert.equal(compaction.kind, "pi.compaction");
    assert.match(textOf(compaction.model[0]), /Lisbon/);

    const view = await conv.context(ctx);
    assert.ok(view.messages.length < before, `context shrank: ${view.messages.length} < ${before}`);
    assert.ok(CompactionEntry.is(view.head), "context starts at the compaction summary");

    // The conversation keeps working after compaction.
    assert.equal((await ask(conv, "Nightlife?")).status, "done");
    const texts = (await conv.context(ctx)).messages.map(textOf).join("\n");
    assert.match(texts, /Nightlife\?/);
    assert.match(texts, /Answer to "Nightlife\?"/);
  } finally {
    await harness.close(ctx);
  }
});

test("TEST-F09-2: search_history finds content from before a reset", async () => {
  const { harness, bots } = await setup([
    fauxAssistantMessage([fauxText("The launch codename is Bluebird-77.")]),
    fauxAssistantMessage([fauxText("Noted.")]),
    // after the reset: look the codename up in the full history
    fauxAssistantMessage([fauxToolCall("search_history", { query: "BLUEBIRD" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Found it.")]),
    // a query that matches nothing
    fauxAssistantMessage([fauxToolCall("search_history", { query: "zzz-not-there" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Nothing.")]),
  ]);
  try {
    const bot = await bots.createBot({ name: "mem", model: MODEL });
    const conv = await bots.conversation(bot.id);
    await ask(conv, "What is the launch codename?");
    await ask(conv, "Remember that.");

    await conv.reset("handoff note", ctx);
    await conv.waitForIdle(ctx);
    const entries = await allEntries(conv);
    assert.ok(entries.some((e) => ResetEntry.is(e)), "pi.reset entry exists");

    // The active context no longer contains the old content ...
    const active = (await conv.context(ctx)).messages.map(textOf).join("\n");
    assert.doesNotMatch(active, /Bluebird/);
    assert.match(active, /handoff note/);

    // ... but the model can still find it with search_history.
    await ask(conv, "What was the codename?");
    const after = await allEntries(conv);
    const hit = after.find((e) => e.model?.[0]?.role === "toolResult" && e.model[0].toolName === "search_history");
    assert.ok(hit, "search_history produced a tool result");
    const hitText = textOf(hit.model[0]);
    assert.notEqual(hit.model[0].isError, true, hitText);
    assert.match(hitText, /Bluebird-77/);
    assert.match(hitText, /assistant/);

    await ask(conv, "Search for something absent");
    const results = (await allEntries(conv)).filter((e) => e.model?.[0]?.role === "toolResult" && e.model[0].toolName === "search_history");
    assert.equal(results.length, 2);
    // newest first; the search must not match its own call or the earlier search result
    assert.match(textOf(results[0].model[0]), /^No matches for "zzz-not-there" in \d+ history entries/);
  } finally {
    await harness.close(ctx);
  }
});

test("search_history also reaches entries before a compaction", async () => {
  const { harness, bots } = await setup();
  try {
    const bot = await bots.createBot({ name: "cmp", model: MODEL });
    const conv = await bots.conversation(bot.id);
    for (const q of ["alpha-token one", "beta two", "gamma three", "delta four"]) await ask(conv, q);
    const { state } = await harness.waitForTask(await conv.compact(undefined, ctx), ctx);
    assert.equal(state.outcome.status, "completed");
    await conv.waitForIdle(ctx);

    const active = (await conv.context(ctx)).messages.map(textOf).join("\n");
    assert.doesNotMatch(active, /alpha-token/);
    const res = await searchEntries((limit, cursor) => conv.entries({}, limit, cursor, ctx), "ALPHA-TOKEN");
    assert.ok(res.matches.length >= 1);
    assert.ok(res.matches.some((m) => m.role === "user"));
  } finally {
    await harness.close(ctx);
  }
});

test("searchEntries: case-insensitive, limit, paging", async () => {
  const entries = Array.from({ length: 450 }, (_, i) => ({
    id: `e${i}`,
    kind: "pi.user",
    model: [{ role: "user", content: i % 3 === 0 ? `Needle number ${i}` : `hay ${i}` }],
  }));
  const scan = async (limit, cursor) => {
    const start = cursor?.at ?? 0;
    const items = entries.slice(start, start + limit);
    return { items, ...(start + limit < entries.length ? { next: { at: start + limit } } : {}) };
  };
  const all = await searchEntries(scan, "nEeDlE", 50);
  assert.equal(all.matches.length, 50);
  assert.equal(all.truncated, true);
  const few = await searchEntries(scan, "needle number 447", 5);
  assert.equal(few.matches.length, 1);
  assert.equal(few.matches[0].entryId, "e447");
  assert.match(few.matches[0].snippet, /Needle number 447/);
  assert.equal(few.scanned, 450);
  assert.deepEqual((await searchEntries(scan, "absent")).matches, []);
  assert.equal(entryText({ model: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } }] }] }), 'bash({"cmd":"ls"})');
});

test("POST /api/bots/:id/compact and /reset are served by the API", async () => {
  const { harness, bots } = await setup();
  const api = createApi({ harness, bots });
  const { port } = await api.listen(0);
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    const bot = await bots.createBot({ name: "api", model: MODEL });
    const conv = await bots.conversation(bot.id);
    for (const q of ["one", "two", "three", "four"]) await ask(conv, q);

    const c = await post(`/api/bots/${bot.id}/compact`, { instructions: "short" });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.ok(c.json.taskId);
    await harness.waitForTask(c.json.taskId, ctx);
    await conv.waitForIdle(ctx);
    assert.ok((await allEntries(conv)).some((e) => CompactionEntry.is(e)));

    const r = await post(`/api/bots/${bot.id}/reset`, { note: "fresh start" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await conv.waitForIdle(ctx);
    assert.ok((await allEntries(conv)).some((e) => ResetEntry.is(e)));
    assert.equal((await post(`/api/bots/nope/compact`)).status, 404);
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});
