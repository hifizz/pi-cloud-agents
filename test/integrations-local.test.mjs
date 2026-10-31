import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAcceptanceMcp } from "../scripts/acceptance-mcp.mjs";
import { createIntegrationsService, McpSession } from "../src/integrations.mjs";

test("local MCP uses real HTTP and only the exact operator endpoint is allowed", { timeout: 10000 }, async () => {
  const server = createAcceptanceMcp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const deps = { path: null, control: { workspaces: { get: id => ({ id }) } }, registry: { install() {}, uninstall() {} } };
  try {
    const denied = createIntegrationsService({ ...deps, env: {} });
    await assert.rejects(denied.installMcp({ workspaceId: "w", name: "local", url: base + "/mcp" }), /private|reserved/);
    const service = createIntegrationsService({ ...deps, env: { TARSBOT_MCP_LOCAL_ENDPOINTS: base + "/mcp" } });
    for (const url of [base + "/other", base + "/mcp?other=1", "http://127.0.0.1:1/mcp", "http://169.254.169.254/mcp"]) {
      await assert.rejects(service.installMcp({ workspaceId: "w", name: "bad", url }), /private|reserved/);
    }
    const install = await service.installMcp({ workspaceId: "w", name: "local", url: base + "/mcp" });
    assert.equal(install.tools[0].remoteName, "add");
    assert.equal((await (await fetch(base + "/health")).json()).toolCalls, 0);
    const session = new McpSession({ url: base + "/mcp" });
    await session.connect();
    const result = await session.callTool("add", { a: 17, b: 25 });
    assert.equal(JSON.parse(result.content[0].text).sum, 42);
    assert.equal((await (await fetch(base + "/health")).json()).toolCalls, 1);
    await session.close();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
