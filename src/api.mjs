// HTTP + WebSocket API (spec I01). Node `http` + `ws`, hand-written minimal router.
// SECURITY: this file itself does no authentication. Authentication is a route plugin (src/routes/auth.mjs) that
// installs a global guard via `app.guard(fn)`; without it (e.g. bare createApi in tests) the API is open, so only bind
// such a server to 127.0.0.1.
//
// Route plugins: `routes` is an array of `register(app)` functions (or modules exporting `register`), called after the
// built-in routes. `app` offers get/post/ws/guard, and `app.ctx = {harness, bots, ...extraCtx}` (workspaces, github, control, checkpoints, rebuild, runtimeBash: injected by server.mjs).
// `app.guard(fn)`: fn(req, {kind: "http" | "ws", path}) may be async; it returns normally to allow, or throws
// HttpError (HTTP: JSON error with that status; WS: 401 and the socket is destroyed). HTTP guards run before route
// matching for every /api/* request; WS guards run on every upgrade. Static files are never guarded.
//
// Bot "busy"/"queued" come from the Bot's conversation view state (`conv.viewState()`):
//   busy   = docs["pi.live"].run is present  (a run is active, see LiveState.run)
//   queued = docs["pi.inbox"].items.length   (submissions waiting for a boundary)
import { createServer } from "node:http";
import { existsSync, statSync, createReadStream } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { watchEvents, ConversationBusy } from "@earendil-works/pi-durable";
import { config } from "./config.mjs";
import { ctx } from "./harness.mjs";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const MAX_BODY = 4 * 1024 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** JSON.stringify that survives bigint: safe-range bigints become numbers, larger ones strings. */
export function toJson(value) {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v !== "bigint") return v;
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  });
}

function compilePath(path) {
  const keys = [];
  const src = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { re: new RegExp(`^${src}/?$`), keys };
}

