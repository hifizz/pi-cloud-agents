import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { config } from "../src/config.mjs";
import { Preamble, PREAMBLE, PREAMBLE_CUA, PREAMBLE_SPRITES, createPreamble, preambleFor } from "../src/ext/preamble.mjs";

/** The cua text exactly as it was before sprites mode existed. */
const ORIGINAL_CUA = `You are a TARSBot: a persistent AI teammate with your own Linux computer (an XFCE desktop container shared with the user's other bots).
- Be concise. Report what you did and what you found.
- Shell and file tools run inside your computer, not on the user's host.
- For desktop work, prefer accessibility-tree element tokens over pixel coordinates; take a screenshot to verify results.
- Never claim success without checking.`;

const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""));

test("cua text is verbatim the original preamble", () => {
  assert.equal(PREAMBLE_CUA, ORIGINAL_CUA);
  assert.equal(PREAMBLE, ORIGINAL_CUA);
});

test("preambleFor picks the text for each sandbox", () => {
  assert.equal(preambleFor("cua"), PREAMBLE_CUA);
  assert.equal(preambleFor("sprites"), PREAMBLE_SPRITES);
  assert.notEqual(PREAMBLE_CUA, PREAMBLE_SPRITES);
});

test("sprites text: workflow, recovery checks and safety rules", () => {
  const t = PREAMBLE_SPRITES;
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

test("cua text keeps its desktop description", () => {
  assert.match(PREAMBLE_CUA, /XFCE desktop/);
  assert.doesNotMatch(PREAMBLE_CUA, /GH_TOKEN|gh pr/);
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

for (const sandbox of ["sprites", "cua"]) {
  test(`harness system prompt carries the ${sandbox} preamble`, async () => {
    const { models, seen, model } = fauxSystemCapture();
    const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [createPreamble(() => sandbox)] });
    try {
      const bots = new BotRegistry(harness, { path: null });
      const bot = await bots.createBot({ name: `p-${sandbox}`, model });
      const conv = await bots.conversation(bot.id);
      const settled = await (await conv.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      assert.equal(settled.status, "done");
      assert.equal(seen.length, 1);
      const other = sandbox === "sprites" ? PREAMBLE_CUA : PREAMBLE_SPRITES;
      assert.ok(seen[0].includes(preambleFor(sandbox)), "system prompt contains the preamble text");
      assert.ok(!seen[0].includes(other), "and not the other mode's text");
    } finally {
      await harness.close(ctx);
    }
  });
}

test("default Preamble uses config.sandbox in the harness", async () => {
  const { models, seen, model } = fauxSystemCapture();
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Preamble] });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const bot = await bots.createBot({ name: "p-default", model });
    const conv = await bots.conversation(bot.id);
    await (await conv.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    assert.ok(seen[0].includes(preambleFor(config.sandbox)));
  } finally {
    await harness.close(ctx);
  }
});
