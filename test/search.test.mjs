import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebSearchTool, Search } from "../src/ext/search.mjs";

const KEY = "exa-secret-key-123";

function jsonRes(status, obj) {
  return new Response(typeof obj === "string" ? obj : JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recorder(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init);
  };
  return { fetch, calls };
}

const run = (tool, args) => tool.execute(args, {}, {});

test("Search extension exposes web_search", () => {
  assert.equal(Search.name, "tarsbot.search");
  const tool = Search.tools[0];
  assert.equal(tool.name, "web_search");
  assert.equal(tool.replay, "safe");
});

test("success: request shape, text and details", async () => {
  const long = "x".repeat(2000);
  const { fetch, calls } = recorder(() =>
    jsonRes(200, {
      results: [
        { title: "Node.js", url: "https://nodejs.org", publishedDate: "2025-01-01T00:00:00Z", text: long },
        { title: "Other", url: "https://example.com", text: "short text" },
      ],
    }),
  );
  const tool = createWebSearchTool({ fetch, apiKey: KEY });
  const out = await run(tool, { query: "node lts" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.exa.ai/search");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-api-key"], KEY);
  assert.deepEqual(calls[0].body, {
    query: "node lts",
    numResults: 5,
    type: "auto",
    contents: { text: { maxCharacters: 1500 } },
  });

  const text = out.output[0].text;
  assert.match(text, /^1\. Node\.js\n {3}https:\/\/nodejs\.org\n {3}Published: 2025-01-01/);
  assert.match(text, /2\. Other\n {3}https:\/\/example\.com\n {3}short text/);
  assert.ok(text.length < 1200, "excerpts are truncated");
  assert.ok(!text.includes(KEY));
  assert.deepEqual(out.details, [
    { title: "Node.js", url: "https://nodejs.org", publishedDate: "2025-01-01T00:00:00Z" },
    { title: "Other", url: "https://example.com", publishedDate: null },
  ]);
  assert.ok(!JSON.stringify(out.details).includes("xxxx"));
});

test("includeText=false omits contents and excerpts", async () => {
  const { fetch, calls } = recorder(() => jsonRes(200, { results: [{ title: "A", url: "https://a.io", text: "body" }] }));
  const out = await run(createWebSearchTool({ fetch, apiKey: KEY }), { query: "q", includeText: false });
  assert.equal("contents" in calls[0].body, false);
  assert.ok(!out.output[0].text.includes("body"));
});

test("empty results", async () => {
  const { fetch } = recorder(() => jsonRes(200, { results: [] }));
  const out = await run(createWebSearchTool({ fetch, apiKey: KEY }), { query: "nothing" });
  assert.match(out.output[0].text, /No results/);
  assert.deepEqual(out.details, []);
});

test("numResults boundaries are clamped to 1..10", async () => {
  const { fetch, calls } = recorder(() => jsonRes(200, { results: [] }));
  const tool = createWebSearchTool({ fetch, apiKey: KEY });
  for (const n of [0, -3, 1, 10, 11, 999]) await run(tool, { query: "q", numResults: n });
  assert.deepEqual(
    calls.map((c) => c.body.numResults),
    [1, 1, 1, 10, 10, 10],
  );
});

test("numResults schema rejects out-of-range values", () => {
  const schema = createWebSearchTool({ apiKey: KEY }).parameters;
  const p = schema.properties.numResults;
  const inner = p.anyOf ? p.anyOf[0] : p;
  assert.equal(inner.minimum, 1);
  assert.equal(inner.maximum, 10);
});

test("401 -> error with status and short body, no key", async () => {
  const { fetch } = recorder(() => jsonRes(401, { error: `invalid api key ${KEY} ${"z".repeat(1000)}` }));
  const tool = createWebSearchTool({ fetch, apiKey: KEY });
  await assert.rejects(run(tool, { query: "q" }), (e) => {
    assert.match(e.message, /401/);
    assert.ok(!e.message.includes(KEY));
    assert.ok(e.message.length < 400);
    return true;
  });
});

test("timeout -> 'web_search timed out'", async () => {
  // AbortSignal.timeout timers are unref'd; a real fetch keeps the loop alive, so emulate that.
  const keepAlive = setInterval(() => {}, 1000);
  const fetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  try {
    const tool = createWebSearchTool({ fetch, apiKey: KEY, timeoutMs: 30 });
    await assert.rejects(run(tool, { query: "q" }), { message: "web_search timed out" });
  } finally {
    clearInterval(keepAlive);
  }
});

test("missing key -> EXA_API_KEY is not set (and fetch is not called)", async () => {
  const saved = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  try {
    const { fetch, calls } = recorder(() => jsonRes(200, { results: [] }));
    const tool = createWebSearchTool({ fetch });
    await assert.rejects(run(tool, { query: "q" }), { message: "EXA_API_KEY is not set" });
    assert.equal(calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.EXA_API_KEY = saved;
  }
});

test("network error message never leaks the key", async () => {
  const fetch = async () => {
    throw new Error(`connect failed for ${KEY}`);
  };
  await assert.rejects(run(createWebSearchTool({ fetch, apiKey: KEY }), { query: "q" }), (e) => {
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});
