// Production composition: which extensions and environment the Harness gets.
// Single integration point — later tasks add their extensions HERE (and only here).
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness } from "./harness.mjs";
import { Preamble } from "./ext/preamble.mjs";
import { Desktop } from "./ext/desktop.mjs";
import { Search } from "./ext/search.mjs";
import { History } from "./ext/history.mjs";
import { Routines } from "./ext/routines.mjs";
import { Approval } from "./ext/approval.mjs";
import { spaceEnv } from "./env.mjs";

/** Extensions installed in production, in order. Approval last so its hook sees every tool. */
export async function productionExtensions() {
  return [Preamble, CodingTools, Desktop, Search, History, Routines, Approval];
}

/** Production ExecutionEnv factory: read/write/edit/bash run inside the Cua Space. */
export async function productionEnv() {
  return spaceEnv();
}

export async function bootstrap(overrides = {}) {
  const extensions = overrides.extensions ?? (await productionExtensions());
  const env = overrides.env ?? (await productionEnv());
  return openHarness({ ...overrides, extensions, env });
}
