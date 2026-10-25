// Offline tests: webhook wake-ups (8) — registry, idempotent delivery, GitHub summaries, signature check,
// route-level behavior incl. the auth-guard exemption for the tokened delivery path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { HooksDoc, contentHash, deliverHook, ensureHookToken, listHooks, summarizeGithubEvent, verifyGithubSignature } from "../src/ext/hooks.mjs";
import { createApi } from "../src/api.mjs";
import { register as registerAuth } from "../src/routes/auth.mjs";
import { register as registerHooks } from "../src/routes/hooks.mjs";
import { Preamble } from "../src/ext/preamble.mjs";

function faux(responses) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  return { models, model: { provider: "faux", modelId: "faux-1" } };
}

async function setup(responses = [fauxAssistantMessage([fauxText("ack")])]) {
  const { models, model } = faux(responses);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble] });
  const bots = new BotRegistry(harness, { path: null });
  const bot = await bots.createBot({ name: "hooked", model });
  return { harness, bots, bot };
}

test("summarizeGithubEvent: push, PR, comment; ping is silent", () => {
  const push = summarizeGithubEvent("push", undefined, {
    repository: { full_name: "o/r" },
    ref: "refs/heads/main",
    pusher: { name: "qe" },
    commits: [{ id: "abcdef123456", message: "fix thing\n\nbody" }],
  });
  assert.match(push[0], /push to o\/r on refs\/heads\/main: 1 commit\(s\) by qe/);
  assert.match(push[1], /fix thing \(abcdef1\)/);

  const pr = summarizeGithubEvent("pull_request", "opened", { pull_request: { number: 7, title: "T", html_url: "u" } });
  assert.match(pr[0], /PR #7 opened: T/);

  const cmt = summarizeGithubEvent("issue_comment", "created", { comment: { user: { login: "alice" }, body: "please review" }, issue: { html_url: "http://x" } });
  assert.match(cmt[0], /comment by alice/);

  assert.equal(summarizeGithubEvent("ping", undefined, {}), null);
});

test("verifyGithubSignature: HMAC check", () => {
  const body = Buffer.from(JSON.stringify({ a: 1 }));
  const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(verifyGithubSignature(undefined, undefined, body), true); // no secret configured
  assert.equal(verifyGithubSignature("s3cret", sig, body), true);
  assert.equal(verifyGithubSignature("s3cret", "sha256=deadbeef", body), false);
  assert.equal(verifyGithubSignature("s3cret", undefined, body), false);
});

test("deliverHook: token gate, prompt-injection framing, idempotent delivery", async () => {
  const { harness, bot } = await setup();
  try {
    // Wrong token is refused before any submission.
    const bad = await deliverHook({ harness }, { conversationId: bot.conversationId, token: "wrong", source: "generic", rawBody: "x" });
    assert.equal(bad.delivered, false);
    assert.match(bad.reason, /token/);

    const token = await ensureHookToken(harness, bot.conversationId);
    assert.ok(typeof token === "string" && token.length >= 20);

    const payload = JSON.stringify({
      repository: { full_name: "o/r" },
      ref: "refs/heads/main",
      pusher: { name: "qe" },
      commits: [{ id: "abc", message: "do the thing" }],
    });
    const r1 = await deliverHook({ harness }, {
      conversationId: bot.conversationId,
      token,
      source: "github",
      event: "push",
      rawBody: payload,
      payload: JSON.parse(payload),
      requestId: "gh-1",
    });
    assert.equal(r1.delivered, true);

    // Same delivery id again: duplicate, no second submission.
    const r2 = await deliverHook({ harness }, {
      conversationId: bot.conversationId,
      token,
      source: "github",
      event: "push",
      rawBody: payload,
      payload: JSON.parse(payload),
      requestId: "gh-1",
    });
    assert.equal(r2.delivered, false);
    assert.match(r2.reason, /duplicate/);

    // The delivered prompt is framed as data, and the injection marker is present.
    const page = await (await harness.conversation(bot.conversationId, ctx)).entries({}, 10, undefined, ctx);
    const userInput = page.items.find((e) => (e.model ?? []).some((m) => m.role === "user"));
    const text = userInput.model.map((m) => (typeof m.content === "string" ? m.content : "")).join("");
    assert.match(text, /DATA from an external system/);
    assert.match(text, /push to o\/r/);

    const hooks = await listHooks(harness);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].conversationId, bot.conversationId);
    assert.equal(hooks[0].deliveries, 1);
  } finally {
    await harness.close(ctx);
  }
});

test("hooks route: token delivery works WITHOUT a session; management needs one", async () => {
  const { harness, bots, bot } = await setup();
  const api = createApi({ harness, bots, routes: [] });
  registerAuth(api.app, { env: { ...process.env, TARSBOT_AUTH_DISABLED: "", TARSBOT_ALLOWED_EMAILS: "a@b.c" }, store: { getSession: () => null, createSession: () => "t" } });
  registerHooks(api.app);
  const { port } = await api.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  try {
    const token = await ensureHookToken(harness, bot.conversationId);

    // Wrong token -> 404 (no enumeration).
    let res = await fetch(`${base}/api/hooks/${bot.id}/nope`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);

    // Right token, no session -> delivered.
    res = await fetch(`${base}/api/hooks/${bot.id}/${token}?source=generic`, { method: "POST", body: JSON.stringify({ hello: "wake up" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.submissionId !== undefined);

    // Duplicate request id -> 200 duplicate marker.
    res = await fetch(`${base}/api/hooks/${bot.id}/${token}?source=generic`, {
      method: "POST",
      headers: { "x-request-id": "req-42", "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/hooks/${bot.id}/${token}?source=generic`, {
      method: "POST",
      headers: { "x-request-id": "req-42", "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    assert.equal((await res.json()).duplicate, true);

    // Management routes still require a session.
    res = await fetch(`${base}/api/hooks`);
    assert.equal(res.status, 401);
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});

test("github signature enforced when TARSBOT_HOOK_SECRET set", async () => {
  const { harness, bots, bot } = await setup();
  const api = createApi({ harness, bots, routes: [] });
  registerAuth(api.app, { env: { ...process.env, TARSBOT_AUTH_DISABLED: "" }, store: { getSession: () => null, createSession: () => "t" } });
  registerHooks(api.app, { secretOf: () => "s3cret" });
  const { port } = await api.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  try {
    const token = await ensureHookToken(harness, bot.conversationId);
    const body = JSON.stringify({ zen: "Design for failure." });
    let res = await fetch(`${base}/api/hooks/${bot.id}/${token}`, {
      method: "POST",
      headers: { "x-github-event": "ping" },
      body,
    });
    assert.equal(res.status, 401); // no signature
    const sig = `sha256=${createHmac("sha256", "s3cret").update(Buffer.from(body)).digest("hex")}`;
    res = await fetch(`${base}/api/hooks/${bot.id}/${token}`, {
      method: "POST",
      headers: { "x-github-event": "ping", "x-hub-signature-256": sig },
      body,
    });
    assert.equal(res.status, 200);
  } finally {
    await api.close();
    await harness.close(ctx);
  }
});