function matchRoute(list, path) {
  for (const r of list) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch {
        params[k] = m[i + 1];
      }
    });
    return { route: r, params };
  }
  return undefined;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function send(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = toJson(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

/**
 * @param {{ harness: any, bots: any, routes?: Array<Function | {register: Function}>, staticDir?: string, extraCtx?: object }} opts
 */
export function createApi({ harness, bots, routes = [], staticDir, extraCtx = {} } = {}) {
  const httpRoutes = [];
  const wsRoutes = [];
  const sockets = new Set();
  const guards = [];

  const app = {
    guard: (fn) => {
      if (typeof fn !== "function") throw new Error("guard must be a function");
      guards.push(fn);
    },
    ctx: { ...extraCtx, harness, bots },
    get: (path, handler) => httpRoutes.push({ method: "GET", ...compilePath(path), handler }),
    post: (path, handler) => httpRoutes.push({ method: "POST", ...compilePath(path), handler }),
    ws: (path, handler) => wsRoutes.push({ ...compilePath(path), handler }),
  };

  // ---- helpers ----
  function botOr404(id) {
    const bot = bots.get(id);
    if (!bot) throw new HttpError(404, `bot not found: ${id}`);
    return bot;
  }
  async function convOf(bot) {
    const conv = await bots.conversation(bot.id);
    if (!conv) throw new HttpError(404, `conversation not found for bot: ${bot.name}`);
    return conv;
  }
  function objectBody(body) {
    if (body === undefined) return {};
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
    return body;
  }
  function optString(obj, key) {
    const v = obj[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
    return v;
  }
  /** Read live/inbox/usage docs from a conversation's view state. */
  async function viewDocs(conv) {
    const view = await conv.viewState(ctx);
    try {
      const docs = view.value?.docs ?? {};
      return { live: docs["pi.live"], inbox: docs["pi.inbox"], usage: docs["pi.usage"] };
    } finally {
      view.dispose();
    }
  }
  const emptyUsage = () => ({ models: {}, tools: {} });

  // ---- built-in routes ----
  app.get("/api/health", () => ({ ok: true }));

  app.get("/api/bots", async () => {
    const out = [];
    for (const bot of bots.list()) {
      const conv = await bots.conversation(bot.id);
      let busy = false;
      let queued = 0;
      if (conv) {
        const { live, inbox } = await viewDocs(conv);
        busy = live?.run != null;
        queued = inbox?.items?.length ?? 0;
      }
      out.push({ ...bot, busy, queued });
    }
    return out;
  });

  app.post("/api/bots/:id/input", async (_req, _res, { params, body }) => {
    const bot = botOr404(params.id);
    const b = objectBody(body);
    const text = optString(b, "text");
    if (!text || !text.trim()) throw new HttpError(400, "text is required");
    const whenBusy = optString(b, "whenBusy");
    if (whenBusy !== undefined && !["steer", "followUp", "reject"].includes(whenBusy)) {
      throw new HttpError(400, "whenBusy must be steer, followUp or reject");
    }
    const requestId = optString(b, "requestId");
    const conv = await convOf(bot);
    try {
      const sub = await conv.submit(
        { type: "input", content: text, ...(whenBusy ? { whenBusy } : {}), ...(requestId ? { requestId } : {}) },
        ctx,
      );
      return { submissionId: sub.id };
    } catch (e) {
      if (e instanceof ConversationBusy || e?.name === "ConversationBusy") throw new HttpError(409, "bot is busy");
      throw e;
    }
  });

  app.post("/api/bots/:id/abort", async (_req, _res, { params, body }) => {
    const bot = botOr404(params.id);
    const b = objectBody(body);
    const conv = await convOf(bot);
    await conv.abort(ctx, b.background ? { background: true } : undefined);
    return { ok: true };
  });

  app.post("/api/bots/:id/compact", async (_req, _res, { params, body }) => {
    const bot = botOr404(params.id);
    const instructions = optString(objectBody(body), "instructions");
    const conv = await convOf(bot);
    const taskId = await conv.compact(instructions, ctx);
    return { taskId };
  });

  app.post("/api/bots/:id/reset", async (_req, _res, { params, body }) => {
    const bot = botOr404(params.id);
    const note = optString(objectBody(body), "note");
    const conv = await convOf(bot);
    await conv.reset(note, ctx);
    return { ok: true };
  });

  // Active transcript, oldest first. `limit` newest entries (default 100, max 1000).
  app.get("/api/bots/:id/entries", async (_req, _res, { params, query }) => {
    const bot = botOr404(params.id);
    const raw = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isInteger(raw) || raw < 1) throw new HttpError(400, "limit must be a positive integer");
    const conv = await convOf(bot);
    const page = await conv.entries({}, Math.min(raw, 1000), undefined, ctx);
    return [...page.items].reverse();
  });

  app.get("/api/usage", async () => {
    const total = await harness.usage(ctx);
    const perBot = [];
    for (const bot of bots.list()) {
      const conv = await bots.conversation(bot.id);
      const usage = conv ? ((await viewDocs(conv)).usage ?? emptyUsage()) : emptyUsage();
      perBot.push({ id: bot.id, name: bot.name, usage });
    }
    return { total, bots: perBot };
  });

  app.ws("/api/bots/:id/stream", async (socket, { params }) => {
    const bot = bots.get(params.id);
    if (!bot) {
      socket.close(4404, "bot not found");
      return;
    }
    let stream;
    let closed = false;
    const stop = async () => {
      if (closed) return;
      closed = true;
      try {
        await stream?.stop();
      } catch {
        // already stopped
      }
    };
    socket.on("close", () => void stop());
    socket.on("error", () => void stop());
    const sendFrame = (frame) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > 32 * 1024 * 1024) {
        socket.close(1013, "client too slow");
        return;
      }
      socket.send(toJson(frame));
    };
    try {
      stream = await watchEvents(harness, bot.conversationId, ctx);
      if (closed || socket.readyState !== socket.OPEN) return void (await stop());
      sendFrame({ type: "snapshot", ...stream.snapshot });
      stream.start(async (events) => sendFrame({ type: "events", events }));
    } catch (e) {
      sendFrame({ type: "error", error: String(e?.message ?? e) });
      socket.close(1011, "stream failed");
      await stop();
    }
  });

  // ---- plugins ----
  for (const r of routes) {
    const register = typeof r === "function" ? r : r?.register;
    if (typeof register !== "function") throw new Error("routes entries must be register(app) functions");
    register(app);
  }

  // ---- static files ----
  const staticRoot = staticDir && existsSync(staticDir) ? resolve(staticDir) : undefined;
  function serveStatic(req, res, pathname) {
    if (!staticRoot || (req.method !== "GET" && req.method !== "HEAD")) return false;
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    let file = normalize(join(staticRoot, rel));
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) return false;
    const isFile = (p) => existsSync(p) && statSync(p).isFile();
    if (!isFile(file)) {
      // Missing asset requests stay 404; other unknown paths fall back to the SPA shell.
      if (extname(rel) && rel !== "/") return false;
      file = join(staticRoot, "index.html");
      if (!isFile(file)) return false;
    }
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") return void res.end(), true;
    createReadStream(file).pipe(res);
    return true;
  }

  // ---- server ----
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (guards.length && path.startsWith("/api/")) {
        for (const g of guards) await g(req, { kind: "http", path });
      }
      const hit = matchRoute(
        httpRoutes.filter((r) => r.method === req.method),
        path,
      );
      if (hit) {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const query = Object.fromEntries(url.searchParams);
        const result = await hit.route.handler(req, res, { params: hit.params, body, query });
        if (!res.writableEnded && !res.headersSent) send(res, 200, result === undefined ? { ok: true } : result);
        return;
      }
      if (path.startsWith("/api/")) {
        const other = httpRoutes.some((r) => r.re.test(path));
        throw new HttpError(other ? 405 : 404, other ? "method not allowed" : `not found: ${path}`);
      }
      if (serveStatic(req, res, path)) return;
      throw new HttpError(404, `not found: ${path}`);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error("api error:", e?.stack ?? e);
      send(res, 500, { error: String(e?.message ?? e) });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const refuse = (socket, line) => {
    socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (guards.length) {
      try {
        for (const g of guards) await g(req, { kind: "ws", path: url.pathname });
      } catch {
        return refuse(socket, "401 Unauthorized");
      }
    }
    const hit = matchRoute(wsRoutes, url.pathname);
    if (!hit) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      Promise.resolve(hit.route.handler(ws, { params: hit.params, query: Object.fromEntries(url.searchParams), req })).catch((e) => {
        console.error("ws error:", e?.stack ?? e);
        ws.close(1011, "internal error");
      });
    });
  });

  return {
    server,
    app,
    listen(port = config.port, host = "127.0.0.1") {
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolveListen({ port: server.address().port });
        });
      });
    },
    close() {
      return new Promise((resolveClose) => {
        for (const ws of sockets) ws.terminate();
        wss.close();
        if (!server.listening) return resolveClose();
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}
