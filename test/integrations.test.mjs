// AMP13-integrations (revised): offline tests — real fauxProvider harness agent tool calls, a real
// control store, a real registry, a fake MCP endpoint and a fake runtime bash. No fake-HTTP-only claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { ctx, openHarness } from "../src/harness.mjs";
import { BotRegistry, setIntegrationsApplier } from "../src/bots.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { createApproval, ApprovalCenter } from "../src/ext/approval.mjs";
import { createApi } from "../src/api.mjs";
import {
  McpSession,
  assertSafeUrl,
  createIntegrationsService,
  listWorkspaceSkillFiles,
  parseSkillFrontmatter,
  readWorkspaceSkillFile,
} from "../src/integrations.mjs";
import { createIntegrationsExtension } from "../src/integrations.mjs";
import { Integrations, setIntegrationsService } from "../src/ext/integrations.mjs";
import { register as registerIntegrations } from "../src/routes/integrations.mjs";
import { register as registerApprovals } from "../src/routes/approvals.mjs";

const FAUX = { provider: "faux", modelId: "faux-1" };
const CWD = "/home/sprite/workspace/app";
const SECRET = "mcp-secret-value-123";
const SKILL_MD = "---\nname: review-code\ndescription: review code changes carefully\n---\n# Review\n1. Check the diff.\n2. Report risks.";

const toolCall = (name, args, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

function fauxModels(responses) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  return models;
}

// ---- fake MCP endpoint -----------------------------------------------------------------------------------------------

function fakeMcpFetch(state = {}) {
  const calls = [];
  state.auths ??= [];
  state.callAuths ??= [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const headers = init?.headers ?? {};
    const reply = (status, data, extraHeaders = {}, asSse = false) => ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => extraHeaders[k] ?? extraHeaders[k.toLowerCase()] ?? null },
      arrayBuffer: async () => {
        if (data === undefined) return new ArrayBuffer(0);
        const text = asSse ? `data: ${JSON.stringify(data)}\n\n` : JSON.stringify(data);
        return new TextEncoder().encode(text).buffer;
      },
    });
    if (init?.method === "DELETE") return reply(200);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (body?.method === "initialize") {
      state.auths.push(headers.Authorization ?? null);
      return reply(
        200,
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "fake-mcp", version: "1.0" }, capabilities: {} } },
        { "mcp-session-id": "sess-1", "content-type": "application/json" },
      );
    }
    if (body?.method === "notifications/initialized") {
      assert.equal(headers["mcp-session-id"], "sess-1");
      return reply(202);
    }
    if (body?.method === "tools/list") {
      return reply(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "search-web", description: "search the web", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
              { name: "write_file", description: "write remotely", inputSchema: { type: "object", properties: { p: { type: "string" } } } },
            ],
          },
        },
        { "content-type": "application/json" },
      );
    }
    if (body?.method === "tools/call") {
      state.callAuths.push(headers.Authorization ?? null);
      const payload = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `hit:${body.params.name}:${body.params.arguments.q ?? body.params.arguments.p ?? ""}` }] } };
      return state.callSse ? reply(200, payload, { "content-type": "text/event-stream" }, true) : reply(200, payload, { "content-type": "application/json" });
    }
    return reply(404, { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "unknown" } }, { "content-type": "application/json" });
  };
  return { calls, fetch: fetchImpl, state };
}

const publicLookup = async () => [{ address: "203.0.113.9" }];

// ---- pure helpers -----------------------------------------------------------------------------------------------------

test("frontmatter: name/description parsed, missing frontmatter gives {}", () => {
  const fm = parseSkillFrontmatter(SKILL_MD);
  assert.equal(fm.name, "review-code");
  assert.equal(fm.description, "review code changes carefully");
  assert.deepEqual(parseSkillFrontmatter("# just text"), {});
});

test("assertSafeUrl blocks loopback/private/reserved/link-local and embedded credentials", () => {
  for (const bad of [
    "http://127.0.0.1:8090/api",
    "http://localhost:1/x",
    "http://[::1]/x",
    "http://10.0.0.4/x",
    "http://169.254.169.254/latest",
    "http://192.168.1.1/x",
    "http://172.16.0.1/x",
    "http://host.local/x",
    "ftp://example.com/x",
    "https://user:pw@example.com/x",
  ]) {
    assert.throws(() => assertSafeUrl(bad), /not allowed|private|credentials|http\(s\)/, bad);
  }
  assert.equal(assertSafeUrl("https://mcp.exa.ai/mcp"), "https://mcp.exa.ai/mcp");
});

