// Offline sanity checks for the WP5 scripts (the real crash tests need docker + a model: scripts/kill-test.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = ["space-up.sh", "space-down.sh", "kill-test.sh"].map((f) => join(root, "scripts", f));

test("WP5 scripts are executable and parse with bash -n", () => {
  for (const file of scripts) {
    accessSync(file, constants.X_OK);
    execFileSync("bash", ["-n", file]);
  }
});

test("space-up.sh: persistent volume, loopback-only port, restart policy, token never echoed or put on argv", () => {
  const src = readFileSync(scripts[0], "utf8");
  assert.match(src, /--restart unless-stopped/);
  assert.match(src, /-v "\$VOLUME:\/home\/cua"/);
  assert.match(src, /-p "127\.0\.0\.1:\$PORT:3211"/);
  assert.match(src, /chmod 600/);
  assert.match(src, /openssl rand -hex 32/);
  assert.match(src, /-e CUA_ENV_TOKEN( |\\)/, "token is passed by name, not as -e CUA_ENV_TOKEN=value");
  assert.doesNotMatch(src, /echo[^\n]*\$TOKEN|echo[^\n]*\$\{TOKEN/, "token must not be printed");
});

test("kill-test.sh covers F01-1/2/3 and F04 and writes the evidence doc", () => {
  const src = readFileSync(scripts[2], "utf8");
  for (const id of ["F01-1", "F01-2", "F01-3", "F04"]) assert.ok(src.includes(id), id);
  assert.match(src, /docs\/recovery-test\.md/);
  assert.match(src, /kill9_server/);
  assert.match(src, /docker restart/);
});
