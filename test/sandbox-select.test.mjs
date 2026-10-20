// loadSandbox: only known sandboxes load; importing a provider module never makes a network call.
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

test("loadSandbox('instabox') returns bash/info offline and is cached", async () => {
  const a = await loadSandbox("instabox");
  assert.equal(typeof a.bash, "function");
  assert.equal(typeof a.info, "function");
  assert.deepEqual(a.info(), { sandbox: "instabox", name: "pi-cloud-agents" });
  assert.equal(await loadSandbox("instabox"), a);
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
    sandboxSettings({ TARSBOT_SANDBOX: "instabox", TARSBOT_INSTABOX_NAME: "mine", TARSBOT_SPRITE_NAME: "ignored" }),
    { ...base, sandboxName: "mine", home: "/data/home", spaceCwd: "/data/home/workspace" },
  );
});
