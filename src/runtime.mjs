// Production composition: which extensions and environment the Harness gets.
// Single integration point — later tasks add their extensions HERE (and only here).
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness } from "./harness.mjs";
import { config } from "./config.mjs";
import { Preamble } from "./ext/preamble.mjs";
import { Search } from "./ext/search.mjs";
import { History } from "./ext/history.mjs";
import { Routines } from "./ext/routines.mjs";
import { Codemode } from "./ext/codemode.mjs";
import { Approval } from "./ext/approval.mjs";
import { Timing } from "./ext/timing.mjs";
import { Exec } from "./ext/exec.mjs";
import { createWorkspaceEnv } from "./workspace-env.mjs";

/**
 * Extensions installed in production, in order. `Exec` comes after CodingTools so its `bash` replaces the built-in one
 * (runner-backed, replay-safe). Approval last (before Timing) so its hook sees every tool — including nested calls a
 * `codemode` script makes (they run the same ToolTask hooks; the hook sees the caller in `call.parent`).
 */
export async function productionExtensions() {
  // Timing after Approval: its beforeTool runs once a verdict exists, so approval wait is not counted.
  const extensions = [Preamble, CodingTools, Exec, Search, History, Routines];
  if (config.codemode) extensions.push(Codemode);
  extensions.push(Approval, Timing);
  return extensions;
}

/** Production ExecutionEnv factory: read/write/edit run inside the conversation's workspace Sprite. */
export function productionEnv({ store, providers }) {
  return createWorkspaceEnv({ store, providers });
}

/**
 * @param {object} overrides  openHarness options; `store` + `providers` are required unless `env` is given.
 *   `resume: false` opens the harness without scheduling (the server resumes it after the workspace service is up).
 */
export async function bootstrap(overrides = {}) {
  const { store, providers, ...rest } = overrides;
  const extensions = rest.extensions ?? (await productionExtensions());
  const env = rest.env ?? productionEnv({ store, providers });
  return openHarness({ ...rest, extensions, env });
}
