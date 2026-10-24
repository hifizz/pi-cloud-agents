import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ToolResultEntry, AssistantEntry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openControlStore } from "../src/control/store.mjs";
import { createWorkspaceEnv } from "../src/workspace-env.mjs";
import { openHarness, ctx } from "../src/harness.mjs";

const MODEL = { provider: "faux", modelId: "faux-1" };

/** Fake provider: records every command per runtimeId. Never touches the network. */
function fakeProvider(kind = "sprites") {
  const calls = {};
  const bashes = {};
  let bashBuilds = 0;
  return {
    kind,
    calls,
    get bashBuilds() {
      return bashBuilds;
    },
    bash(runtimeId) {
      if (!bashes[runtimeId]) {
        bashBuilds++;
        bashes[runtimeId] = async (command) => {
          (calls[runtimeId] ??= []).push(command);
          return { stdout: `ran-on:${runtimeId}\n`, stderr: "", exitCode: 0 };
        };
      }
      return bashes[runtimeId];
    },
  };
}

function seed(store, n, { ready = true, bind = "rt-" + n } = {}) {
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: `req-${n}`,
    projectId: project.id,
    name: `w${n}`,
    baseBranch: "main",
    branch: `b${n}`,
    cwd: `/home/sprite/workspace/w${n}`,
    model: MODEL,
  });
  if (ready) store.workspaces.update(workspace.id, { status: "ready" });
  if (bind) store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: bind });
  store.links.link({ conversationId: `conv-${n}`, workspaceId: workspace.id, botId: null });
  return workspace;
}

const tryEnv = (f, t) => {
  try {
    return { env: f(t) };
  } catch (error) {
    return { error };
  }
};

test("没有工作区关联的会话抛错，不回退任何全局沙箱", () => {
  const store = openControlStore({ path: null });
  const sprites = fakeProvider();
  const f = createWorkspaceEnv({ store, providers: { sprites } });
  assert.throws(() => f({ conversationId: "nope", cwd: "/x" }), /工作区未就绪.*没有关联工作区/);
  assert.throws(() => f({}), /工作区未就绪/);
  assert.equal(sprites.bashBuilds, 0);
  store.close();
});

test("id 格式、cwd 默认取工作区、显式 cwd 优先", async () => {
  const store = openControlStore({ path: null });
  const ws = seed(store, 1);
  const f = createWorkspaceEnv({ store, providers: { sprites: fakeProvider() } });
  const env = f({ conversationId: "conv-1" });
  assert.equal(env.id, "sprites:rt-1:v1");
  assert.equal(env.cwd, ws.cwd);
  assert.equal(f({ conversationId: "conv-1", cwd: "/tmp/z" }).cwd, "/tmp/z");
  store.close();
});

test("两个工作区各自的 exec 落到各自的 runtime，互不串用", async () => {
  const store = openControlStore({ path: null });
  seed(store, 1);
  seed(store, 2);
  const sprites = fakeProvider();
  const f = createWorkspaceEnv({ store, providers: { sprites } });
  const a = f({ conversationId: "conv-1" });
  const b = f({ conversationId: "conv-2" });
  assert.notEqual(a.id, b.id);
  await a.exec("echo a", {}, undefined);
  await b.exec("echo b", {}, undefined);
  await a.exec("echo a2", {}, undefined);
  assert.equal(sprites.calls["rt-1"].length, 2);
  assert.equal(sprites.calls["rt-2"].length, 1);
  assert.ok(sprites.calls["rt-1"].every((c) => !c.includes("echo b")));
  assert.ok(sprites.calls["rt-2"][0].includes("echo b"));
  // bash 原语复用
  f({ conversationId: "conv-1" });
  assert.equal(sprites.bashBuilds, 2);
  store.close();
});

test("绑定从 v1 换到 v2 后下一次解析立即用 v2", async () => {
  const store = openControlStore({ path: null });
  const ws = seed(store, 1);
  const sprites = fakeProvider();
  const f = createWorkspaceEnv({ store, providers: { sprites } });
  const before = f({ conversationId: "conv-1" });
  assert.equal(before.id, "sprites:rt-1:v1");
  store.bindings.bind(ws.id, { provider: "sprites", runtimeId: "rt-1b" });
  const after = f({ conversationId: "conv-1" });
  assert.equal(after.id, "sprites:rt-1b:v2");
  await after.exec("echo x", {}, undefined);
  assert.equal(sprites.calls["rt-1b"].length, 1);
  assert.equal(sprites.calls["rt-1"], undefined);
  store.close();
});

