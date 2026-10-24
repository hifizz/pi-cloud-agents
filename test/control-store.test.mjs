import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openControlStore } from "../src/control/store.mjs";
import { MIGRATIONS } from "../src/control/db.mjs";

const MODEL = { provider: "tokenrouter", id: "swe-2" };

function seed(store, requestId = "req-1") {
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const { workspace, created } = store.workspaces.create({
    requestId,
    projectId: project.id,
    name: "w1",
    baseBranch: "main",
    branch: "tarsbot/w1-abc123",
    cwd: "/home/sprite/workspace/app",
    model: MODEL,
    task: "do it",
  });
  return { project, workspace, created };
}

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "pca-control-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("projects：upsert 幂等，get / getByRepo / list", () => {
  const s = openControlStore({ path: null });
  const a = s.projects.upsert({ repo: "acme/app", defaultBranch: "main", installCommand: "npm ci" });
  const b = s.projects.upsert({ repo: "acme/app", defaultBranch: "develop" });
  assert.equal(a.id, b.id);
  assert.equal(b.defaultBranch, "develop");
  assert.equal(b.installCommand, "npm ci", "未传的字段保持原值");
  const c = s.projects.upsert({ repo: "acme/app", defaultBranch: "develop", installCommand: null, testCommand: "npm test" });
  assert.equal(c.installCommand, null);
  assert.equal(c.testCommand, "npm test");
  assert.deepEqual(s.projects.get(a.id), c);
  assert.deepEqual(s.projects.getByRepo("acme/app"), c);
  assert.equal(s.projects.getByRepo("x/y"), undefined);
  s.projects.upsert({ repo: "acme/other", defaultBranch: "main" });
  assert.equal(s.projects.list().length, 2);
  s.close();
});

test("workspaces.create：同 requestId 返回原记录，不报唯一约束错", () => {
  const s = openControlStore({ path: null });
  const { project, workspace, created } = seed(s);
  assert.equal(created, true);
  assert.equal(workspace.status, "preparing");
  assert.equal(workspace.repo, "acme/app");
  assert.equal(workspace.baseCommit, null);
  assert.deepEqual(workspace.model, MODEL, "JSON 字段读出来是对象");

  const again = s.workspaces.create({
    requestId: "req-1",
    projectId: project.id,
    name: "不同的名字",
    baseBranch: "dev",
    branch: "other",
    cwd: "/x",
    model: { id: "other" },
  });
  assert.equal(again.created, false);
  assert.equal(again.workspace.id, workspace.id);
  assert.equal(again.workspace.name, "w1", "不覆盖原记录");
  assert.equal(s.workspaces.list().length, 1);

  const other = s.workspaces.create({ requestId: "req-2", projectId: project.id, name: "w2", baseBranch: "main", branch: "b2", cwd: "/c", model: MODEL });
  assert.equal(other.created, true);
  assert.notEqual(other.workspace.id, workspace.id);
  s.close();
});

test("workspaces：项目不存在、update 字段白名单、archive 与 list", () => {
  const s = openControlStore({ path: null });
  assert.throws(() => s.workspaces.create({ requestId: "r", projectId: "nope", name: "n", baseBranch: "main", branch: "b", cwd: "/", model: MODEL }), {
    code: "not_found",
  });
  const { workspace } = seed(s);
  const u = s.workspaces.update(workspace.id, { status: "ready", baseCommit: "deadbeef", error: null });
  assert.equal(u.status, "ready");
  assert.equal(u.baseCommit, "deadbeef");
  assert.throws(() => s.workspaces.update(workspace.id, { requestId: "x" }), { code: "invalid" });
  assert.throws(() => s.workspaces.update(workspace.id, { status: "bogus" }), /CHECK|constraint/i);
  assert.throws(() => s.workspaces.update("nope", { status: "ready" }), { code: "not_found" });
  s.workspaces.archive(workspace.id);
  assert.equal(s.workspaces.get(workspace.id).status, "archived");
  assert.equal(s.workspaces.list().length, 0);
  assert.equal(s.workspaces.list({ includeArchived: true }).length, 1);
  s.close();
});

