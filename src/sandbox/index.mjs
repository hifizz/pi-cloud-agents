// Sandbox loader: picks the implementation named by TARSBOT_SANDBOX. Each ./<kind>.mjs exports
// `bash(command, {timeoutMs})` and `info()` (see docs/CONTRACTS.md).
import { config } from "../config.mjs";

/** Only the keys of this table are ever imported; the first is the default (see config.sandboxSettings). */
const LOADERS = {
  sprites: () => import("./sprites.mjs"),
  e2b: () => import("./e2b.mjs"),
  instabox: () => import("./instabox.mjs"),
};

export const SANDBOXES = Object.keys(LOADERS);

const cache = new Map();

/** Load (lazily, cached) the sandbox module for `kind`. Only values in SANDBOXES are ever imported. */
export async function loadSandbox(kind = config.sandbox) {
  if (!SANDBOXES.includes(kind)) {
    throw new Error(`Unknown sandbox "${kind}"; expected one of: ${SANDBOXES.join(", ")}`);
  }
  let p = cache.get(kind);
  if (!p) {
    p = LOADERS[kind]().then(({ bash, info }) => ({ bash, info }));
    p.catch(() => cache.delete(kind));
    cache.set(kind, p);
  }
  return p;
}
