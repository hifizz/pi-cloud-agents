// GET /api/space — where the Bot's computer lives.
//   cua:     { sandbox: "cua", name, viewerUrl, directViewerUrl, info } — the UI embeds viewerUrl, served by a loopback
//            proxy that relaxes spacesd's `frame-ancestors 'none'`.
//   sprites: { sandbox: "sprites", name } — no desktop, no viewer proxy.
// The Cua stack (@trycua/cua, space.mjs, viewer-proxy.mjs) is imported lazily and only in cua mode, so sprites mode
// never needs docker / OrbStack (nor loads the Cua SDK).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.mjs";

const run = promisify(execFile);
const PROXY_PORT = Number(process.env.TARSBOT_VIEWER_PORT ?? 3309);
let proxy = null;

/** Base URL of the real cua-spacesd (without /viewer/). */
async function spacesdBase({ getSpaceConfig }) {
  const cfg = getSpaceConfig();
  if (cfg.url) return cfg.url.replace(/\/+$/, "");
  // SDK-created container: spacesd :3211 is published on a random loopback port.
  const { stdout } = await run("docker", ["port", cfg.name, "3211/tcp"]);
  const line = stdout.split("\n").find((l) => l.startsWith("127.0.0.1:")) ?? stdout.split("\n")[0];
  return `http://127.0.0.1:${line.trim().split(":").pop()}`;
}

async function ensureProxy(target, { startViewerProxy }) {
  if (proxy?.target === target) return proxy.url;
  if (proxy) proxy.server.close();
  const origins = [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, "http://127.0.0.1:5183", "http://localhost:5183"];
  const started = await startViewerProxy({ target, port: PROXY_PORT, allowOrigins: origins });
  proxy = { ...started, target };
  return started.url;
}

const loadCuaStack = () =>
  Promise.all([import("@trycua/cua"), import("../space.mjs"), import("../viewer-proxy.mjs")]).then(
    ([sdk, space, vp]) => ({ ...sdk, ...space, startViewerProxy: vp.startViewerProxy }),
  );

/**
 * Production calls register(app) and uses config.sandbox. The options are a test hook:
 * @param {{ sandbox?: "cua" | "sprites", loadCua?: () => Promise<object> }} [opts]
 */
export function register(app, { sandbox = config.sandbox, loadCua = loadCuaStack } = {}) {
  if (sandbox === "sprites") {
    app.get("/api/space", async () => (await import("../sandbox/sprites.mjs")).getSpriteInfo());
    return;
  }
  registerCua(app, loadCua);
}

function registerCua(app, loadCua) {
  let link = null; // { url, expiresAt }
  let cua = null; // lazily loaded Cua stack
  const load = () => (cua ??= loadCua());

  async function mintViewerLink(base, { embedded, ViewerOptions, getSpaceConfig }) {
    if (link && link.base === base && link.expiresAt - Date.now() > 10 * 60_000) return link.url;
    const cfg = getSpaceConfig();
    const sb = await embedded().sandboxes().connectUrl(base, cfg.token, cfg.name);
    const v = await sb.viewerUrl(ViewerOptions.create({ ttlSeconds: 86400, viewOnly: false }));
    link = { base, url: v.url, expiresAt: Number(v.expiresAtUnix) * 1000 };
    return v.url;
  }

  app.get("/api/space", async () => {
    const cuaStack = await load();
    const { getSpace, getSpaceConfig, getSpaceInfo } = cuaStack;
    await getSpace();
    const name = getSpaceConfig().name;
    try {
      const base = await spacesdBase(cuaStack);
      const proxied = await ensureProxy(base, cuaStack);
      let viewerUrl = `${proxied}/viewer/`;
      let ticketError;
      try {
        // Signed link (ticket in the #fragment, never the token); point it at the framing proxy.
        const signed = new URL(await mintViewerLink(base, cuaStack));
        const p = new URL(proxied);
        signed.protocol = p.protocol;
        signed.host = p.host;
        viewerUrl = signed.toString();
      } catch (e) {
        ticketError = String(e.message ?? e).split("\n")[0];
      }
      return { sandbox: "cua", name, viewerUrl, directViewerUrl: `${base}/viewer/`, info: getSpaceInfo(), ...(ticketError ? { ticketError } : {}) };
    } catch (e) {
      return { sandbox: "cua", name, viewerUrl: null, info: getSpaceInfo(), error: String(e.message ?? e) };
    }
  });
}
