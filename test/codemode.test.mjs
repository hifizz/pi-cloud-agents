// Offline tests for code mode (pi-durable's `codemode` tool): script-orchestrated tool calls (issue #9).
// Faux model + real CodemodeSandbox (QuickJS in a worker) + real CodingTools on a temp directory — no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, hook, MemoryStorage, ToolResultEntry, ToolTask } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { ApprovalCenter, createApproval } from "../src/ext/approval.mjs";
import { Codemode, createCodemode } from "../src/ext/codemode.mjs";
import { productionExtensions } from "../src/runtime.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };
const toolCall = (name, args, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const codemodeCall = (code, id = "c1") => toolCall("codemode", { code }, id);

function fauxModels(responses) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  return models;
}

const nodeEnv = (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() });

async function waitFor(fn, what, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "tars-cm-"));
}

/** All tool-result entries of the conversation: {toolName, text, details, isError}. */
async function toolResults(conv) {
  const page = await conv.entries({}, 50, undefined, ctx);
  return page.items
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => ({
      toolName: e.model[0].toolName,
      isError: e.model[0].isError === true,
      text: e.model[0].content.map((c) => (c.type === "text" ? c.text : "")).join(""),
      details: e.model[0].details,
    }));
}

async function setup({ responses, storage = new MemoryStorage(), center = new ApprovalCenter(), extra = [], codemode = createCodemode(), dir }) {
  const { harness } = await openHarness({
    storage,
    models: fauxModels(responses),
    extensions: [CodingTools, codemode, createApproval({ center }), ...extra],
    env: nodeEnv,
  });
  const bots = new BotRegistry(harness, { path: null });
  const bot = await bots.createBot({ name: "cm", model: FAUX, cwd: dir });
  const conv = await bots.conversation(bot.id);
  return { harness, bots, bot, conv, center };
}

// ---- extension wiring -------------------------------------------------------------------------------------

test("productionExtensions: codemode on by default, off via TARSBOT_CODEMODE", async () => {
  const saved = process.env.TARSBOT_CODEMODE;
  try {
    delete process.env.TARSBOT_CODEMODE;
    assert.deepEqual((await productionExtensions()).map((e) => e.name), [
      "tarsbot.preamble",
      "coding-tools",
      "tarsbot.exec",
      "tarsbot.search",
      "tarsbot.history",
      "tarsbot.routines",
      "codemode",
      "tarsbot.approval",
      "tarsbot.timing",
    ]);
    for (const off of ["0", "false", "off", "no"]) {
      process.env.TARSBOT_CODEMODE = off;
      const names = (await productionExtensions()).map((e) => e.name);
      assert.ok(!names.includes("codemode"), `TARSBOT_CODEMODE=${off} disables codemode`);
      assert.deepEqual(names.slice(-2), ["tarsbot.approval", "tarsbot.timing"], "Approval still last before Timing");
    }
    process.env.TARSBOT_CODEMODE = "1";
    assert.ok((await productionExtensions()).some((e) => e.name === "codemode"));
  } finally {
    if (saved === undefined) delete process.env.TARSBOT_CODEMODE;
    else process.env.TARSBOT_CODEMODE = saved;
  }
});