test("未就绪一律抛带原因的错误：preparing / failed / 无绑定 / 供应商缺失 / 已归档", () => {
  const store = openControlStore({ path: null });
  const sprites = fakeProvider();
  const f = createWorkspaceEnv({ store, providers: { sprites } });

  seed(store, 1, { ready: false });
  assert.throws(() => f({ conversationId: "conv-1" }), /工作区未就绪.*preparing/);

  const w2 = seed(store, 2, { ready: false });
  store.workspaces.setStep(w2.id, "deps", { state: "failed", error: "npm ci 失败" });
  store.workspaces.update(w2.id, { status: "failed", error: "deps 失败" });
  assert.throws(() => f({ conversationId: "conv-2" }), /工作区未就绪.*deps.*npm ci 失败/);

  seed(store, 3, { bind: null });
  assert.throws(() => f({ conversationId: "conv-3" }), /工作区未就绪.*没有 active 运行环境绑定/);

  seed(store, 4);
  const g = createWorkspaceEnv({ store, providers: {} });
  assert.throws(() => g({ conversationId: "conv-4" }), /工作区未就绪.*供应商 sprites 未注册/);
  const h = createWorkspaceEnv({ store, providers: { e2b: fakeProvider("e2b") } });
  assert.throws(() => h({ conversationId: "conv-4" }), /供应商 sprites 未注册/);

  const w5 = seed(store, 5);
  store.workspaces.archive(w5.id);
  assert.throws(() => f({ conversationId: "conv-5" }), /工作区未就绪/);

  assert.equal(sprites.bashBuilds, 0, "未就绪时不构造 bash 原语");
  store.close();
});

function faux(responses) {
  const f = fauxProvider({ tokensPerSecond: 100000 });
  f.setResponses(responses);
  const models = createModels();
  models.setProvider(f.provider);
  return models;
}
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: "c1" })], { stopReason: "toolUse" });
const textOf = (e) => (e?.model?.[0]?.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("");

async function withHarness(responses, setup, fn) {
  const store = openControlStore({ path: null });
  const sprites = fakeProvider();
  let factoryCalls = 0;
  const inner = createWorkspaceEnv({ store, providers: { sprites } });
  const { harness } = await openHarness({
    storage: new MemoryStorage(),
    models: faux(responses),
    extensions: [CodingTools],
    env: (t) => {
      factoryCalls++;
      return inner(t);
    },
  });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL, cwd: "/home/sprite/workspace/w1" } }, ctx);
    setup({ store, conv });
    const sub = await conv.submit({ type: "input", content: "go" }, ctx);
    const settled = await sub.wait(ctx);
    const all = (await conv.entries({}, 200, undefined, ctx)).items;
    return await fn({ settled, all, sprites, factoryCalls: () => factoryCalls });
  } finally {
    await harness.close(ctx);
    store.close();
  }
}

test("真实 harness：未就绪时纯聊天仍完成", async () => {
  await withHarness(
    [fauxAssistantMessage([fauxText("plain-ok")])],
    ({ store, conv }) => seed(store, 9, { ready: false }) && store.links.link({ conversationId: String(conv.id), workspaceId: store.workspaces.list()[0].id, botId: null }),
    ({ settled, all }) => {
      assert.equal(settled.status, "done");
      assert.ok(all.some((e) => AssistantEntry.is(e) && textOf(e) === "plain-ok"));
    },
  );
});

for (const [tool, args] of [
  ["read", { path: "absent.txt" }],
  ["bash", { command: "echo hi" }],
]) {
  test(`真实 harness：未就绪时 ${tool} 得到包含原因的 tool_error，且没有触达任何 runtime`, async () => {
    await withHarness(
      [call(tool, args), fauxAssistantMessage([fauxText("after-error")])],
      ({ store, conv }) => {
        const ws = seed(store, 9, { ready: false });
        store.workspaces.setStep(ws.id, "runtime", { state: "running" });
        store.links.link({ conversationId: String(conv.id), workspaceId: ws.id, botId: null });
      },
      ({ settled, all, sprites }) => {
        assert.equal(settled.status, "done");
        const result = all.find(ToolResultEntry.is);
        assert.equal(result?.model?.[0]?.isError, true);
        assert.match(JSON.stringify(result.model), /工作区未就绪/);
        assert.deepEqual(sprites.calls, {});
        assert.ok(all.some((e) => AssistantEntry.is(e) && textOf(e) === "after-error"));
      },
    );
  });
}

test("真实 harness：会话没有工作区关联时 bash 得到 tool_error", async () => {
  await withHarness(
    [call("bash", { command: "echo hi" }), fauxAssistantMessage([fauxText("done")])],
    () => {},
    ({ all, sprites }) => {
      const result = all.find(ToolResultEntry.is);
      assert.equal(result?.model?.[0]?.isError, true);
      assert.match(JSON.stringify(result.model), /没有关联工作区/);
      assert.deepEqual(sprites.calls, {});
    },
  );
});