test("workspace_steps：初始 pending，setStep 记录时间与错误，非法 step / state 被拒", () => {
  const s = openControlStore({ path: null });
  const { workspace } = seed(s);
  const initial = s.workspaces.steps(workspace.id);
  assert.deepEqual(
    initial.map((x) => [x.step, x.state]),
    [
      ["runtime", "pending"],
      ["init", "pending"],
      ["code", "pending"],
      ["deps", "pending"],
      ["agent", "pending"],
    ],
  );
  const running = s.workspaces.setStep(workspace.id, "runtime", { state: "running" });
  assert.equal(running.state, "running");
  assert.ok(running.startedAt);
  assert.equal(running.finishedAt, null);
  const failed = s.workspaces.setStep(workspace.id, "runtime", { state: "failed", error: "boom" });
  assert.equal(failed.error, "boom");
  assert.ok(failed.finishedAt);
  assert.equal(failed.startedAt, running.startedAt);
  const unknown = s.workspaces.setStep(workspace.id, "init", { state: "unknown", error: "待确认" });
  assert.equal(unknown.state, "unknown");
  const done = s.workspaces.setStep(workspace.id, "runtime", { state: "done" });
  assert.equal(done.error, null, "状态更新时清掉旧错误");
  assert.throws(() => s.workspaces.setStep(workspace.id, "nope", { state: "done" }), { code: "invalid" });
  assert.throws(() => s.workspaces.setStep(workspace.id, "code", { state: "weird" }), /CHECK|constraint/i);
  assert.throws(() => s.workspaces.setStep("nope", "code", { state: "done" }), { code: "not_found" });
  s.close();
});

test("bindings：连续两次 bind 后版本 1、2，只有一个 active，旧的 replaced", () => {
  const s = openControlStore({ path: null });
  const { workspace } = seed(s);
  assert.equal(s.bindings.current(workspace.id), undefined);
  const b1 = s.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-aaa" });
  const b2 = s.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-bbb" });
  assert.equal(b1.version, 1);
  assert.equal(b2.version, 2);
  assert.equal(b2.state, "active");
  const cur = s.bindings.current(workspace.id);
  assert.equal(cur.runtimeId, "pca-bbb");
  assert.equal(cur.version, 2);
  const hist = s.bindings.history(workspace.id);
  assert.deepEqual(
    hist.map((h) => [h.version, h.state, h.runtimeId]),
    [
      [1, "replaced", "pca-aaa"],
      [2, "active", "pca-bbb"],
    ],
  );
  assert.ok(hist[0].replacedAt);
  assert.throws(() => s.bindings.bind("nope", { provider: "sprites", runtimeId: "x" }), { code: "not_found" });
  s.close();
});

test("bindings：schema 层面拒绝同一工作区第二个 active（部分唯一索引）", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const path = join(dir, "control.sqlite");
    const s = openControlStore({ path });
    const { workspace } = seed(s);
    s.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "a" });
    s.close();

    const raw = new DatabaseSync(path);
    assert.throws(
      () =>
        raw
          .prepare("INSERT INTO runtime_bindings (workspace_id, provider, runtime_id, version, state, created_at) VALUES (?, 'sprites', 'z', 9, 'active', 'now')")
          .run(workspace.id),
      /UNIQUE/i,
    );
    // replaced 可以有多个
    raw
      .prepare("INSERT INTO runtime_bindings (workspace_id, provider, runtime_id, version, state, created_at) VALUES (?, 'sprites', 'z', 9, 'replaced', 'now')")
      .run(workspace.id);
    raw.close();
  } finally {
    cleanup();
  }
});

test("bindings：不同工作区各自从版本 1 开始，互不影响", () => {
  const s = openControlStore({ path: null });
  const { project, workspace } = seed(s);
  const w2 = s.workspaces.create({ requestId: "req-2", projectId: project.id, name: "w2", baseBranch: "main", branch: "b", cwd: "/c", model: MODEL }).workspace;
  s.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "a" });
  const b = s.bindings.bind(w2.id, { provider: "sprites", runtimeId: "b" });
  assert.equal(b.version, 1);
  assert.equal(s.bindings.current(workspace.id).runtimeId, "a");
  assert.equal(s.bindings.current(w2.id).runtimeId, "b");
  s.close();
});

