// pi-durable ExecutionEnv conformance suite against the real sandbox (TEST-F03-0). Online only.
//
// Needs the real sandbox; this file sets TARSBOT_NO_DOTENV, so .env is NOT read -> export it yourself:
//   Sprites: set -a; . ./.env; set +a; PCA_TEST_SPRITE=pca-<name> npm run test:env
//     (requires SPRITES_TOKEN and PCA_TEST_SPRITE, which must name an existing managed `pca-*` test Sprite;
//      the suite refuses to run against anything for which provider.isManaged(name) is false)
//   Each case works in its own /tmp/conf-* dir and removes it.
//
// `npm test` (node --test) also globs this file; it is a no-op outside vitest.
if (process.env.VITEST) {
  process.env.TARSBOT_NO_DOTENV ??= "1";
  const { describe, expect, it, vi } = await import("vitest");
  const { registerEnvConformance } = await import("@earendil-works/pi-durable/testing");
  const { randomBytes } = await import("node:crypto");
  const { SandboxEnv, shellQuote } = await import("../../src/env.mjs");
  const { SpritesClient } = await import("@fly/sprites");
  const { createSpritesProvider } = await import("../../src/providers/sprites.mjs");

  const token = process.env.SPRITES_TOKEN;
  const name = process.env.PCA_TEST_SPRITE;
  if (!token) throw new Error("env-conformance: SPRITES_TOKEN is not set");
  if (!name) throw new Error("env-conformance: PCA_TEST_SPRITE is not set (name of a managed pca-* test Sprite)");
  const provider = createSpritesProvider({ client: new SpritesClient(token) });
  if (!provider.isManaged(name)) {
    throw new Error(`env-conformance: refusing to run on ${name}: not a managed pca-* Sprite`);
  }
  const bash = provider.bash(name);

  // Every Sprite exec costs ~0.8-1 s (WebSocket connect + the 0.1 s start delay); several cases run 5+ commands.
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

  registerEnvConformance({ describe, expect, it }, "SandboxEnv (sprites)", async (use) => {
    const dir = `/tmp/conf-${randomBytes(6).toString("hex")}`;
    const made = await bash(`mkdir -p ${shellQuote([dir])}`);
    if (made.exitCode !== 0) throw new Error(`cannot create ${dir}: ${made.stderr}`);
    const env = new SandboxEnv({ cwd: dir, bash, home: "/home/sprite" });
    try {
      await use(env);
    } finally {
      await env.cleanup({});
      await bash(`rm -rf ${shellQuote([dir])}`);
    }
  });
}
