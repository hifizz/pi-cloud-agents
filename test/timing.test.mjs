// Offline tests for tool timing: faux model + real CodingTools bash on a temp directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { ApprovalCenter, createApproval } from "../src/ext/approval.mjs";
import { TIMING_KEY, createTiming, withDuration } from "../src/ext/timing.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };

async function run({ command, approve }) {
  const dir = mkdtempSync(join(tmpdir(), "tars-timing-"));
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "c1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const center = new ApprovalCenter();
  const { harness } = await openHarness({
    storage: new MemoryStorage(),
    models,
    extensions: [CodingTools, createApproval({ center }), createTiming()],
    env: (t) => new NodeExecutionEnv({ cwd: t.cwd ?? dir }),
  });
  try {
    const bots = new BotRegistry(harness, { path: null });
    const bot = await bots.createBot({ name: "t", model: FAUX, cwd: dir });
    const conv = await bots.conversation(bot.id);
    await conv.submit({ type: "input", content: "go" }, ctx);
    if (approve) {
      for (let i = 0; i < 500 && center.list().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, approve.waitMs));
      center.resolve(center.list()[0].taskId, true);
    }
    for (let i = 0; i < 1000; i++) {
      const page = await conv.entries({}, 50, undefined, ctx);
      const result = page.items.find((e) => ToolResultEntry.is(e));
      if (result) return result.model[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no tool result");
  } finally {
    await harness.close(ctx);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("withDuration merges into object details and leaves other shapes alone", () => {
  assert.deepEqual(withDuration(undefined, 5), { [TIMING_KEY]: { durationMs: 5 } });
  assert.deepEqual(withDuration({ a: 1 }, 5), { a: 1, [TIMING_KEY]: { durationMs: 5 } });
  assert.equal(withDuration("x", 5), "x");
  const arr = [1];
  assert.equal(withDuration(arr, 5), arr);
});

test("bash result carries its execution time", async () => {
  const msg = await run({ command: "sleep 0.3; echo hi" });
  const ms = msg.details?.[TIMING_KEY]?.durationMs;
  assert.equal(typeof ms, "number");
  assert.ok(ms >= 250 && ms < 5000, `durationMs=${ms}`);
  assert.match(msg.content.map((c) => c.text ?? "").join(""), /hi/);
});

test("time waiting for approval is not counted", async () => {
  const msg = await run({ command: "rm -rf ./nothing-here; echo ok", approve: { waitMs: 700 } });
  const ms = msg.details?.[TIMING_KEY]?.durationMs;
  assert.equal(typeof ms, "number");
  assert.ok(ms < 600, `durationMs=${ms} should exclude the 700 ms approval wait`);
});
