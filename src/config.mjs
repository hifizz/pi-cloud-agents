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

/** Supported execution environments for the Bot's file/shell tools. */
export const SANDBOXES = ["cua", "sprites"];

/**
 * Sandbox-dependent settings, derived from an env-var bag (pure; `config` below feeds it `process.env`).
 * An unset or empty TARSBOT_SANDBOX means "cua"; any other unknown value throws.
 */
export function sandboxSettings(vars = process.env) {
  const sandbox = vars.TARSBOT_SANDBOX || "cua";
  if (!SANDBOXES.includes(sandbox)) {
    throw new Error(`Invalid TARSBOT_SANDBOX=${JSON.stringify(sandbox)}: expected one of ${SANDBOXES.join(", ")}`);
  }
  const home = sandbox === "sprites" ? "/home/sprite" : "/home/cua";
  return {
    sandbox,
    spriteName: vars.TARSBOT_SPRITE_NAME || undefined,
    home,
    spaceCwd: sandbox === "sprites" ? `${home}/workspace` : `${home}/work`,
  };
}

export const config = {
  ...sandboxSettings(),
  port: Number(process.env.TARSBOT_PORT ?? 8090),
  host: "127.0.0.1",
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