test("links：同会话重复 link 幂等，关联到不同工作区报错", () => {
  const s = openControlStore({ path: null });
  const { project, workspace } = seed(s);
  const w2 = s.workspaces.create({ requestId: "req-2", projectId: project.id, name: "w2", baseBranch: "main", branch: "b", cwd: "/c", model: MODEL }).workspace;

  assert.equal(s.links.workspaceOf("conv-1"), undefined);
  assert.deepEqual(s.links.conversationsOf(workspace.id), []);

  const l1 = s.links.link({ conversationId: "conv-1", workspaceId: workspace.id, botId: "bot-1" });
  const l2 = s.links.link({ conversationId: "conv-1", workspaceId: workspace.id, botId: "bot-1" });
  assert.deepEqual(l1, l2);
  assert.equal(s.links.conversationsOf(workspace.id).length, 1);

  assert.throws(() => s.links.link({ conversationId: "conv-1", workspaceId: w2.id, botId: "bot-1" }), { code: "conflict" });
  assert.equal(s.links.workspaceOf("conv-1").id, workspace.id, "冲突不改原关联");

  s.links.link({ conversationId: "conv-2", workspaceId: workspace.id, botId: "bot-2" });
  assert.deepEqual(
    s.links.conversationsOf(workspace.id).map((l) => [l.conversationId, l.botId]),
    [
      ["conv-1", "bot-1"],
      ["conv-2", "bot-2"],
    ],
  );
  assert.deepEqual(s.links.conversationsOf(w2.id), []);
  assert.throws(() => s.links.link({ conversationId: "conv-3", workspaceId: "nope" }), { code: "not_found" });
  s.close();
});

test("intents：begin 重复返回原记录且不改状态；settle / list / 非法状态", () => {
  const s = openControlStore({ path: null });
  const first = s.intents.begin({ requestId: "i-1", kind: "sprites.create", target: "pca-abc" });
  assert.equal(first.created, true);
  assert.equal(first.intent.state, "planned");

  s.intents.markSent("i-1");
  assert.equal(s.intents.get("i-1").state, "sent");

  const again = s.intents.begin({ requestId: "i-1", kind: "sprites.create", target: "pca-abc" });
  assert.equal(again.created, false);
  assert.equal(again.intent.state, "sent", "已存在则不改状态");

  const settled = s.intents.settle("i-1", { state: "confirmed", evidence: { number: 7, url: "u" } });
  assert.equal(settled.state, "confirmed");
  assert.deepEqual(settled.evidence, { number: 7, url: "u" });
  const kept = s.intents.settle("i-1", { state: "unknown" });
  assert.deepEqual(kept.evidence, { number: 7, url: "u" }, "省略 evidence 保留原值");

  s.intents.begin({ requestId: "i-2", kind: "github.pr", target: "acme/app#b", workspaceId: "ws-x" });
  assert.equal(s.intents.list().length, 2);
  assert.deepEqual(s.intents.list({ state: "planned" }).map((i) => i.requestId), ["i-2"]);
  assert.deepEqual(s.intents.list({ kind: "sprites.create" }).map((i) => i.requestId), ["i-1"]);
  assert.equal(s.intents.get("i-2").workspaceId, "ws-x");

  assert.throws(() => s.intents.settle("i-1", { state: "planned" }), { code: "invalid" });
  assert.throws(() => s.intents.settle("nope", { state: "failed" }), { code: "not_found" });
  assert.equal(s.intents.get("nope"), undefined);
  s.close();
});

