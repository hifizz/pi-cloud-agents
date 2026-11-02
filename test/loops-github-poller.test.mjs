// Phase 2 (Issue14): github poller — feed dedup vs cursor, checks supplement, cross-channel dedup with webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openControlStore } from "../src/control/store.mjs";
import { createLoopStore } from "../src/loops/store.mjs";
import { createGithubPoller } from "../src/loops/github-poller.mjs";
import { ingestGithubEvent } from "../src/loops/github-events.mjs";

const WS_MODEL = { provider: "faux", modelId: "faux-1" };

function env() {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "ws-1", projectId: project.id, name: "w", baseBranch: "main", branch: "b",
    cwd: "/home/sprite/w", model: WS_MODEL,
  });
  return { store, ws: workspace, ls: createLoopStore({ store }) };
}

test("poller: feed events ingest once (cursor + deliveries); a webhook-delivered event is skipped on poll", async () => {
  const { store, ws, ls } = env();
  await ls.create(ws.id, { name: "g", instructions: "i", trigger: { kind: "github_issue", events: ["opened"] } });
  const enqueued = [];
  const ingest = (wsId, ev) => ingestGithubEvent({ store, enqueue: async (id, key) => enqueued.push(key) ?? { created: true, run: { id: "r" } }, ev });

  // The same canonical event already arrived via webhook -> deliveries mark -> poll drops it.
  await ingest(ws.id, {
    kind: "issue", action: "opened", entity: { kind: "issue", number: 7 }, isPr: false,
    actor: "u", repo: ws.repo, deliveryId: "d1",
  });
  assert.equal(enqueued.length, 1);

  const github = {
    listEvents: async () => [
      // same issue.opened:7 event shows up in the feed later — dropped by canonical key dedup, not the cursor
      { id: "100", kind: "issue", action: "opened", number: 7, isPr: false, actor: "u", at: "t" },
      { id: "101", kind: "issue", action: "opened", number: 8, isPr: false, actor: "u", at: "t" },
    ],
    listPulls: async () => [],
    getCheckRuns: async () => null,
  };
  const poller = createGithubPoller({
    ingest, github, control: store, harness: {},
    ghLoopsByWorkspace: () => new Map([[ws.id, { ws, loops: store.loops.listEnabledGithub() }]]),
    now: () => 1_000,
  });
  const out = await poller.pollOnce(ws.id, ws.repo);
  assert.equal(enqueued.length, 2, "only the NEW event (#8) enqueues — #7 was already delivered via webhook");
  assert.equal(store.githubCursor.get(ws.id).lastEventId, "101", "cursor advanced to the newest feed id");

  // Second tick: no new events -> nothing enqueued even though the feed still lists the old ones.
  await poller.pollOnce(ws.id, ws.repo);
  assert.equal(enqueued.length, 2, "cursor skips already-seen feed entries");
});

test("poller checks supplement: a checks_failed loop gets check_suite events via the Checks API", async () => {
  const { store, ws, ls } = env();
  await ls.create(ws.id, { name: "g", instructions: "i", trigger: { kind: "github_pr", events: ["checks_failed"] } });
  const enqueued = [];
  const ingest = (wsId, ev) => ingestGithubEvent({ store, enqueue: async (id, key) => enqueued.push(key) ?? { created: true, run: { id: "r" } }, ev });
  const github = {
    listEvents: async () => [],
    listPulls: async () => [{ number: 3, headSha: "abc123def456", title: "pr3", url: "u" }],
    getCheckRuns: async (repo, sha) => ({ sha, state: "failure", runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }),
  };
  const poller = createGithubPoller({
    ingest, github, control: store, harness: {},
    ghLoopsByWorkspace: () => new Map([[ws.id, { ws, loops: store.loops.listEnabledGithub() }]]),
    now: () => 1_000,
  });
  await poller.pollOnce(ws.id, ws.repo);
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0], /^gh:hifizz\/tars-sandbox-playground:checksuite:/, "checks event enqueued through the same canonical repo-scoped path");
  // Same check state re-polled -> deduped (pollId key is stable per (pr, sha, state)).
  await poller.pollOnce(ws.id, ws.repo);
  assert.equal(enqueued.length, 1, "re-polling the same check state does not re-fire");
});