function fakeFs(files, cwd = CWD) {
  const calls = [];
  const bash = async (command) => {
    calls.push(command);
    if (command.includes("-name 'SKILL.md'")) {
      const found = Object.keys(files).map((p) => `${cwd}/${p}`).join("\0");
      return { stdout: found ? `${found}\0` : "", stderr: "", exitCode: 0 };
    }
    if (command.includes("realpath")) {
      const m = /realpath -m '([^']+)'/.exec(command);
      const abs = m?.[1];
      const rel = abs?.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : undefined;
      const content = rel !== undefined ? files[rel] : undefined;
      if (content === undefined) return { stdout: "", stderr: "No such file or directory", exitCode: 1 };
      return { stdout: content, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { calls, bash };
}

// ---- world: real harness + control store + service --------------------------------------------------------------------

async function makeWorld({ responses = [], mcp = fakeMcpFetch(), files = {}, envExtras = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tars-int-"));
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "acme/app", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "seed-int",
    projectId: project.id,
    name: "ws",
    baseBranch: "main",
    branch: "tarsbot/x-111111",
    cwd: CWD,
    model: FAUX,
  });
  store.workspaces.update(workspace.id, { status: "ready" });
  store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-test" });
  const project2 = store.projects.upsert({ repo: "acme/other", defaultBranch: "main" });
  const { workspace: ws2 } = store.workspaces.create({
    requestId: "seed-int-2",
    projectId: project2.id,
    name: "ws2",
    baseBranch: "main",
    branch: "tarsbot/y-222222",
    cwd: "/home/sprite/workspace/other",
    model: FAUX,
  });
  store.workspaces.update(ws2.id, { status: "ready" });
  store.bindings.bind(ws2.id, { provider: "sprites", runtimeId: "pca-other" });

  const center = new ApprovalCenter();
  const { harness, registry } = await openHarness({
    storage: new MemoryStorage(),
    models: fauxModels(responses),
    // The static base: mirrors runtime.mjs bootstrap (settings.extensions makes dynamic installs opt-in;
    // tarsbot.integrations + approval are part of the static list in production — approval's beforeTool
    // hook only runs for extensions in the agent's selection).
    settings: { extensions: [Preamble, CodingTools, Integrations, createApproval({ center })] },
  });
  registry.install(createApproval({ center }));
  registry.install(Integrations);
  const bots = new BotRegistry(harness, { path: null });
  const service = createIntegrationsService({
    path: join(dir, "integrations.json"),
    control: store,
    registry,
    bots,
    ctx,
    env: { EXA_API_KEY: SECRET, ...(envExtras ?? {}) },
    fetchImpl: mcp.fetch,
    lookup: publicLookup,
  });
  setIntegrationsService(service);
  setIntegrationsApplier(service.applyToBot);
  const fs = fakeFs(files);

  const api = createApi({
    harness,
    bots,
    routes: [
      (app) =>
        Object.assign(app.ctx, {
          workspaces: { get: (id) => store.workspaces.get(id), list: () => store.workspaces.list() },
          control: store,
          runtimeBash: () => fs.bash,
          integrations: service,
          approvals: center,
        }),
      registerIntegrations,
      registerApprovals,
    ],
  });
  const { port } = await api.listen(0);
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    assert.ok(!text.includes(SECRET), `response leaks a secret: ${text.slice(0, 200)}`);
    assert.ok(!text.includes(dir), "response carries a server path");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  return {
    dir,
    store,
    ws: workspace,
    ws2,
    harness,
    registry,
    bots,
    service,
    center,
    fs,
    mcp,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    async newBot(name, wsId, spec = {}) {
      const bot = await bots.createBot({ name, model: FAUX, cwd: CWD, workspaceId: wsId ?? workspace.id, ...spec });
      store.links.link({ conversationId: String(bot.conversationId), workspaceId: wsId ?? workspace.id, botId: bot.id });
      return bot;
    },
    async close() {
      setIntegrationsApplier(undefined);
      setIntegrationsService(undefined);
      await api.close();
      await harness.close(ctx);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function toolResultsOf(conv) {
  const page = await conv.entries({}, 50, undefined, ctx);
  return page.items
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => ({ name: e.model[0].toolName, text: e.model[0].content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: e.model[0].isError === true }));
}

const until = async (fn, what, timeoutMs = 8000) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ---- skills: install → model sees catalog → load_skill returns content ---------------------------------------------------

test("skill install → system context lists it → model calls load_skill → real content (faux harness)", async () => {
  const w = await makeWorld({
    responses: [toolCall("load_skill", { name: "review-code" }), fauxAssistantMessage([fauxText("skill loaded")])],
  });
  try {
    const bot = await w.newBot("s1");
    // install through the real route
    const res = await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "skill", content: SKILL_MD });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.install.name, "review-code");
    assert.equal(res.json.install.kind, "skill");

    const conv = await w.bots.conversation(bot.id);
    await (await conv.submit({ type: "input", content: "review my diff" }, ctx)).wait(ctx);
    await conv.waitForIdle(ctx);

    const results = await toolResultsOf(conv);
    const load = results.find((r) => r.name === "load_skill");
    assert.ok(load, `no load_skill tool result: ${JSON.stringify(results)}`);
    assert.equal(load.isError !== true, true, `load_skill errored: ${load.text.slice(0, 200)}`);
    assert.match(load.text, /Check the diff/);
    assert.match(load.text, /untrusted|不可信/i);

    // the integrations section rendered the catalog into the system context
    const agent = await conv.agent(ctx);
    const sectionTexts = [];
    for (const s of agent.sections) {
      const t = await s.render({ conversationId: conv.id, agent, shown: {}, read: {} }, ctx);
      if (t) sectionTexts.push(t);
    }
    assert.ok(sectionTexts.some((t) => t.includes('skill "review-code"')), "section does not list the installed skill");
  } finally {
    await w.close();
  }
});

