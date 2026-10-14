// Production composition: which extensions and environment the Harness gets.
// Single integration point — later tasks add their extensions HERE (and only here).
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness } from "./harness.mjs";
import { Preamble } from "./ext/preamble.mjs";
import { config } from "./config.mjs";
import { Search } from "./ext/search.mjs";
import { History } from "./ext/history.mjs";
import { Routines } from "./ext/routines.mjs";
import { Approval } from "./ext/approval.mjs";
import { Timing } from "./ext/timing.mjs";
import { spaceEnv } from "./env.mjs";

/**
 * Extensions installed in production, in order. Approval last so its hook sees every tool.
 * Desktop (Cua Driver) exists only in `cua` mode and is imported lazily: ext/desktop.mjs pulls in space.mjs and
 * @trycua/cua, which must never load in `sprites` mode (no docker / OrbStack needed).
 */
export async function productionExtensions({ sandbox = config.sandbox } = {}) {
  const desktop = sandbox === "sprites" ? [] : [(await import("./ext/desktop.mjs")).Desktop];
  // Timing after Approval: its beforeTool runs once a verdict exists, so approval wait is not counted.
  return [Preamble, CodingTools, ...desktop, Search, History, Routines, Approval, Timing];
}

/** Production ExecutionEnv factory: read/write/edit/bash run inside the Cua Space (cua) or the Sprite (sprites). */
export async function productionEnv() {
  return spaceEnv();
}

export async function bootstrap(overrides = {}) {
  const extensions = overrides.extensions ?? (await productionExtensions());
  const env = overrides.env ?? (await productionEnv());
  return openHarness({ ...overrides, extensions, env });
}