test("executions：claim 重复不改状态；状态集合由 CHECK 约束；listOpen", () => {
  const s = openControlStore({ path: null });
  const run = { runId: "r1", workspaceId: "w", runtimeId: "pca-a", bindingVersion: 1, cwd: "/c", commandHash: "h1" };
  const c1 = s.executions.claim(run);
  assert.equal(c1.created, true);
  assert.equal(c1.execution.state, "claimed");
  assert.equal(c1.execution.exit, null);

  s.executions.update("r1", { state: "started" });
  const c2 = s.executions.claim({ ...run, commandHash: "其它" });
  assert.equal(c2.created, false);
  assert.equal(c2.execution.state, "started", "已存在则不改状态");
  assert.equal(c2.execution.commandHash, "h1", "也不改字段");

  for (const state of ["started", "exited", "lost", "unknown", "claimed"]) {
    assert.equal(s.executions.update("r1", { state }).state, state);
  }
  assert.throws(() => s.executions.update("r1", { state: "running" }), /CHECK|constraint/i);
  assert.equal(s.executions.get("r1").state, "claimed", "失败的更新不生效");
  assert.throws(() => s.executions.update("r1", { bogus: 1 }), { code: "invalid" });
  assert.throws(() => s.executions.update("nope", { state: "lost" }), { code: "not_found" });

  s.executions.claim({ ...run, runId: "r2" });
  s.executions.update("r2", { state: "exited", exit: { code: 0 } });
  assert.deepEqual(s.executions.get("r2").exit, { code: 0 });
  assert.deepEqual(s.executions.listOpen().map((e) => e.runId), ["r1"]);
  assert.equal(s.executions.get("nope"), undefined);
  s.close();
});

test("requests.begin：新建 / 同内容 / 冲突，冲突不覆盖原记录", () => {
  const s = openControlStore({ path: null });
  const a = { scope: "workspace.create", requestId: "q1", payloadHash: "hash-A" };
  assert.deepEqual(s.requests.begin(a), { created: true, conflict: false });
  assert.deepEqual(s.requests.begin(a), { created: false, conflict: false });
  assert.deepEqual(s.requests.begin({ ...a, payloadHash: "hash-B" }), { created: false, conflict: true });
  // 冲突没有覆盖：用原 hash 仍是“同内容”，用 B 仍是冲突
  assert.deepEqual(s.requests.begin(a), { created: false, conflict: false });
  assert.deepEqual(s.requests.begin({ ...a, payloadHash: "hash-B" }), { created: false, conflict: true });
  // 不同 scope 互不影响
  assert.deepEqual(s.requests.begin({ ...a, scope: "other", payloadHash: "hash-B" }), { created: true, conflict: false });
  s.close();
});

test("meta：ensure 首次写入、之后读回；get 未设置返回 undefined", () => {
  const s = openControlStore({ path: null });
  assert.equal(s.meta.get("namespace"), undefined);
  let calls = 0;
  const v1 = s.meta.ensure("namespace", () => (calls++, "ns-1"));
  const v2 = s.meta.ensure("namespace", () => (calls++, "ns-2"));
  assert.equal(v1, "ns-1");
  assert.equal(v2, "ns-1");
  assert.equal(calls, 1, "已有值时不再调用 makeValue");
  assert.equal(s.meta.get("namespace"), "ns-1");
  assert.equal(s.meta.ensure("generation", () => 1), 1);
  assert.equal(typeof s.meta.get("generation"), "number", "整数仍读出整数");
  s.close();
});

test("meta：重开后 ensure 读到同一个值；bumpGeneration 每次加一且持久", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const path = join(dir, "sub", "control.sqlite");
    const s1 = openControlStore({ path });
    const ns = s1.meta.ensure("namespace", () => "random-ns");
    assert.equal(s1.meta.ensure("generation", () => 1), 1);
    assert.equal(s1.bumpGeneration(), 2);
    assert.equal(s1.bumpGeneration(), 3);
    s1.close();

    const s2 = openControlStore({ path });
    assert.equal(s2.meta.ensure("namespace", () => "另一个"), ns);
    assert.equal(s2.meta.ensure("generation", () => 1), 3);
    assert.equal(s2.meta.bumpGeneration(), 4);
    assert.equal(s2.meta.get("generation"), 4);
    s2.close();
  } finally {
    cleanup();
  }
});

test("bumpGeneration：尚无 generation 时按初始值 1 计", () => {
  const s = openControlStore({ path: null });
  assert.equal(s.bumpGeneration(), 2);
  assert.equal(s.meta.ensure("generation", () => 1), 2);
  s.close();
});

