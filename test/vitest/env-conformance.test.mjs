// pi-durable ExecutionEnv conformance suite against the real sandbox (TEST-F03-0). Online only.
//
// Cua Space (default):
//   npx vitest run test/vitest/env-conformance.test.mjs        (or: npm run test:env)
// Sprite (needs the real Sprite; this file sets TARSBOT_NO_DOTENV, so .env is NOT read -> export it yourself):
//   set -a; . ./.env; set +a; TARSBOT_SANDBOX=sprites npm run test:env
//   (requires SPRITES_TOKEN and TARSBOT_SPRITE_NAME; each case works in its own /tmp/conf-* dir and removes it)
//
// `npm test` (node --test) also globs this file; it is a no-op outside vitest.
if (process.env.VITEST) {
  process.env.TARSBOT_NO_DOTENV ??= "1";
  const { describe, expect, it, vi } = await import("vitest");
  const { registerEnvConformance } = await import("@earendil-works/pi-durable/testing");
  const { randomBytes } = await import("node:crypto");
  const { config } = await import("../../src/config.mjs");
  const { CuaEnv, shellQuote } = await import("../../src/env.mjs");
  // Only the selected sandbox's module is loaded (sprites mode must never import space.mjs / @trycua/cua).
  const sprites = config.sandbox === "sprites";
  const bash = sprites
    ? (await import("../../src/sandbox/sprites.mjs")).spritesBash
    : (await import("../../src/space.mjs")).spaceBash;

  // Every Sprite exec costs ~0.8-1 s (WebSocket connect + the 0.1 s start delay); several cases run 5+ commands.
  if (sprites) vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

  registerEnvConformance({ describe, expect, it }, sprites ? "CuaEnv (sprites)" : "CuaEnv", async (use) => {
    const dir = `/tmp/conf-${randomBytes(6).toString("hex")}`;
    const made = await bash(`mkdir -p ${shellQuote([dir])}`);
    if (made.exitCode !== 0) throw new Error(`cannot create ${dir}: ${made.stderr}`);
    const env = new CuaEnv({ cwd: dir, bash, home: config.home });
    try {
      await use(env);
    } finally {
      await env.cleanup({});
      await bash(`rm -rf ${shellQuote([dir])}`);
    }
  });
}
