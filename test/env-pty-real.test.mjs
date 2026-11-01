import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createSpritesProvider } from "../src/providers/sprites.mjs";
import { createSpritesBash } from "../src/sandbox/sprites.mjs";

const bridge = fileURLToPath(new URL("./fixtures/env-pty.py", import.meta.url));
const hash = (s) => createHash("sha256").update(s).digest("hex");

function local(t, { tty = true, corrupt = false, sttyFails = false, noProbe = false, noPayload = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pca-real-pty-"));
  const records = [];
  const children = [];
  if (sttyFails) writeFileSync(join(dir, "stty"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  t.after(() => { for (const c of children) c.kill("SIGTERM"); rmSync(dir, { recursive: true, force: true }); });
  const client = { getSprite() {}, sprite: () => ({ spawn(cmd, args, options) {
    const rec = { cmd, args, options, raw: "", sent: "" };
    records.push(rec);
    const env = { PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir, SHELL: "/bin/bash", TERM: "dumb", LEAK_ME: "ambient-secret" };
    const c = tty ? spawn("python3", [bridge], { stdio: ["pipe", "pipe", "pipe"] }) : spawn(cmd, args, { cwd: dir, env });
    children.push(c);
    // Shorten remote read deadlines for negative tests; production defaults remain 30s/60s.
    const runArgs = args.map((a) => a.replaceAll("-t 30", "-t 1").replaceAll("-t 60", "-t 5"));
    if (tty) c.stdin.write(JSON.stringify({ cmd, args: runArgs, cwd: dir, env }) + "\n");
    const handle = new EventEmitter();
    handle.stdout = new PassThrough();
    handle.stderr = c.stderr;
    handle.stdin = new Writable({ write(chunk, _encoding, done) {
      let data = chunk.toString();
      if ((noProbe && data === "PCA_ENV_1\n") || (noPayload && data !== "PCA_ENV_1\n")) return done();
      if (corrupt && data !== "PCA_ENV_1\n") data = "====\n";
      rec.sent += data;
      c.stdin.write(data, done);
    }, final(done) { if (!tty) c.stdin.end(); done(); } });
    c.stdout.on("data", (b) => {
      rec.raw += b.toString();
      // Force every handshake marker across many chunks, with a real kernel PTY behind it.
      for (let i = 0; i < b.length; i += 3) handle.stdout.write(b.subarray(i, i + 3));
    });
    c.stdout.on("end", () => handle.stdout.end());
    c.on("close", (code) => handle.emit("exit", code));
    c.on("error", (e) => handle.emit("error", e));
    handle.kill = () => c.kill("SIGTERM");
    handle.close = () => {};
    handle.resize = () => {};
    handle.signal = () => {};
    setImmediate(() => handle.emit("spawn"));
    return handle;
  } }) };
  return { dir, records, client };
}

test("real PTY: split markers, 8KiB quotes/multiline, merged 64KiB budget, no echo/argv/URL/files", { timeout: 20000 }, async (t) => {
  const w = local(t);
  const env = { QUOTES: "'".repeat(8192), MULTILINE: "a\n'b'$HOME`tick`".repeat(400) };
  for (let i = 0; i < 5; i++) env[`PAD_${i}`] = "p".repeat(8192);
  const shell = await createSpritesProvider({ client: w.client }).pty("pca-test")({ cwd: w.dir, sessionEnv: env, sessionUnset: ["LEAK_ME"] });
  let output = "";
  shell.stdout.on("data", (b) => { output += b.toString(); });
  // Print only fingerprints; values never intentionally appear in output.
  shell.write("stty -echo; printf '%s' \"$QUOTES\" | shasum -a 256; printf '%s' \"$MULTILINE\" | shasum -a 256; printf 'disabled=%s\\n' \"${LEAK_ME-unset}\"; exit\n");
  await shell.exit;
  assert.ok(output.includes(hash(env.QUOTES)), output);
  assert.ok(output.includes(hash(env.MULTILINE)), output);
  assert.ok(output.includes("disabled=unset"), output);
  assert.doesNotMatch(output, /PCA_(READY|APPLIED|ENV)_1/);
  const r = w.records[0];
  assert.ok(!JSON.stringify([r.args, r.options]).includes(env.MULTILINE));
  assert.ok(!JSON.stringify([r.args, r.options]).includes(env.QUOTES));
  assert.equal(r.options.env, undefined);
  const payload = r.sent.split("\n")[1];
  assert.ok(payload.length > 16 * 1024);
  assert.ok(!r.raw.includes(payload.slice(0, 120)), "no base64 echo");
  assert.ok(!r.raw.includes(env.MULTILINE), "no plaintext echo");
  assert.deepEqual(readdirSync(w.dir), [".bash_history"], "only user shell history is written");
  const history = readFileSync(join(w.dir, ".bash_history"), "utf8");
  for (const secret of [env.QUOTES, env.MULTILINE, payload]) assert.ok(!history.includes(secret), "no secrets in shell history");
});

for (const [name, options, env] of [
  ["stty fails", { sttyFails: true }, { SECRET: "do-not-send-this" }],
  ["invalid base64", { corrupt: true }, { SECRET: "do-not-send-this" }],
  ["readonly export before successful export", {}, { UID: "999999", Z_OK: "yes" }],
  ["probe timeout", { noProbe: true }, { SECRET: "do-not-send-this" }],
  ["payload timeout", { noPayload: true }, { SECRET: "do-not-send-this" }],
]) test(`real PTY fails closed: ${name}`, { timeout: 10000 }, async (t) => {
  const w = local(t, options);
  await assert.rejects(createSpritesProvider({ client: w.client }).pty("pca-test")({ cwd: w.dir, sessionEnv: env }), /bootstrap exited/);
  assert.doesNotMatch(w.records[0].raw, /PCA_APPLIED_1/);
  if (options.sttyFails) assert.equal(w.records[0].sent, "PCA_ENV_1\n");
});

for (const corrupt of [false, true]) test(`real non-PTY bootstrap rejects ${corrupt ? "invalid base64" : "readonly export"} before command`, async (t) => {
  const w = local(t, { tty: false, corrupt });
  const bash = createSpritesBash({ client: w.client, name: "pca-test", startDelaySec: 0 });
  const result = await bash("printf USER_COMMAND_RAN", { env: { UID: "999999", Z_OK: "yes" } });
  assert.equal(result.exitCode, 125);
  assert.ok(!result.stdout.includes("USER_COMMAND_RAN"));
});