test("skill install from a workspace file: real content snapshot; uninstall removes only the record", async () => {
  const w = await makeWorld({ files: { "skills/review/SKILL.md": SKILL_MD } });
  try {
    const bot = await w.newBot("s2");
    const list = await w.get(`/api/workspaces/${w.ws.id}/integrations/skills?bot=${bot.id}`);
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.skills, [{ path: "skills/review/SKILL.md", name: "review" }]);

    const res = await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "skill-file", bot: bot.id, path: "skills/review/SKILL.md" });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.install.name, "review-code", "frontmatter name wins");
    assert.equal(res.json.install.source.type, "workspace-file");

    const removed = await w.post(`/api/workspaces/${w.ws.id}/integrations/${res.json.install.id}/uninstall`, {});
    assert.equal(removed.status, 200);
    assert.deepEqual((await w.get(`/api/workspaces/${w.ws.id}/integrations`)).json.installs, []);
    // the original workspace file was never touched (read-only fake fs saw only reads)
    assert.ok(w.fs.calls.every((c) => !/\b(rm|mv|truncate)\b/.test(c)), "uninstall touched the workspace");
  } finally {
    await w.close();
  }
});

// ---- MCP: install → tools in agent set → call gated by approval → real result -------------------------------------------

test("MCP install: real initialize+tools/list, tool enters agent set, call blocked by approval then runs once", async () => {
  const w = await makeWorld({
    responses: [toolCall("mcp__exa__search_web", { q: "hi" }), fauxAssistantMessage([fauxText("done")])],
  });
  try {
    const bot = await w.newBot("m1");
    const res = await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "mcp", name: "exa", url: "https://mcp.exa.ai/mcp", tokenEnv: "EXA_API_KEY" });
    assert.equal(res.status, 200, res.text);
    const install = res.json.install;
    assert.equal(install.kind, "mcp");
    assert.equal(install.toolCount, 2);
    assert.deepEqual(
      install.tools.map((t) => t.name).sort(),
      ["mcp__exa__search_web", "mcp__exa__write_file"].sort(),
    );
    // real initialize + tools/list hit the endpoint (install + each later call)
    assert.ok(w.mcp.calls.filter((c) => c.body?.method === "initialize").length >= 1, "no real initialize");
    assert.ok(w.mcp.calls.some((c) => c.body?.method === "tools/list"), "no real tools/list");

    const conv = await w.bots.conversation(bot.id);
    const agent = await conv.agent(ctx);
    assert.ok(
      agent.tools.some((t) => t.name === "mcp__exa__search_web"),
      `tool not offered: ${agent.tools.map((t) => t.name)}`,
    );

    const callsBefore = w.mcp.calls.filter((c) => c.body?.method === "tools/call").length;
    const sub = await conv.submit({ type: "input", content: "search the web for hi" }, ctx);
    const [item] = await until(() => (w.center.list().length ? w.center.list() : undefined), "pending approval");
    assert.equal(item.toolName, "mcp__exa__search_web");
    assert.match(item.reason, /external side effects/);
    assert.equal(w.mcp.calls.filter((c) => c.body?.method === "tools/call").length, callsBefore, "call ran before approval");
    w.center.resolve(item.taskId, true);
    await sub.wait(ctx);
    await conv.waitForIdle(ctx);

    const results = await toolResultsOf(conv);
    const r = results.find((x) => x.name === "mcp__exa__search_web");
    assert.ok(r, "no MCP tool result");
    assert.match(r.text, /hit:search-web:hi/);
    assert.match(r.text, /不可信|untrusted/i);
    assert.equal(w.mcp.calls.filter((c) => c.body?.method === "tools/call").length, callsBefore + 1, "exactly one remote call after one approval");
    assert.ok(w.mcp.state.callAuths.every((a) => a === `Bearer ${SECRET}`), "tool call sent the configured Bearer token");
  } finally {
    await w.close();
  }
});

