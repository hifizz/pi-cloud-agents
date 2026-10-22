// Harness factory. Everything durable is opened here; dependencies are injectable for tests.
import { mkdirSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { config } from "./config.mjs";

export const ctx = BACKGROUND_CONTEXT;

export const defaultSettings = {
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 },
  progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
  retry: { maxRetries: 3 },
  stream: { timeoutMs: 180_000 },
};

/**
 * @param {object} [opts]
 * @param {import("@earendil-works/pi-durable").Storage} [opts.storage] default: SQLite at config.dbPath
 * @param {any} [opts.models] pi-ai Models; default: TokenRouter
 * @param {any[]} [opts.extensions] extensions to install, in order
 * @param {Function} [opts.env] ExecutionEnv factory
 * @param {object} [opts.settings]
 * @param {boolean} [opts.resume] start the scheduler (default true)
 * @param {() => number} [opts.now] Harness clock (default Date.now); durable sleeps store deadlines on it
 * @param {import("@earendil-works/pi-durable").SetTimer} [opts.setTimer] Harness timers (default setTimeout); tests pass a fake clock
 */
export async function openHarness(opts = {}) {
  let storage = opts.storage;
  if (!storage) {
    mkdirSync(config.dataDir, { recursive: true });
    storage = await openNodeSqliteStorage(config.dbPath);
  }
  let models = opts.models;
  if (!models) {
    const { createTarsModels } = await import("./models.mjs");
    models = createTarsModels();
  }
  const registry = createRegistry();
  for (const ext of opts.extensions ?? []) registry.install(ext);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
      settings: { ...defaultSettings, ...(opts.settings ?? {}) },
    },
    ctx,
  );
  if (opts.resume !== false) harness.resume();
  return { harness, registry, models };
}