test("codemode tool and prompt section are in the resolved agent", async () => {
  const dir = tmp();
  try {
    const { harness, conv } = await setup({ dir, responses: [] });
    const agent = await conv.agent(ctx);
    assert.ok(agent.tools.some((t) => t.name === "codemode"), "codemode tool offered to the model");
    assert.ok(agent.sections.some((s) => s.key === "codemode"), "codemode prompt section present");
    // The section lists callable tools as declarations; our bash must be among them.
    const section = agent.sections.find((s) => s.key === "codemode");
    const text = await section.render({ agent }, ctx);
    assert.match(text, /bash/);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default Codemode extension shape", () => {
  assert.equal(Codemode.name, "codemode");
});

// ---- scripts call tools ------------------------------------------------------------------------------------

test("script calls bash and read; result holds script output and details.calls", async () => {
  const dir = tmp();
  try {
    const code = [
      `const run = await tools.bash({ command: "printf cm-e2e > marker.txt" });`,
      `if (run.exitCode !== 0) throw new Error("bash failed: " + run.output);`,
      `const seen = await tools.read({ path: "marker.txt" });`,
      `text("READ=" + JSON.stringify(seen).slice(0, 200));`,
      `return "script-done";`,
    ].join("\n");
    const { harness, conv } = await setup({
      dir,
      responses: [codemodeCall(code), fauxAssistantMessage([fauxText("finished")])],
    });
    const settled = await (await conv.submit({ type: "input", content: "run the script" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    const [result] = await toolResults(conv);
    assert.equal(result.toolName, "codemode");
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Script completed/);
    assert.match(result.text, /script-done/);
    assert.match(result.text, /cm-e2e/, "the read() result reached the script's output");
    assert.equal(readFileSync(join(dir, "marker.txt"), "utf8"), "cm-e2e");
    const calls = result.details?.calls ?? [];
    assert.deepEqual(calls.map((c) => c.name), ["bash", "read"]);
    assert.ok(calls.every((c) => c.status === "ok"));
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- approval inside a script -----------------------------------------------------------------------------

test("dangerous bash inside a script parks for approval (with parent), approve runs it", async () => {
  const dir = tmp();
  const victim = join(dir, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "f"), "data");
  try {
    const code = `const r = await tools.bash({ command: "rm -rf ${victim}" });\nreturn "cleaned:" + r.exitCode;`;
    const { harness, conv, center } = await setup({
      dir,
      responses: [codemodeCall(code), fauxAssistantMessage([fauxText("ok")])],
    });
    const sub = await conv.submit({ type: "input", content: "clean" }, ctx);
    const [item] = await waitFor(() => (center.list().length ? center.list() : undefined), "pending approval");
    assert.equal(item.toolName, "bash");
    assert.match(item.args.command, /rm -rf/);
    assert.ok(item.parent, "the approval shows the call came from inside another tool call");
    assert.equal(item.parent.callId, "c1", "the codemode tool call is the parent");
    assert.ok(item.parent.taskId);
    assert.ok(existsSync(victim), "not executed while pending");
    center.resolve(item.taskId, true);
    const settled = await sub.wait(ctx);
    assert.equal(settled.status, "done");
    assert.equal(existsSync(victim), false, "ran after approval");
    const [result] = await toolResults(conv);
    assert.match(result.text, /cleaned:0/);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denied bash inside a script rejects in the script", async () => {
  const dir = tmp();
  const victim = join(dir, "victim");
  mkdirSync(victim);
  try {
    const code = [
      `try { await tools.bash({ command: "rm -rf ${victim}" }); return "unexpected"; }`,
      `catch (e) { return "caught:" + e.message; }`,
    ].join("\n");
    const { harness, conv, center } = await setup({
      dir,
      responses: [codemodeCall(code), fauxAssistantMessage([fauxText("ok")])],
    });
    const sub = await conv.submit({ type: "input", content: "clean" }, ctx);
    const [item] = await waitFor(() => (center.list().length ? center.list() : undefined), "pending approval");
    center.resolve(item.taskId, false);
    const settled = await sub.wait(ctx);
    assert.equal(settled.status, "done");
    assert.ok(existsSync(victim), "denied command did not run");
    const [result] = await toolResults(conv);
    assert.match(result.text, /caught:.*denied/i);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- timeout x approval interaction ------------------------------------------------------------------------
//
// A script's `timeout_ms` is wall clock on the host, armed when the VM starts — it counts the approval wait too.
// When it fires while a nested call is parked: the codemode call ends with a timeout error, the nested call is
// aborted, its pending approval leaves the list, and nothing is memoized (a later rerun would ask again).

test("script timeout_ms fires during an approval wait: script fails, approval item is removed", async () => {
  const dir = tmp();
  const victim = join(dir, "victim");
  mkdirSync(victim);
  try {
    const code = `// @options: {"timeout_ms": 1500}\nawait tools.bash({ command: "rm -rf ${victim}" });\nreturn "unreached";`;
    const { harness, conv, center } = await setup({
      dir,
      responses: [codemodeCall(code), fauxAssistantMessage([fauxText("ok")])],
    });
    const sub = await conv.submit({ type: "input", content: "clean" }, ctx);
    const [item] = await waitFor(() => (center.list().length ? center.list() : undefined), "pending approval");
    // No verdict: the script's deadline fires while the approval is still pending.
    await waitFor(() => center.list().length === 0, "pending item removed when the script timed out");
    const settled = await sub.wait(ctx);
    assert.equal(settled.status, "done");
    assert.ok(existsSync(victim), "the command never ran");
    assert.equal(center.resolve(item.taskId, true), false, "no stale pending item left to resolve");
    const [result] = await toolResults(conv);
    assert.equal(result.isError, true);
    assert.match(result.text, /timed out/i);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- restart resume -----------------------------------------------------------------------------------------

test("restart mid-script: finished nested calls are not re-run, the script continues", async () => {
  const dir = tmp();
  const db = join(dir, "t.sqlite");
  const steps = join(dir, "steps.txt");
  try {
    // Replay-safe test tool: appends `text` to `path`. If a finished nested call ever re-ran, the file would show it.
    const Append = defineExtension({
      name: "test.append",
      tools: [
        defineTool({
          name: "append",
          description: "Append text to a file",
          parameters: Type.Object({ path: Type.String(), text: Type.String() }),
          replay: "safe",
          async execute(args) {
            appendFileSync(args.path, args.text);
            return { output: [{ type: "text", text: "ok" }] };
          },
        }),
      ],
    });
    // Blocks the "two" append's beforeTool until the harness is closed — the deterministic mid-script crash point.
    let gateReached;
    const reached = new Promise((r) => (gateReached = r));
    const Gate = defineExtension({
      name: "test.gate",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, _api, context) => {
            if (call.name !== "append" || call.arguments?.text !== "two\n") return undefined;
            gateReached();
            await new Promise((_resolve, reject) => {
              const signal = context.abortSignal;
              if (signal?.aborted) return reject(signal.reason);
              signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
            });
            return undefined;
          },
        }),
      ],
    });
    const code = [
      `await tools.append({ path: ${JSON.stringify(steps)}, text: "one\\n" });`,
      `await tools.append({ path: ${JSON.stringify(steps)}, text: "two\\n" });`,
      `return "done";`,
    ].join("\n");

    // Life 1: call 1 runs, call 2 is admitted but blocked in beforeTool when the process "crashes".
    const life1 = await setup({
      dir,
      storage: await openNodeSqliteStorage(db),
      extra: [Append, Gate],
      responses: [codemodeCall(code)],
    });
    await life1.conv.submit({ type: "input", content: "go" }, ctx);
    await reached;
    await waitFor(() => existsSync(steps) && readFileSync(steps, "utf8") === "one\n", "first nested call ran");
    await life1.harness.close(ctx);
    assert.equal(readFileSync(steps, "utf8"), "one\n", "call 2 never ran");

    // Life 2: same database. The codemode call reruns, replays the journal (call 1 reattaches — no second append),
    // then admits call 2, whose replay-safe task now runs.
    const { harness } = await openHarness({
      storage: await openNodeSqliteStorage(db),
      models: fauxModels([fauxAssistantMessage([fauxText("all done")])]),
      extensions: [CodingTools, Append, createCodemode(), createApproval({ center: new ApprovalCenter() })],
      env: nodeEnv,
    });
    const conv = await harness.conversation(life1.bot.conversationId, ctx);
    await waitFor(() => existsSync(steps) && readFileSync(steps, "utf8").includes("two"), "script resumed past call 2", 30_000);
    assert.equal(readFileSync(steps, "utf8"), "one\ntwo\n", "call 1 did not re-run, call 2 ran once");
    await harness.waitForIdle(ctx);
    const results = await toolResults(conv);
    const cm = results.find((r) => r.toolName === "codemode");
    assert.equal(cm.isError, false, cm.text);
    assert.match(cm.text, /done/);
    assert.deepEqual(cm.details?.calls?.map((c) => c.name), ["append", "append"]);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