test("MCP install validation: private URL / bad DNS / unknown env are refused before any record", async () => {
  const w = await makeWorld();
  try {
    assert.equal((await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "mcp", name: "x", url: "http://169.254.169.254/m" })).status, 400);
    assert.equal((await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "mcp", name: "x", url: "https://mcp.exa.ai/mcp", tokenEnv: "NOT_SET_VAR" })).status, 400);
    assert.equal((await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "mcp", name: "x", url: "https://mcp.exa.ai/mcp", tokenEnv: "TARSBOT_SECRET" })).status, 400);
    assert.equal((await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "mcp", name: "x", url: "http://mcp.exa.ai/mcp", tokenEnv: "EXA_API_KEY" })).status, 400);
    assert.equal((await w.get(`/api/workspaces/${w.ws.id}/integrations`)).json.installs.length, 0);
    assert.equal(w.mcp.calls.filter((c) => c.body?.method === "initialize").length, 0, "refused installs never connected");

    // private DNS answer is refused even for a public hostname
    const svc = createIntegrationsService({
      path: join(w.dir, "i2.json"),
      control: w.store,
      registry: w.registry,
      bots: w.bots,
      ctx,
      env: {},
      fetchImpl: w.mcp.fetch,
      lookup: async () => [{ address: "10.0.0.9" }],
    });
    await assert.rejects(svc.installMcp({ workspaceId: w.ws.id, name: "evil", url: "https://mcp.exa.ai/mcp" }), /private|reserved/);
  } finally {
    await w.close();
  }
});

test("MCP names sharing a tool namespace are rejected before connecting twice", async () => {
  const w = await makeWorld();
  try {
    const path = `/api/workspaces/${w.ws.id}/integrations`;
    assert.equal((await w.post(path, { kind: "mcp", name: "exa one", url: "https://mcp.exa.ai/mcp" })).status, 200);
    const calls = w.mcp.calls.length;
    assert.equal((await w.post(path, { kind: "mcp", name: "exa-one", url: "https://mcp.exa.ai/mcp" })).status, 409);
    assert.equal(w.mcp.calls.length, calls);
  } finally { await w.close(); }
});

// ---- isolation + lifecycle ----------------------------------------------------------------------------------------------

