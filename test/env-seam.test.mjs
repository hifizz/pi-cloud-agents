import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createSpritesBash } from "../src/sandbox/sprites.mjs";

const collect = async (stream) => {
  const chunks = [];
  for await (const b of stream) chunks.push(Buffer.from(b));
  return Buffer.concat(chunks).toString("utf8");
};

test("per-call env: secrets never reach the exec URL env; they ride the stdin bootstrap payload", async () => {
  const spawned = [];
  const client = {
    sprite: () => ({
      spawn: (file, argv, opts) => {
        const stdin = new PassThrough();
        spawned.push({ file, argv, env: opts?.env, stdin });
        const handlers = {};
        const cmd = {
          stdin,
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

  // A capability strip (GH_TOKEN="") is still an env VALUE: it rides stdin, never the URL — a stripped
  // token must never smuggle the real one into the exec URL query.
  await bash("echo hi", { env: { GH_TOKEN: "" } });
  assert.equal(spawned[0].env, undefined, "no URL env — every value is secret-grade");
  const p0 = await collect(spawned[0].stdin);
  assert.match(Buffer.from(p0.trim(), "base64").toString("utf8"), /export GH_TOKEN=''/);

  // No per-call env -> the base env still rides stdin (nothing on the URL either).
  await bash("echo hi");
  assert.equal(spawned[1].env, undefined);
  const p1 = await collect(spawned[1].stdin);
  assert.match(Buffer.from(p1.trim(), "base64").toString("utf8"), /export GH_TOKEN='secret-tok'/);

  // Caller env merges over the base; EXTRA travels with it on stdin.
  await bash("echo hi", { env: { GH_TOKEN: "", EXTRA: "1" } });
  const p2 = await collect(spawned[2].stdin);
  const d2 = Buffer.from(p2.trim(), "base64").toString("utf8");
  assert.match(d2, /export EXTRA='1'/);
  assert.match(d2, /export GH_TOKEN=''/);
  assert.ok(!JSON.stringify(spawned.map((s) => s.argv)).includes("secret-tok"), "no secret in any argv");
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
        const stdin = new PassThrough();
        spawned.push({ env: opts?.env, stdin, argv });
        const handlers = {};
        const cmd = {
          stdin,
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
  // Loop session path (server passes the strip overlay) — the strip rides stdin, the token stays out of the URL.
  const loopBash = provider.bash("spr-1", { env: { GH_TOKEN: "" } });
  await loopBash("echo hi");
  assert.equal(spawned[0].env, undefined, "loop strip goes via stdin, not the URL env");
  const lp = await collect(spawned[0].stdin);
  assert.match(Buffer.from(lp.trim(), "base64").toString("utf8"), /export GH_TOKEN=''/);
  // Routine session path — the real token also rides stdin, never the URL.
  const normalBash = provider.bash("spr-1");
  await normalBash("echo hi");
  assert.equal(spawned[1].env, undefined);
  const np = await collect(spawned[1].stdin);
  assert.match(Buffer.from(np.trim(), "base64").toString("utf8"), /export GH_TOKEN='real-token'/);
  assert.ok(!JSON.stringify(spawned.map((s) => s.argv)).includes("real-token"), "token never in argv");
});
