// GET /api/space → { name, viewerUrl, directViewerUrl, info } — where the desktop viewer lives.
// The UI embeds viewerUrl, served by a loopback proxy that relaxes spacesd's `frame-ancestors 'none'`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { embedded, ViewerOptions } from "@trycua/cua";
import { config } from "../config.mjs";
import { getSpace, getSpaceConfig, getSpaceInfo } from "../space.mjs";
import { startViewerProxy } from "../viewer-proxy.mjs";

const run = promisify(execFile);
const PROXY_PORT = Number(process.env.TARSBOT_VIEWER_PORT ?? 3309);
let proxy = null;

/** Base URL of the real cua-spacesd (without /viewer/). */
async function spacesdBase() {
  const cfg = getSpaceConfig();
  if (cfg.url) return cfg.url.replace(/\/+$/, "");
  // SDK-created container: spacesd :3211 is published on a random loopback port.
  const { stdout } = await run("docker", ["port", cfg.name, "3211/tcp"]);
  const line = stdout.split("\n").find((l) => l.startsWith("127.0.0.1:")) ?? stdout.split("\n")[0];
  return `http://127.0.0.1:${line.trim().split(":").pop()}`;
}

async function ensureProxy(target) {
  if (proxy?.target === target) return proxy.url;
  if (proxy) proxy.server.close();
  const origins = [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, "http://127.0.0.1:5183", "http://localhost:5183"];
  const started = await startViewerProxy({ target, port: PROXY_PORT, allowOrigins: origins });
  proxy = { ...started, target };
  return started.url;
}

export function register(app) {
  let link = null; // { url, expiresAt }
  async function mintViewerLink(base) {
    if (link && link.base === base && link.expiresAt - Date.now() > 10 * 60_000) return link.url;
    const cfg = getSpaceConfig();
    const sb = await embedded().sandboxes().connectUrl(base, cfg.token, cfg.name);
    const v = await sb.viewerUrl(ViewerOptions.create({ ttlSeconds: 86400, viewOnly: false }));
    link = { base, url: v.url, expiresAt: Number(v.expiresAtUnix) * 1000 };
    return v.url;
  }

  app.get("/api/space", async () => {
    await getSpace();
    const name = getSpaceConfig().name;
    try {
      const base = await spacesdBase();
      const proxied = await ensureProxy(base);
      let viewerUrl = `${proxied}/viewer/`;
      let ticketError;
      try {
        // Signed link (ticket in the #fragment, never the token); point it at the framing proxy.
        const signed = new URL(await mintViewerLink(base));
        const p = new URL(proxied);
        signed.protocol = p.protocol;
        signed.host = p.host;
        viewerUrl = signed.toString();
      } catch (e) {
        ticketError = String(e.message ?? e).split("\n")[0];
      }
      return { name, viewerUrl, directViewerUrl: `${base}/viewer/`, info: getSpaceInfo(), ...(ticketError ? { ticketError } : {}) };
    } catch (e) {
      return { name, viewerUrl: null, info: getSpaceInfo(), error: String(e.message ?? e) };
    }
  });
}
