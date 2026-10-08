// pi-durable ExecutionEnv conformance suite against the real Space (TEST-F03-0).
// Run with: npx vitest run test/vitest/env-conformance.test.mjs
// `npm test` (node --test) also globs this file; it is a no-op outside vitest.
if (process.env.VITEST) {
  process.env.TARSBOT_NO_DOTENV ??= "1";
  const { describe, expect, it } = await import("vitest");
  const { registerEnvConformance } = await import("@earendil-works/pi-durable/testing");
  const { randomBytes } = await import("node:crypto");
  const { CuaEnv, shellQuote } = await import("../../src/env.mjs");
  const { spaceBash } = await import("../../src/space.mjs");

  registerEnvConformance({ describe, expect, it }, "CuaEnv", async (use) => {
    const dir = `/tmp/conf-${randomBytes(6).toString("hex")}`;
    const made = await spaceBash(`mkdir -p ${shellQuote([dir])}`);
    if (made.exitCode !== 0) throw new Error(`cannot create ${dir}: ${made.stderr}`);
    const env = new CuaEnv({ cwd: dir });
    try {
      await use(env);
    } finally {
      await env.cleanup({});
      await spaceBash(`rm -rf ${shellQuote([dir])}`);
    }
  });
}
