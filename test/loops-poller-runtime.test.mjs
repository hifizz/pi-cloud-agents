// REAL-runtime repro for the gh-poller SessionFailed: a real SQLite-backed Harness runs the durable
// loops.github.poll task; before the fix the task committed `{phase,nextAt}` — not a valid NextTaskState —
// crashing the carrier session on the first poll. After the fix the task sleeps inside one commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openHarness } from "../src/harness.mjs";
import { productionExtensions } from "../src/runtime.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { createLoops } from "../src/loops/index.mjs";
import { LoopGhPollDoc } from "../src/loops/github-poller.mjs";

const { ctx } = await import("../src/harness.mjs");
const WS_MODEL = { provider: "faux", modelId: "faux-1" };

test("github poller task commits a valid sleeping transition — the carrier session does not fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loops-poll-"));
  const storage = await openNodeSqliteStorage(join(dir, "t.sqlite"));
  const extensions = await productionExtensions();
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const { harness } = await openHarness({ storage, extensions, models });

  const store = openControlStore({ path: join(dir, "control.sqlite") });
  const project = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "ws-1", projectId: project.id, name: "w", baseBranch: "main", branch: "b",
    cwd: "/home/sprite/w", model: WS_MODEL,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  const bots = { get: () => undefined, update: () => {}, list: () => [] };
  const github = { listEvents: async () => [], listPulls: async () => [], getCheckRuns: async () => null };
  const loops = createLoops({
    store, bots, github, runtimeBash: async () => async () => ({ exitCode: 0 }),
    harness, githubPollSec: 30, publicUrl: "http://x",
  });
  await loops.store.create(workspace.id, { name: "g", instructions: "i", trigger: { kind: "github_issue", events: ["opened"] } });
  await loops.restore(); // starts the durable poll task on the carrier conversation

  // Let the first poll phase run (firstAt = now -> fires immediately on resume).
  await new Promise((r) => setTimeout(r, 400));

  const convId = store.meta.get("loops.ghpoll.carrierConversationId");
  assert.ok(convId, "a carrier conversation was created");
  const conv = await harness.conversation(convId, ctx);
  assert.ok(conv, "carrier conversation is live — not SessionFailed");
  const doc = await harness.snapshot(LoopGhPollDoc, ctx);
  const rec = doc?.tasks?.[workspace.id];
  assert.ok(rec, "poll task registered for the workspace");
  assert.ok(rec.nextAt > 0, "the task committed a valid nextAt (sleeping transition stored)");
  try { await harness.close(ctx); } catch { /* close in a bare harness needs no signal */ }
});
