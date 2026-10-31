// Central configuration. Secrets come only from the process environment
// (optionally loaded from ./.env); they are never logged.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const envFile = resolve(ROOT, ".env");
if (existsSync(envFile) && !process.env.TARSBOT_NO_DOTENV) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // malformed .env: ignore, variables may still come from the shell
  }
}

export const config = {
  port: Number(process.env.TARSBOT_PORT ?? 8090),
  host: process.env.TARSBOT_HOST ?? "127.0.0.1",
  dataDir: resolve(ROOT, process.env.TARSBOT_DATA_DIR ?? "data"),
  get dbPath() {
    return resolve(this.dataDir, "alice.sqlite");
  },
  get botsPath() {
    return resolve(this.dataDir, "bots.json");
  },
  get controlDbPath() {
    return resolve(this.dataDir, "control.sqlite");
  },
  get checkpointDir() {
    return resolve(this.dataDir, "checkpoints");
  },
  provider: "tokenrouter",
  defaultModelId: process.env.TARSBOT_MODEL ?? "swe-2",
  /** Loops (Issue14): max concurrently running loop runs across the process (FIFO queue above this). */
  loopsMaxConcurrent: Math.max(1, Number(process.env.TARSBOT_LOOPS_MAX_CONCURRENCY ?? 3) || 3),
  loopsGithubPollSec: Math.max(30, Number(process.env.TARSBOT_LOOPS_GH_POLL_SEC ?? 300) || 300),
};

export const defaultModel = () => ({ provider: config.provider, modelId: config.defaultModelId });
