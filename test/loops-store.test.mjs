// Loop store tests (Issue14 Phase1): CRUD, validation limits, version snapshots, secret handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openControlStore } from "../src/control/store.mjs";
import { createLoopStore, validateTrigger, validateCapabilities, LoopValidationError } from "../src/loops/store.mjs";

const WS_MODEL = { provider: "faux", modelId: "faux-1" };

function env() {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "ws-1",
    projectId: project.id,
    name: "loops ws",
    baseBranch: "main",
    branch: "tarsbot/ws",
    cwd: "/home/sprite/workspace/repo",
    model: WS_MODEL,
  });
  return { store, ws: workspace };
}

test("create + get + listByWorkspace; persisted across reopen (file db)", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "loops-store-"));
  const path = join(dir, "control.sqlite");
  try {
    let store = openControlStore({ path });
    let p = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
    let { workspace } = store.workspaces.create({ requestId: "w1", projectId: p.id, name: "w", baseBranch: "main", branch: "b", cwd: "/x", model: WS_MODEL });
    const ls = createLoopStore({ store });
    const { loop } = await ls.create(workspace.id, { name: "Nightly", instructions: "summarize", trigger: { kind: "manual" } });
    assert.equal(loop.version, 1);
    assert.equal(loop.enabled, true);
    store.close();

    store = openControlStore({ path });
    const again = store.loops.get(loop.id);
    assert.ok(again, "loop survives reopen");
    assert.equal(again.name, "Nightly");
    assert.equal(again.instructions, "summarize");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation: name >64, description >255, >8 conditions -> 400-class errors", async () => {
  const { store, ws } = env();
  const ls = createLoopStore({ store });
  await assert.rejects(ls.create(ws.id, { name: "x".repeat(65), instructions: "i", trigger: { kind: "manual" } }), LoopValidationError);
  await assert.rejects(ls.create(ws.id, { name: "n", description: "x".repeat(256), instructions: "i", trigger: { kind: "manual" } }), LoopValidationError);
  await assert.rejects(
    ls.create(ws.id, {
      name: "n",
      instructions: "i",
      trigger: { kind: "manual" },
      conditions: Array.from({ length: 9 }, (_, i) => ({ field: `f${i}` })),
    }),
    LoopValidationError,
  );
  await assert.rejects(ls.create(ws.id, { name: "n", instructions: " ", trigger: { kind: "manual" } }), LoopValidationError);
  await assert.rejects(ls.create(ws.id, { name: "n", instructions: "i", trigger: { kind: "bogus" } }), LoopValidationError);
  store.close();
});

test("PATCH bumps version and snapshots loop_versions; snapshot never carries the secret hash", async () => {
  const { store, ws } = env();
  const ls = createLoopStore({ store });
  const { loop, webhookSecret } = await ls.create(ws.id, { name: "Hooked", instructions: "i", trigger: { kind: "webhook" } });
  assert.ok(webhookSecret?.startsWith("whsec_"), "webhook trigger mints a secret once");
  assert.ok(store.loops.get(loop.id).webhookSecretHash, "stored as hash");

  const before = store.loopVersions.list(loop.id);
  assert.equal(before.length, 1);
  assert.equal(before[0].version, 1);
  assert.equal(before[0].snapshot.webhookSecretHash, undefined, "snapshot never carries the secret hash");

  const { loop: updated } = await ls.update(loop.id, { instructions: "new instructions" });
  assert.equal(updated.version, 2);
  const versions = store.loopVersions.list(loop.id);
  assert.equal(versions.length, 2);
  assert.equal(versions[1].version, 2);
  assert.equal(versions[1].snapshot.instructions, "new instructions");
  assert.equal(versions[1].snapshot.name, "Hooked", "snapshot carries the merged fields");

  // secret survives unrelated patches and is still never in a snapshot
  assert.ok(store.loops.get(loop.id).webhookSecretHash);
  assert.equal(versions[1].snapshot.webhookSecretHash, undefined);
  store.close();
});

test("rotate: new secret once, old hash replaced, version untouched", async () => {
  const { store, ws } = env();
  const ls = createLoopStore({ store });
  const { loop, webhookSecret: first } = await ls.create(ws.id, { name: "w", instructions: "i", trigger: { kind: "webhook" } });
  const oldHash = store.loops.get(loop.id).webhookSecretHash;
  const { webhookSecret: second } = await ls.rotateSecret(loop.id);
  assert.notEqual(second, first);
  assert.notEqual(store.loops.get(loop.id).webhookSecretHash, oldHash, "hash replaced");
  assert.equal(store.loops.get(loop.id).version, 1, "rotate is not a version bump");
  assert.equal(await ls.rotateSecret("nope"), undefined, "unknown loop -> undefined, no throw");
  const { loop: manual } = await ls.create(ws.id, { name: "m", instructions: "i", trigger: { kind: "manual" } });
  await assert.rejects(ls.rotateSecret(manual.id), LoopValidationError);
  store.close();
});

