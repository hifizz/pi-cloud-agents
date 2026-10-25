// Shared helper for skills / jobs / fetch tools: run one command in the sandbox and collect its stdout text.
// Reuses the same ExecutionEnv the coding tools get (api.env), with bounded collection.
import { err, ok } from "@earendil-works/pi-durable/env";

/** @typedef {import("@earendil-works/pi-durable/env").ExecutionEnv} ExecutionEnv */

/** Collect stdout (+stderr) of one command, up to `maxChars}; @returns {Promise<import("@earendil-works/chord").Result<string, any>>} */
export async function runCapture(env, command, context, { maxChars = 20000 } = {}) {
  if (!env) return err(new Error("no execution environment"));
  let text = "";
  const r = await env.exec(
    command,
    {
      onOutput: (chunk) => {
        if (text.length < maxChars) text += chunk;
      },
    },
    context ?? {},
  );
  if (!r.ok) return err(r.error);
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…[truncated]`;
  return ok(text);
}
