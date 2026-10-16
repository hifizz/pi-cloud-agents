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

/**
 * Sandbox settings. Sprites (Fly.io) is the only sandbox; TARSBOT_SANDBOX is ignored.
 * Pure: `config` below feeds it `process.env`.
 */
export function sandboxSettings(vars = process.env) {
  const home = "/home/sprite";
  return {
    sandbox: "sprites",
    spriteName: vars.TARSBOT_SPRITE_NAME || undefined,
    home,
    spaceCwd: `${home}/workspace`,
  };
}

export const config = {
  ...sandboxSettings(),
  port: Number(process.env.TARSBOT_PORT ?? 8090),
  host: process.env.TARSBOT_HOST ?? "127.0.0.1",
  dataDir: resolve(ROOT, process.env.TARSBOT_DATA_DIR ?? "data"),
  get dbPath() {
    return resolve(this.dataDir, "alice.sqlite");
  },
  get botsPath() {
    return resolve(this.dataDir, "bots.json");
  },
  provider: "tokenrouter",
  defaultModelId: process.env.TARSBOT_MODEL ?? "glm-5.3-flash",
};

export const defaultModel = () => ({ provider: config.provider, modelId: config.defaultModelId });