test("enable/disable + remove; a disabled loop reports enabled=false", async () => {
  const { store, ws } = env();
  const ls = createLoopStore({ store });
  const { loop } = await ls.create(ws.id, { name: "x", instructions: "i", trigger: { kind: "manual" } });
  assert.equal(ls.setEnabled(loop.id, false).enabled, false);
  assert.equal((await ls.update(loop.id, { description: "edit while disabled" })).loop.enabled, false);
  assert.equal(ls.setEnabled(loop.id, true).enabled, true);
  assert.equal(ls.remove(loop.id), true);
  assert.equal(ls.get(loop.id), undefined);
  assert.equal(ls.remove(loop.id), false);
  store.close();
});

test("validateTrigger: schedule fields", () => {
  const now = Date.UTC(2026, 9, 31, 12);
  assert.deepEqual(validateTrigger({ kind: "schedule", freq: "daily", at: "09:00", tz: "UTC", startAt: now + 1000 }, { now }), {
    kind: "schedule",
    freq: "daily",
    interval: 1,
    at: "09:00",
    tz: "UTC",
    startAt: now + 1000,
  });
  assert.throws(() => validateTrigger({ kind: "schedule", freq: "daily", tz: "UTC", startAt: now + 1000 }, { now }), /at.*required/);
  assert.throws(
    () => validateTrigger({ kind: "schedule", freq: "daily", at: "09:00", tz: "UTC", startAt: now - 1000 }, { now }),
    /past/,
  );
  assert.throws(() => validateTrigger({ kind: "schedule", freq: "weekly", at: "09:00", tz: "UTC", days: [9], startAt: now + 1000 }, { now }), /0\.\.6/);
  assert.throws(() => validateTrigger({ kind: "schedule", freq: "daily", at: "09:00", tz: "Not/AZone", startAt: now + 1000 }, { now }), /timezone/);
  assert.throws(() => validateTrigger({ kind: "schedule", freq: "hourly", interval: 0, tz: "UTC", startAt: now + 1000 }, { now }), /interval/);
});

test("validateCapabilities: defaults and explicit switches", () => {
  assert.deepEqual(validateCapabilities(undefined), {
    code: "read",
    web: false,
    scopeToTrigger: true,
    github: { comment: false, label: false, openIssue: false, openPr: false },
    tools: [],
  });
  assert.deepEqual(validateCapabilities({ code: "readwrite", web: true, github: { openPr: true } }), {
    code: "readwrite",
    web: true,
    scopeToTrigger: true,
    github: { comment: false, label: false, openIssue: false, openPr: true },
    tools: [],
  });
  assert.throws(() => validateCapabilities({ code: "admin" }), /code/);
});

test("PATCH keeps an unchanged (now-past) startAt; a changed past startAt is still rejected", async () => {
  let t = 1_000_000;
  const { store, ws } = env();
  const ls = createLoopStore({ store, now: () => t });
  const { loop } = await ls.create(ws.id, {
    name: "sched",
    instructions: "i",
    trigger: { kind: "schedule", freq: "daily", interval: 1, at: "09:00", tz: "UTC", startAt: 1_000_000 },
  });
  // Time moves on: the persisted startAt is now in the past.
  t = 5_000_000;
  // Editing another field without touching startAt must succeed (unchanged startAt is grandfathered).
  const out = await ls.update(loop.id, { instructions: "new instructions", trigger: { kind: "schedule", freq: "daily", interval: 1, at: "09:00", tz: "UTC", startAt: 1_000_000 } });
  assert.ok(out?.loop, "unchanged startAt survives the edit");
  assert.equal(out.loop.version, 2);
  // A *different* past startAt is still rejected.
  await assert.rejects(
    () => ls.update(loop.id, { trigger: { kind: "schedule", freq: "daily", interval: 1, at: "09:00", tz: "UTC", startAt: 2_000_000 } }),
    /past|startAt/,
  );
  // And a future startAt is still fine.
  const out2 = await ls.update(loop.id, { trigger: { kind: "schedule", freq: "daily", interval: 1, at: "09:00", tz: "UTC", startAt: 9_000_000 } });
  assert.ok(out2?.loop);
  store.close();
});
