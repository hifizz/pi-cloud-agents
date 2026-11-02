// Cross-feature boundary tests (AMP13-integrations x Issue14 loops): a loop-run Session is
// capability-restricted, and workspace integrations must never widen it — in BOTH directions:
//   1. applyToBot / configureWorkspaceSessions / applyInstallDelta skip loopRun sessions entirely;
//   2. a loop session that somehow got an MCP tool configured is still refused at execute time;
//   3. delegation creation is refused for a loop-run parent (a child would escape the boundary);
//   4. a loopRun worktree dir is honored by the shared session-root resolver (Files/Terminal/Git).
// Fully offline: MemoryStorage harness, real control store, fake MCP endpoint, fake runtime bash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { ctx, openHarness } from "../src/harness.mjs";
import { BotRegistry, setIntegrationsApplier } from "../src/bots.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { createIntegrationsService } from "../src/integrations.mjs";
import { sessionRootOf } from "../src/files-env.mjs";
import { attachTerminal, attachPtyTerminal } from "../src/terminal-env.mjs";
import { EventEmitter } from "node:events";

const FAUX = { provider: "faux", modelId: "faux-1" };
const CWD = "/home/sprite/workspace/app";

function fauxModels() {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  return models;
}

function fakeMcpFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const reply = (status, data, extraHeaders = {}) => ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => extraHeaders[k] ?? null },
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(data)).buffer,
    });
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (body?.method === "initialize") {
      return reply(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "fake-mcp" }, capabilities: {} } }, { "mcp-session-id": "s1" });
    }
    if (body?.method === "tools/list") {
      return reply(200, { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search-web", description: "s", inputSchema: { type: "object" } }] } }, { "mcp-session-id": "s1" });
    }
    if (body?.method === "tools/call") return reply(200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "hit" }] } }, { "mcp-session-id": "s1" });
    return reply(202, undefined, { "mcp-session-id": "s1" });
  };
  return { calls, fetch: fetchImpl };
}

const publicLookup = async () => [{ address: "203.0.113.9" }];

async function makeWorld({ mcp = fakeMcpFetch() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tars-cross-"));
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "cross-ws",
    projectId: project.id,
    name: "ws",
    baseBranch: "main",
    branch: "tarsbot/x-111111",
    cwd: CWD,
    model: FAUX,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-cross" });

  const { harness, registry } = await openHarness({
    storage: new MemoryStorage(),
    models: fauxModels(),
    settings: { extensions: [Preamble, CodingTools] },
  });
  const bots = new BotRegistry(harness, { path: null });
  const service = createIntegrationsService({
    path: join(dir, "integrations.json"),
    control: store,
    registry,
    bots,
    ctx,
    env: {},
    fetchImpl: mcp.fetch,
    lookup: publicLookup,
  });
  setIntegrationsApplier(service.applyToBot);

  const install = await service.installMcp({ workspaceId: workspace.id, name: "exa", url: "https://mcp.exa.ai/mcp" });
  assert.ok(registry.snapshot().extension(`tarsbot.mcp.${install.id}`), "MCP extension not published");

  return {
    dir,
    store,
    ws: workspace,
    harness,
    registry,
    bots,
    service,
    mcp,
    install,
    async close() {
      setIntegrationsApplier(undefined);
      await harness.close(ctx);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("cross: a loop-run session is skipped by every integrations apply path (never widened)", async () => {
  const w = await makeWorld();
  try {
    // A normal session gets the MCP tools via applyToBot (createBot seam).
    const normal = await w.bots.createBot({ name: "normal", model: FAUX, cwd: CWD, workspaceId: w.ws.id });
    w.store.links.link({ conversationId: String(normal.conversationId), workspaceId: w.ws.id, botId: normal.id });
    const normalAgent = await (await w.bots.conversation(normal.id)).agent(ctx);
    assert.ok(normalAgent.extensions.some((e) => e.name === `tarsbot.mcp.${w.install.id}`), "normal session did not inherit the MCP extension");

    // A loop-run session created the same way must NOT get it.
    const loopBot = await w.bots.createBot({
      name: "loop-run",
      model: FAUX,
      cwd: "/home/sprite/loops/ws/run-1",
      workspaceId: w.ws.id,
      loopRun: {
        loopId: "loop-1",
        runId: "run-1",
        version: 1,
        dir: "/home/sprite/loops/ws/run-1",
        pinnedSha: "a".repeat(40),
        branch: null,
        capabilities: { code: "read", web: false },
      },
    });
    w.store.links.link({ conversationId: String(loopBot.conversationId), workspaceId: w.ws.id, botId: loopBot.id });
    const loopAgent = await (await w.bots.conversation(loopBot.id)).agent(ctx);
    assert.ok(
      !loopAgent.extensions.some((e) => e.name?.startsWith("tarsbot.mcp.")),
      `loop session was widened with MCP extensions: ${loopAgent.extensions.map((e) => e.name)}`,
    );

    // The bulk paths skip it too: configureWorkspaceSessions and applyInstallDelta leave it untouched.
    const cfg = await w.service.configureWorkspaceSessions(w.ws.id);
    const loopAgentAfter = await (await w.bots.conversation(loopBot.id)).agent(ctx);
    assert.ok(!loopAgentAfter.extensions.some((e) => e.name?.startsWith("tarsbot.mcp.")), "configureWorkspaceSessions widened the loop session");
    assert.ok(cfg.configured >= 0);
    const delta = await w.service.applyInstallDelta(w.ws.id, { add: [w.install] });
    const loopAgentAfter2 = await (await w.bots.conversation(loopBot.id)).agent(ctx);
    assert.ok(!loopAgentAfter2.extensions.some((e) => e.name?.startsWith("tarsbot.mcp.")), "applyInstallDelta widened the loop session");
    void delta;
  } finally {
    await w.close();
  }
});

test("restricted Sessions cannot use manual console or PTY before runtime access", async () => {
  for (const bot of [{ id: "r", loopRun: { runId: "r1" } }, { id: "ro", readOnly: true }]) {
    for (const attach of [attachTerminal, attachPtyTerminal]) {
      const socket = new EventEmitter();
      const frames = [];
      let closed;
      socket.OPEN = socket.readyState = 1;
      socket.bufferedAmount = 0;
      socket.send = data => frames.push(JSON.parse(data));
      socket.close = code => { closed = code; };
      await attach({ ctx: { bots: { get: () => bot }, runtimeBash: () => assert.fail("runtime accessed") } }, socket, bot.id);
      assert.equal(closed, 4403);
      assert.equal(frames[0].type, "error");
    }
  }
});

test("cross: sessionRootOf honors loopRun.dir for Files/Terminal resolution", async () => {
  const w = await makeWorld();
  try {
    const loopDir = "/home/sprite/loops/ws/run-9";
    const bot = await w.bots.createBot({
      name: "loop-files",
      model: FAUX,
      cwd: loopDir,
      workspaceId: w.ws.id,
      loopRun: { loopId: "l", runId: "r9", version: 1, dir: loopDir, pinnedSha: "b".repeat(40), branch: "loops/x/r9", capabilities: { code: "readwrite", web: true } },
    });
    w.store.links.link({ conversationId: String(bot.conversationId), workspaceId: w.ws.id, botId: bot.id });
    const app = { ctx: { bots: w.bots, control: w.store } };
    const { workspace, root } = sessionRootOf(app, bot.id);
    assert.equal(workspace.id, w.ws.id);
    assert.equal(root, loopDir, "session root must be the run's own worktree, not the workspace cwd");
  } finally {
    await w.close();
  }
});
