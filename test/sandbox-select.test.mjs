// loadSandbox: only known sandboxes load; sprites resolves offline (importing sprites.mjs makes no network call).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TARSBOT_NO_DOTENV ??= "1";
const { SANDBOXES, loadSandbox } = await import("../src/sandbox/index.mjs");

test("SANDBOXES lists sprites, e2b and instabox", () => {
  assert.deepEqual(SANDBOXES, ["sprites", "e2b", "instabox"]);
});

test("loadSandbox rejects unknown kinds without importing anything", async () => {
  for (const kind of ["docker", "", "../config", "sprites.mjs"]) {
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

test("loadSandbox('instabox') resolves offline (import makes no network call) and is cached", async () => {
  const a = await loadSandbox("instabox");
  assert.equal(typeof a.bash, "function");
  assert.equal(typeof a.info, "function");
  assert.deepEqual(a.info(), { sandbox: "instabox", name: "pi-cloud-agents" });
  assert.equal(await loadSandbox("instabox"), a);
});
