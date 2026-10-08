// Cua Space access (shared by env.mjs and ext/desktop.mjs). One Space per user, shared by all Bots (REQ-ARC-3).
// Connection priority (getSpaceConfig):
//   1. CUA_SPACE_URL (+ CUA_ENV_TOKEN)    -> spaces.add(url, token, name)
//   2. data/space.json {url, token, container} (written by scripts/space-up.sh) -> spaces.add(...)
//   3. otherwise the SDK creates/reuses a local container (modes A/B, no persistent volume)
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { embedded, SpaceCreateOptions } from "@trycua/cua";
import { config } from "./config.mjs";

export const SPACE_HOME = "/home/cua";
const DEFAULT_SDK_NAME = "tarsbot-probe";
const DEFAULT_URL_NAME = "tarsbot-space";
/** Total time withSpace() waits for a restarted Space to accept connections again. */
export const RECONNECT_BUDGET_MS = 60_000;

let spacesApi;
let spaceInfo = null;

const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Where the Space lives. Never logs or returns anything beyond what callers need; `token` must not be printed.
 * @returns {{source: "env"|"file"|"sdk", name: string, url?: string, token?: string, container?: string}}
 */
export function getSpaceConfig({ env = process.env, dataDir = config.dataDir } = {}) {
  if (env.CUA_SPACE_URL) {
    return {
      source: "env",
      url: env.CUA_SPACE_URL,
      token: env.CUA_ENV_TOKEN || undefined,
      container: env.CUA_SPACE_CONTAINER || undefined,
      name: env.CUA_SPACE_NAME || env.CUA_SPACE_CONTAINER || DEFAULT_URL_NAME,
    };
  }
  const file = resolve(dataDir, "space.json");
  if (existsSync(file)) {
    let j;
    try {
      j = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${e.message}); rerun scripts/space-up.sh or delete it`);
    }
    if (!j || typeof j.url !== "string" || !j.url) throw new Error(`${file} has no "url"; rerun scripts/space-up.sh`);
    return {
      source: "file",
      url: j.url,
      token: typeof j.token === "string" && j.token ? j.token : undefined,
      container: typeof j.container === "string" && j.container ? j.container : undefined,
      name: env.CUA_SPACE_NAME || j.container || DEFAULT_URL_NAME,
    };
  }
  return { source: "sdk", name: env.CUA_SPACE_NAME || DEFAULT_SDK_NAME };
}

function safeName() {
  try {
    return getSpaceConfig().name;
  } catch {
    return DEFAULT_URL_NAME;
  }
}

/** Container / Space name (also the docker container name when a container is in use). */
export const SPACE_NAME = safeName();

/** `direct:host:port`, the id spaces.add() assigns to a Space added by URL. */
export function directSpaceId(url) {
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return `direct:${u.hostname}:${port}`;
}

function spaces() {
  spacesApi ??= embedded().spaces();
  return spacesApi;
}

/**
 * Resolve a Space handle for `cfg` using `api` (a `Spaces` object; injectable for tests).
 * `forceAdd` re-runs spaces.add() (handshake, refreshes a stale token) instead of reusing a registered entry.
 * Returns { space, info }.
 */
export async function connectSpace(cfg, { api = spaces(), createOptions = SpaceCreateOptions, forceAdd = false } = {}) {
  if (cfg.source === "sdk") {
    const created = await api.create(createOptions.create({ reuse: true, name: cfg.name, env: new Map(), services: new Map() }));
    return { space: await api.space(created.space.id), info: created.space };
  }
  let info;
  if (!forceAdd) {
    const id = directSpaceId(cfg.url);
    info = (await api.list()).find((s) => s.id === id || (s.provider === "direct" && s.name === cfg.name));
  }
  info ??= await api.add(cfg.url, cfg.token, cfg.name);
  return { space: await api.space(info.id), info };
}

/**
 * Singleton-handle manager around `connectFn(forceAdd) -> Space` (injectable for tests).
 * getSpace(): cached handle. resetSpace(): drop it. withSpace(fn): run fn(space); on failure drop the handle,
 * reconnect (waiting up to `budgetMs` for a restarting Space, exponential backoff 1s..8s) and run fn once more.
 * fn itself is executed at most twice; it is never re-run while the reconnect is still failing.
 */
export function createSpaceManager(connectFn, { budgetMs = RECONNECT_BUDGET_MS, sleepFn = sleep, onRetry = () => {} } = {}) {
  let promise = null;
  const open = (forceAdd) => {
    const p = connectFn(forceAdd).catch((e) => {
      if (promise === p) promise = null;
      throw e;
    });
    promise = p;
    return p;
  };
  const getSpace = () => promise ?? open(false);
  const resetSpace = () => {
    promise = null;
  };
  async function reconnect() {
    const deadline = Date.now() + budgetMs;
    let delay = 1000;
    for (;;) {
      try {
        return await open(true);
      } catch (e) {
        if (Date.now() + delay >= deadline) throw e;
        await sleepFn(delay);
        delay = Math.min(delay * 2, 8000);
      }
    }
  }
  async function withSpace(fn) {
    try {
      return await fn(await getSpace());
    } catch (e) {
      onRetry(e);
      resetSpace();
      return fn(await reconnect());
    }
  }
  return { getSpace, resetSpace, withSpace };
}

async function connect(forceAdd) {
  const { space, info } = await connectSpace(getSpaceConfig(), { forceAdd });
  spaceInfo = jsonSafe(info);
  return space;
}

const manager = createSpaceManager(connect, {
  // Error messages only (no tokens); shows up in the server log as evidence of a Space reconnect.
  onRetry: (e) => console.warn(`[space] call failed, reconnecting: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`),
});

/** Singleton Space handle. */
export const getSpace = manager.getSpace;
/** Drop the cached handle (e.g. after a container restart); next getSpace() reconnects. */
export const resetSpace = manager.resetSpace;
/** Run fn(space); on failure reconnect (up to RECONNECT_BUDGET_MS) and retry once. */
export const withSpace = manager.withSpace;

export function getSpaceInfo() {
  return spaceInfo;
}

/**
 * Call a Cua Driver tool. Returns { isError, text, content: McpContent[], structured }.
 * content items: { type:"text", text } | { type:"image", data(base64), mimeType }.
 */
export async function callDriver(tool, args = {}, { space, timeoutMs } = {}) {
  const run = async (sp) => sp.callTool(tool, JSON.stringify(args), "driver", timeoutMs === undefined ? undefined : BigInt(timeoutMs));
  const raw = space ? await run(space) : await withSpace(run);
  const parse = (s) => {
    if (s === undefined || s === null || s === "") return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  return {
    isError: Boolean(raw.isError),
    text: raw.text ?? "",
    content: parse(raw.contentJson) ?? [],
    structured: parse(raw.structuredJson),
  };
}

/** Run a shell command in the Space. Returns { stdout, stderr, exitCode, timedOut }. */
export async function spaceBash(command, { timeoutMs } = {}) {
  const r = await withSpace((sp) => sp.bash(command, timeoutMs === undefined ? undefined : BigInt(timeoutMs)));
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode, timedOut: Boolean(r.timedOut) };
}