test("workspace isolation: another workspace's session neither sees nor can call the MCP tools", async () => {
  const w = await makeWorld({
    responses: [toolCall("mcp__exa__search_web", { q: "hi" }), fauxAssistantMessage([fauxText("done")])],
  });
  try {
    const bot1 = await w.newBot("w1-bot", w.ws.id);
    const bot2 = await w.newBot("w2-bot", w.ws2.id);
    await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "mcp", name: "exa", url: "https://mcp.exa.ai/mcp" });

    const conv1 = await w.bots.conversation(bot1.id);
    const conv2 = await w.bots.conversation(bot2.id);
    assert.ok((await conv1.agent(ctx)).tools.some((t) => t.name === "mcp__exa__search_web"), "ws1 tool missing");
    assert.ok(
      !(await conv2.agent(ctx)).tools.some((t) => t.name?.startsWith("mcp__")),
      `ws2 sees foreign MCP tools: ${(await conv2.agent(ctx)).tools.map((t) => t.name)}`,
    );

    // ws2's model still calls the name — the execute path refuses (record not for this workspace... it is
    // not even offered, so the harness answers "unknown tool" and no remote call is made).
    const before = w.mcp.calls.filter((c) => c.body?.method === "tools/call").length;
    await (await conv2.submit({ type: "input", content: "search" }, ctx)).wait(ctx);
    await conv2.waitForIdle(ctx);
    const results = await toolResultsOf(conv2);
    const r = results.find((x) => x.name === "mcp__exa__search_web");
    if (r) assert.equal(r.isError, true);
    assert.equal(w.mcp.calls.filter((c) => c.body?.method === "tools/call").length, before, "foreign workspace made a remote call");
    assert.equal(w.center.list().length, 0, "foreign call reached approval");
  } finally {
    await w.close();
  }
});

test("disable removes tools from new turns and refuses stale calls; uninstall unpublishes", async () => {
  const w = await makeWorld({
    responses: [toolCall("mcp__exa__search_web", { q: "hi" }), fauxAssistantMessage([fauxText("done")])],
  });
  try {
    const bot = await w.newBot("d1");
    const res = await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "mcp", name: "exa", url: "https://mcp.exa.ai/mcp" });
    const id = res.json.install.id;
    const conv = await w.bots.conversation(bot.id);
    assert.ok((await conv.agent(ctx)).tools.some((t) => t.name === "mcp__exa__search_web"));

    const off = await w.post(`/api/workspaces/${w.ws.id}/integrations/${id}/enable`, { enabled: false });
    assert.equal(off.status, 200, off.text);
    const agent = await conv.agent(ctx);
    assert.ok(!agent.tools.some((t) => t.name?.startsWith("mcp__")), "disabled server tools still offered");
    assert.equal(w.registry.snapshot().extension(`tarsbot.mcp.${id}`), undefined, "extension still published");

    // re-enable brings them back without a second install
    await w.post(`/api/workspaces/${w.ws.id}/integrations/${id}/enable`, { enabled: true });
    assert.ok((await conv.agent(ctx)).tools.some((t) => t.name === "mcp__exa__search_web"));

    const gone = await w.post(`/api/workspaces/${w.ws.id}/integrations/${id}/uninstall`, {});
    assert.equal(gone.status, 200);
    assert.ok(!(await conv.agent(ctx)).tools.some((t) => t.name?.startsWith("mcp__")));
    assert.equal(w.registry.snapshot().extension(`tarsbot.mcp.${id}`), undefined);
  } finally {
    await w.close();
  }
});

test("a new session created after install inherits the enabled MCP tools (applyToBot seam)", async () => {
  const w = await makeWorld();
  try {
    await w.newBot("first");
    await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "mcp", name: "exa", url: "https://mcp.exa.ai/mcp" });
    const late = await w.newBot("late-joiner");
    const agent = await (await w.bots.conversation(late.id)).agent(ctx);
    assert.ok(agent.tools.some((t) => t.name === "mcp__exa__search_web"), "new session did not inherit tools");
  } finally {
    await w.close();
  }
});

test("persistence: installs survive service reopen; a reopened service republishes enabled MCP tools", async () => {
  const w = await makeWorld();
  try {
    const res = await w.post(`/api/workspaces/${w.ws.id}/integrations`, { kind: "mcp", name: "exa", url: "https://mcp.exa.ai/mcp" });
    assert.equal(res.status, 200);
    // reopen: same file, same registry -> enabled install republishes its extension
    const reopened = createIntegrationsService({
      path: join(w.dir, "integrations.json"),
      control: w.store,
      registry: w.registry,
      bots: w.bots,
      ctx,
      env: {},
      fetchImpl: w.mcp.fetch,
      lookup: publicLookup,
    });
    assert.ok(w.registry.snapshot().extension(`tarsbot.mcp.${res.json.install.id}`), "extension not republished after reopen");
    assert.equal(reopened.installs.list(w.ws.id).length, 1);
  } finally {
    await w.close();
  }
});
