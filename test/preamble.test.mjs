import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble, PREAMBLE, createPreamble, preambleFor } from "../src/ext/preamble.mjs";

const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""));

test("sprites text: workflow, recovery checks and safety rules", () => {
  const t = PREAMBLE;
  for (const needle of [
    "gh pr list --head",
    "--state open",
    "Opened by TARSBot",
    "~/workspace",
    "tarsbot/",
    "GH_TOKEN",
    "git status",
    "git log --oneline -5",
    "git branch --show-current",
    "git clone https://github.com/",
    "git push -u origin",
    "gh pr create --base",
    "Never use --force",
    "main, master or dev",
    "stop that operation",
  ]) {
    assert.ok(t.includes(needle), `missing: ${needle}`);
  }
  // GH_TOKEN may only appear in a prohibition / description, never with a value
  assert.match(t, /Never print GH_TOKEN/);
  assert.doesNotMatch(t, /GH_TOKEN\s*=/);
  assert.doesNotMatch(t, /\b(?:ghp_|gho_|github_pat_)\w*/);
  assert.doesNotMatch(t, /xfce|desktop/i);
  assert.doesNotMatch(t, /\b\d+\.\d+\.\d+\b/, "no pinned tool versions");
});

test("preamble describes the per-workspace Sprite and lets the workspace description win", () => {
  const t = preambleFor();
  assert.equal(t, PREAMBLE);
  assert.ok(t.includes('a Fly.io Sprite: Ubuntu, user "sprite", HOME /home/sprite'));
  assert.ok(t.includes("workspace description"));
  assert.ok(t.includes("result unconfirmed"));
  assert.doesNotMatch(t, /e2b/i);
});

function fauxSystemCapture() {
  const seen = [];
  const f = fauxProvider();
  f.setResponses([
    (transcript) => {
      // The system message carries the prompt as named sections (`sections.preamble`) next to its plain content.
      seen.push(
        transcript.messages
          .filter((m) => m.role === "system")
          .map((m) => `${textOf(m)}\n${Object.values(m.sections ?? {}).join("\n")}`)
          .join("\n"),
      );
      return fauxAssistantMessage([fauxText("ok")]);
    },
  ]);
  const models = createModels();
  models.setProvider(f.provider);
  return { models, seen, model: { provider: "faux", modelId: "faux-1" } };
}

test("harness system prompt carries the injected preamble text", async () => {
  const { models, seen, model } = fauxSystemCapture();
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [createPreamble("CUSTOM PREAMBLE TEXT")] });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const bot = await bots.createBot({ name: "p-custom", model });
    const conv = await bots.conversation(bot.id);
    const settled = await (await conv.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    assert.equal(seen.length, 1);
    assert.ok(seen[0].includes("CUSTOM PREAMBLE TEXT"));
    assert.ok(!seen[0].includes(PREAMBLE));
  } finally {
    await harness.close(ctx);
  }
});

test("default Preamble carries PREAMBLE in the harness", async () => {
  const { models, seen, model } = fauxSystemCapture();
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble] });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const bot = await bots.createBot({ name: "p-default", model });
    const conv = await bots.conversation(bot.id);
    await (await conv.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    assert.ok(seen[0].includes(PREAMBLE));
  } finally {
    await harness.close(ctx);
  }
});
