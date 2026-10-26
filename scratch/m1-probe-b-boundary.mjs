// M1-00 B4 supplement: local-only worst-case URL encoding. No token or network needed.
// TARSBOT_NO_DOTENV=1 node scratch/m1-probe-b-boundary.mjs
import assert from "node:assert/strict";
import { createSpritesBash, MAX_EXEC_QUERY_CHARS } from "../src/sandbox/sprites.mjs";
const q = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;
const results = [];
for (const rawBytes of [12 * 1024, 20 * 1024, 40 * 1024]) {
  const command = `printf %s ${q(Buffer.alloc(rawBytes, 255).toString("base64"))} | base64 -d | sha256sum`;
  let reachedSpawn = false;
  const bash = createSpritesBash({
    name: "pca-probe-local-only",
    client: { sprite() { return { spawn() { reachedSpawn = true; throw new Error("LOCAL_SENTINEL_NO_NETWORK"); } }; } },
    retryDelayMs: 0,
  });
  let error;
  try { await bash(command); } catch (e) { error = { code: e.code, message: e.message }; }
  if (rawBytes === 12 * 1024) assert.equal(reachedSpawn, true);
  else { assert.equal(reachedSpawn, false); assert.equal(error.code, "SPRITES_COMMAND_TOO_LARGE"); }
  results.push({ rawBytes, base64Chars: Math.ceil(rawBytes / 3) * 4, limit: MAX_EXEC_QUERY_CHARS, reachedSpawn, error });
}
console.log(JSON.stringify({ result: "PASS", cases: results }, null, 2));
