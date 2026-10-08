// Loopback reverse proxy for the Cua viewer so the Web UI can embed it in an iframe.
// cua-spacesd sends `frame-ancestors 'none'`; we forward every path (HTTP + WebSocket upgrade) unchanged and only
// rewrite frame-ancestors to allow the TARSBot UI origin. Bound to 127.0.0.1 only (S01).
import http from "node:http";
import net from "node:net";

/** Rewrite a CSP header so `frame-ancestors` allows the given origins. */
export function allowFraming(csp, origins) {
  const directive = `frame-ancestors ${origins.join(" ")}`;
  if (!csp) return directive;
  const parts = csp.split(";").map((p) => p.trim()).filter(Boolean).filter((p) => !p.startsWith("frame-ancestors"));
  parts.push(directive);
  return parts.join("; ");
}

/**
 * @param {{ target: string, port?: number, host?: string, allowOrigins: string[] }} opts target like http://127.0.0.1:3211
 */
export function startViewerProxy({ target, port = 3299, host = "127.0.0.1", allowOrigins }) {
  const t = new URL(target);
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: t.hostname, port: t.port, method: req.method, path: req.url, headers: { ...req.headers, host: t.host } },
      (up) => {
        const headers = { ...up.headers };
        if (headers["content-security-policy"]) headers["content-security-policy"] = allowFraming(headers["content-security-policy"], allowOrigins);
        delete headers["x-frame-options"];
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`viewer upstream error: ${e.message}`);
    });
    req.pipe(upstream);
  });
  // WebSocket and other upgrades: raw TCP splice after replaying the request head.
  server.on("upgrade", (req, socket, head) => {
    const up = net.connect(Number(t.port), t.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === "host" ? t.host : req.rawHeaders[i + 1]}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const close = () => {
      up.destroy();
      socket.destroy();
    };
    up.on("error", close);
    socket.on("error", close);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}
