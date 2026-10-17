// loadSandbox: only known sandboxes load; sprites resolves offline (importing sprites.mjs makes no network call).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TARSBOT_NO_DOTENV ??= "1";
const { SANDBOXES, loadSandbox } = await import("../src/sandbox/index.mjs");
const { sandboxSettings } = await import("../src/config.mjs");

test("SANDBOXES lists sprites, e2b and instabox (sprites first = default)", () => {
  assert.deepEqual(SANDBOXES, ["sprites", "e2b", "instabox"]);
});

test("loadSandbox rejects unknown kinds without importing anything", async () => {
  for (const kind of ["docker", "", "../config", "sprites.mjs", "instabox.mjs"]) {
    await assert.rejects(loadSandbox(kind), /Unknown sandbox .*expected one of: sprites, e2b, instabox/);
  }
});

test("loadSandbox('sprites') returns bash/info and is cached", async () => {
  const a = await loadSandbox("sprites");
  assert.equal(typeof a.bash, "function");
  assert.equal(typeof a.info, "function");
  assert.equal(a.info().sandbox, "sprites");
  assert.equal(await loadSandbox("sprites"), a);
});

test("sandboxSettings(instabox): defaults and overrides; the Sprite name is ignored", () => {
  const base = { sandbox: "instabox", spriteName: undefined };
  assert.deepEqual(sandboxSettings({ TARSBOT_SANDBOX: "instabox" }), {
    ...base,
    sandboxName: "pi-cloud-agents",
    home: "/data/home",
    spaceCwd: "/data/home/workspace",
  });
  assert.deepEqual(
    sandboxSettings({ TARSBOT_SANDBOX: "instabox", TARSBOT_INSTABOX_NAME: "mine", TARSBOT_INSTABOX_HOME: "/home/dev", TARSBOT_SPRITE_NAME: "ignored" }),
    { ...base, sandboxName: "mine", home: "/home/dev", spaceCwd: "/home/dev/workspace" },
  );
});
