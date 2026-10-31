import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpritesBash } from "../src/sandbox/sprites.mjs";

test("per-call env overlay strips injected GH_TOKEN; caller env merges", async () => {
  const spawned = [];
  const client = {
    sprite: () => ({
      spawn: (file, argv, opts) => {
        spawned.push({ file, argv, env: opts?.env });
        const handlers = {};
        const cmd = {
          stdin: { end() {} },
          stdout: { on: (e, f) => (handlers[e] = f) },
          stderr: { on: (e, f) => (handlers[`e_${e}`] = f) },
          on: (e, f) => (handlers[e] = f),
          kill() {},
          close() {},
        };
        setImmediate(() => {
          handlers.spawn?.();
          handlers.data?.(Buffer.from("out"));
          handlers[`e_data`]?.(Buffer.from(""));
          handlers.end?.();
          handlers[`e_end`]?.();
          handlers.exit?.(0);
        });
        return cmd;
      },
    }),
  };
  const bash = createSpritesBash({ client, name: "s1", env: { GH_TOKEN: "secret-tok", OTHER: "keep" } });
  assert.equal(bash.supportsEnv, true);
  await bash("echo hi", { env: { GH_TOKEN: "" } });
  assert.equal(spawned[0].env.GH_TOKEN, "", "per-call empty value strips the injected token");
  assert.equal(spawned[0].env.OTHER, "keep", "other env untouched");
  // No per-call env -> base env intact (routine sessions unchanged)
  await bash("echo hi");
  assert.equal(spawned[1].env.GH_TOKEN, "secret-tok");
  // Caller env merges over overlay
  await bash("echo hi", { env: { GH_TOKEN: "", EXTRA: "1" } });
  assert.equal(spawned[2].env.EXTRA, "1");
});

// Full-chain: provider.bash(runtimeId, {env:{GH_TOKEN:""}}) produces spawn env WITHOUT the token value;
// a normal session's bash(runtimeId) keeps it. Proves the assembled seam, not just the primitive.
import { createSpritesProvider } from "../src/providers/sprites.mjs";

test("assembled: provider.bash per-call env strips GH_TOKEN for loop sessions; routine bash keeps it", async () => {
  const spawned = [];
  const fakeClient = {
    getSprite: async () => null,
    createSprite: async () => {},
    use: async () => {},
    listSprites: async () => [],
    deleteSprite: async () => {},
    sprite: () => ({
      spawn: (file, argv, opts) => {
        spawned.push(opts?.env);
        const handlers = {};
        const cmd = {
          stdin: { end() {} },
          stdout: { on: (e, f) => (handlers[e] = f) },
          stderr: { on: (e, f) => (handlers[`e_${e}`] = f) },
          on: (e, f) => (handlers[e] = f),
          kill() {},
          close() {},
        };
        setImmediate(() => { handlers.spawn?.(); handlers.data?.(Buffer.from("x")); handlers[`e_data`]?.(Buffer.from("")); handlers.end?.(); handlers[`e_end`]?.(); handlers.exit?.(0); });
        return cmd;
      },
    }),
  };
  const provider = createSpritesProvider({ client: fakeClient, secrets: [], ghToken: "real-token", log: () => {} });
  // Loop session path (server passes the strip overlay)
  const loopBash = provider.bash("spr-1", { env: { GH_TOKEN: "" } });
  await loopBash("echo hi");
  assert.equal(spawned[0].GH_TOKEN, "", "loop session spawn env has GH_TOKEN stripped");
  // Routine session path — unchanged
  const normalBash = provider.bash("spr-1");
  await normalBash("echo hi");
  assert.equal(spawned[1].GH_TOKEN, "real-token", "normal session keeps the injected token");
});
