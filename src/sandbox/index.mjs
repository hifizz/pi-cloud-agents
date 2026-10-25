// Sandbox loader: picks the implementation named by TARSBOT_SANDBOX. Each ./<kind>.mjs exports
// `bash(command, {timeoutMs})` and `info()` (see docs/CONTRACTS.md).
import { config } from "../config.mjs";

export const SANDBOXES = ["sprites", "e2b", "instabox"];

const FILES = { sprites: "./sprites.mjs", e2b: "./e2b.mjs", instabox: "./instabox.mjs" };

const cache = new Map();

/** Load (lazily, cached) the sandbox module for `kind`. Only values in SANDBOXES are ever imported. */
export async function loadSandbox(kind = config.sandbox) {
  if (!SANDBOXES.includes(kind)) {
    throw new Error(`Unknown sandbox "${kind}"; expected one of: ${SANDBOXES.join(", ")}`);
  }
  let p = cache.get(kind);
  if (!p) {
    p = import(FILES[kind]).then(({ bash, info }) => ({ bash, info }));
    p.catch(() => cache.delete(kind));
    cache.set(kind, p);
  }
  return p;
}
