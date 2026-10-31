// Local acceptance MCP server. No filesystem, shell, network or credential tools.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export function createAcceptanceMcp() {
  let calls = 0;
  return createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/health" && req.method === "GET") return json(200, { ok: true, toolCalls: calls });
    if (req.url !== "/mcp" || req.method !== "POST") return json(404, { error: "not found" });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 16_384) return json(413, { error: "request too large" });
      }
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      let result;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "pca-local-acceptance", version: "1.0.0" } };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "add", description: "Add two numbers using this local MCP service.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false } }] };
      } else if (message.method === "tools/call" && message.params?.name === "add") {
        const { a, b } = message.params.arguments ?? {};
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("finite numbers required");
        calls++;
        result = { content: [{ type: "text", text: JSON.stringify({ sum: a + b, source: "local-mcp", call: calls }) }] };
      } else return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
      return json(200, { jsonrpc: "2.0", id: message.id, result });
    } catch {
      return json(400, { error: "invalid request" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PCA_ACCEPTANCE_MCP_PORT ?? 8791);
  const server = createAcceptanceMcp();
  server.listen(port, "127.0.0.1", () => console.log(`Acceptance MCP listening on http://127.0.0.1:${port}/mcp`));
  process.on("SIGTERM", () => server.close());
}