test("checkpoints：增、列（新的在前）、取、置顶、删", () => {
  let t = Date.parse("2026-10-25T00:00:00Z");
  const s = openControlStore({ path: null, now: () => (t += 1000) });
  const base = { workspaceId: "ws-1", bindingVersion: 1, path: "/data/cp/a.bundle", sha256: "aa", size: 10, baseCommit: "b1", headCommit: "h1", treeHash: "t1" };
  const c1 = s.checkpoints.add(base);
  const c2 = s.checkpoints.add({ ...base, path: "/data/cp/b.bundle", sha256: "bb", size: 20 });
  s.checkpoints.add({ ...base, workspaceId: "ws-2" });
  assert.equal(c1.pinned, false);
  assert.equal(c1.treeHash, "t1");
  assert.deepEqual(s.checkpoints.list("ws-1").map((c) => c.id), [c2.id, c1.id]);
  assert.equal(s.checkpoints.list("ws-2").length, 1);
  assert.deepEqual(s.checkpoints.get(c1.id), c1);

  assert.equal(s.checkpoints.setPinned(c1.id, true).pinned, true);
  assert.equal(s.checkpoints.get(c1.id).pinned, true);
  assert.equal(s.checkpoints.setPinned(c1.id, false).pinned, false);
  assert.throws(() => s.checkpoints.setPinned("nope", true), { code: "not_found" });

  assert.equal(s.checkpoints.remove(c1.id), true);
  assert.equal(s.checkpoints.remove(c1.id), false);
  assert.equal(s.checkpoints.get(c1.id), undefined);
  assert.deepEqual(s.checkpoints.list("ws-1").map((c) => c.id), [c2.id]);
  assert.throws(() => s.checkpoints.add({ ...base, size: -1 }), { code: "invalid" });
  s.close();
});

test("持久化：关闭后用同一文件重新打开数据仍在，目录自动创建，迁移可重复运行", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const path = join(dir, "nested", "deeper", "control.sqlite");
    const s1 = openControlStore({ path });
    const { workspace } = seed(s1);
    s1.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-1" });
    s1.links.link({ conversationId: "c1", workspaceId: workspace.id, botId: "b1" });
    s1.intents.begin({ requestId: "i", kind: "k", target: "t" });
    s1.executions.claim({ runId: "r", workspaceId: workspace.id, runtimeId: "pca-1", bindingVersion: 1, cwd: "/", commandHash: "h" });
    s1.requests.begin({ scope: "s", requestId: "q", payloadHash: "p" });
    s1.checkpoints.add({ workspaceId: workspace.id, path: "/p", sha256: "x", size: 1 });
    s1.close();
    assert.ok(existsSync(path));

    // 打开两次、三次，迁移不报错且数据不变
    openControlStore({ path }).close();
    const s2 = openControlStore({ path });
    assert.equal(s2.workspaces.get(workspace.id).name, "w1");
    assert.equal(s2.bindings.current(workspace.id).runtimeId, "pca-1");
    assert.equal(s2.links.workspaceOf("c1").id, workspace.id);
    assert.equal(s2.intents.get("i").kind, "k");
    assert.equal(s2.executions.get("r").state, "claimed");
    assert.deepEqual(s2.requests.begin({ scope: "s", requestId: "q", payloadHash: "p" }), { created: false, conflict: false });
    assert.equal(s2.checkpoints.list(workspace.id).length, 1);
    assert.equal(s2.workspaces.create({ requestId: "req-1", projectId: workspace.projectId, name: "x", baseBranch: "m", branch: "b", cwd: "/", model: MODEL }).created, false);
    s2.close();

    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
    raw.close();
  } finally {
    cleanup();
  }
});

test("迁移：版本高于程序支持时拒绝打开", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const path = join(dir, "control.sqlite");
    openControlStore({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`);
    raw.close();
    assert.throws(() => openControlStore({ path }), /高于/);
  } finally {
    cleanup();
  }
});

test("事务：失败的组合操作整体回滚（meta.ensure 的 makeValue 抛错不留痕）", () => {
  const s = openControlStore({ path: null });
  assert.throws(() =>
    s.meta.ensure("k", () => {
      throw new Error("boom");
    }),
  /boom/);
  assert.equal(s.meta.get("k"), undefined);
  assert.equal(s.meta.ensure("k", () => "ok"), "ok", "回滚后事务状态正常，可继续使用");
  s.close();
});

test("内存库：path 省略或 null 都是独立的内存库", () => {
  const a = openControlStore({ path: null });
  const b = openControlStore({ path: null });
  a.projects.upsert({ repo: "x/y", defaultBranch: "main" });
  assert.equal(b.projects.list().length, 0);
  a.close();
  b.close();
});
