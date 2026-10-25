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

/** Selectable sandboxes (TARSBOT_SANDBOX). The first is the default. */
const SANDBOX_KINDS = ["sprites", "e2b", "instabox"];

/**
 * Sandbox settings, chosen by TARSBOT_SANDBOX (unset/empty -> sprites). Pure: `config` below feeds it `process.env`.
 */
export function sandboxSettings(vars = process.env) {
  const sandbox = vars.TARSBOT_SANDBOX || "sprites";
  if (sandbox === "e2b") {
    const home = "/home/user";
    return {
      sandbox,
      sandboxName: vars.TARSBOT_E2B_NAME || "pi-cloud-agents",
      spriteName: undefined,
      home,
      spaceCwd: `${home}/workspace`,
    };
  }
  if (sandbox === "sprites") {
    const home = "/home/sprite";
    const name = vars.TARSBOT_SPRITE_NAME || undefined;
    return { sandbox, sandboxName: name, spriteName: name, home, spaceCwd: `${home}/workspace` };
  }
  if (sandbox === "instabox") {
    const home = "/data/home";
    return {
      sandbox,
      sandboxName: vars.TARSBOT_INSTABOX_NAME || "pi-cloud-agents",
      spriteName: undefined,
      home,
      spaceCwd: `${home}/workspace`,
    };
  }
  throw new Error(`Unknown TARSBOT_SANDBOX "${sandbox}"; expected one of: ${SANDBOX_KINDS.join(", ")}`);
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
  defaultModelId: process.env.TARSBOT_MODEL ?? "swe-2",
};

export const defaultModel = () => ({ provider: config.provider, modelId: config.defaultModelId });
