// Offline tests for CuaEnv (mock `bash`, no sandbox needed). The class serves both Cua and Sprites.
// The in-process tests assume cua mode (`/home/cua`); sandbox-mode specifics are tested in child processes
// (config is computed at import time), so neither .env nor the caller's shell can change these results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.TARSBOT_NO_DOTENV = "1";
process.env.TARSBOT_SANDBOX = "cua";
const { CuaEnv, shellQuote, mapFileError, resolvePath, WRITE_CHUNK_BYTES, MAX_READER_BYTES } = await import("../src/env.mjs");
const { BACKGROUND_CONTEXT, withAbortSignal } = await import("@earendil-works/chord/context");

const ctx = BACKGROUND_CONTEXT;
const done = (stdout = "", extra = {}) => ({ stdout, stderr: "", exitCode: 0, timedOut: false, ...extra });

/** CuaEnv whose bash records commands and answers via `reply(command, calls)`. */
function mockEnv(reply = () => done(), opts = {}) {
  const calls = [];
  const env = new CuaEnv({
    cwd: "/home/cua/work",
    bash: async (command, o) => {
      calls.push({ command, ...o });
      return reply(command, calls);
    },
    ...opts,
  });
  return { env, calls };
}

// --- shellQuote ---------------------------------------------------------------------------------------------

const tricky = [
  "plain",
  "with space",
  "it's",
  'say "hi"',
  "$HOME and ${X} and $(echo pwn)",
  "`echo pwn`",
  "line1\nline2",
  "",
  "a;b|c&d>e<f*?[x]",
  "\\back\\slash",
  "-rf",
  "tab\there",
  "'''",
];

test("shellQuote: exact format", () => {
  assert.equal(shellQuote(["a", "b c", ""]), "'a' 'b c' ''");
  assert.equal(shellQuote(["it's"]), `'it'\\''s'`);
  assert.equal(shellQuote([]), "");
});

test("shellQuote: real sh round-trips every tricky argument unchanged", () => {
  for (const arg of tricky) {
    const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote([arg])}`], { encoding: "utf8" });
    assert.equal(out, arg, JSON.stringify(arg));
  }
  const out = execFileSync("/bin/sh", ["-c", `printf '%s\\0' ${shellQuote(tricky)}`], { encoding: "utf8" });
  assert.deepEqual(out.split("\0").slice(0, -1), tricky);
});

// --- error mapping ------------------------------------------------------------------------------------------

test("mapFileError maps stderr to codes", () => {
  const code = (s) => mapFileError(s, "/x").code;
  assert.equal(code("cat: /x: No such file or directory"), "not_found");
  assert.equal(code("stat: cannot statx 'nope': No such file or directory"), "not_found");
  assert.equal(code("bash: /x: Permission denied"), "permission_denied");
  assert.equal(code("rm: Operation not permitted"), "permission_denied");
  assert.equal(code("mkdir: cannot create directory 'a/b': Not a directory"), "not_directory");
  assert.equal(code("base64: /d: read error: Is a directory"), "is_directory");
  assert.equal(code("truncate: Invalid argument"), "invalid");
  assert.equal(code("something odd"), "unknown");
  assert.equal(code(""), "unknown");
  assert.equal(mapFileError("boom\n", "/x").path, "/x");
});

test("file operations surface mapped errors", async () => {
  const cases = [
    ["cat: No such file or directory", "not_found"],
    ["x: Permission denied", "permission_denied"],
    ["x: Not a directory", "not_directory"],
    ["x: Is a directory", "is_directory"],
  ];
  for (const [stderr, code] of cases) {
    const { env } = mockEnv(() => ({ stdout: "", stderr, exitCode: 1, timedOut: false }));
    const r = await env.readTextFile("f.txt", ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, code);
    assert.equal(r.error.path, "/home/cua/work/f.txt");
  }
});

test("exists is false only for not_found", async () => {
  const { env } = mockEnv(() => ({ stdout: "", stderr: "stat: No such file or directory", exitCode: 1 }));
  assert.deepEqual(await env.exists("x", ctx), { ok: true, value: false });
  const denied = mockEnv(() => ({ stdout: "", stderr: "Permission denied", exitCode: 1 })).env;
  assert.equal((await denied.exists("x", ctx)).ok, false);
  const present = mockEnv(() => done("regular file|3|1700000000.500\n")).env;
  assert.deepEqual(await present.exists("x", ctx), { ok: true, value: true });
});

// --- paths --------------------------------------------------------------------------------------------------

test("absolutePath / joinPath are pure POSIX", async () => {
  const { env, calls } = mockEnv();
  assert.deepEqual(await env.absolutePath("a/b.txt", ctx), { ok: true, value: "/home/cua/work/a/b.txt" });
  assert.deepEqual(await env.absolutePath("../x", ctx), { ok: true, value: "/home/cua/x" });
  assert.deepEqual(await env.absolutePath("/etc//hosts", ctx), { ok: true, value: "/etc/hosts" });
  assert.deepEqual(await env.absolutePath(".", ctx), { ok: true, value: "/home/cua/work" });
  assert.deepEqual(await env.absolutePath("~", ctx), { ok: true, value: "/home/cua" });
  assert.deepEqual(await env.absolutePath("~/n.txt", ctx), { ok: true, value: "/home/cua/n.txt" });
  assert.deepEqual(await env.joinPath(["/a", "b", "../c", "d.txt"], ctx), { ok: true, value: "/a/c/d.txt" });
  assert.deepEqual(await env.joinPath(["a", "b"], ctx), { ok: true, value: "a/b" });
  assert.equal(resolvePath("/w", "x"), "/w/x");
  assert.equal(calls.length, 0, "path functions never touch the Space");
  assert.equal(env.id, "cua:main");
});

// --- exec ---------------------------------------------------------------------------------------------------

test("exec: string runs through bash -c, with cwd and env prelude", async () => {
  const { env, calls } = mockEnv(() => done("hi\n"));
  const out = [];
  const r = await env.exec("echo $A", { cwd: "sub dir", env: { A: "it's", "bad-name": "x" }, onOutput: (t, _c, i) => out.push([t, i.stream]) }, ctx);
  assert.deepEqual(r, { ok: true, value: { exitCode: 0 } });
  const script = calls[0].command;
  assert.match(script, /^export A='it'\\''s'$/m);
  assert.doesNotMatch(script, /bad-name/);
  assert.match(script, /cd '\/home\/cua\/work\/sub dir'/);
  assert.match(script, /exec '\/bin\/bash' -c 'echo \$A'$/);
  assert.deepEqual(out, [["hi\n", "stdout"]]);
});

test("exec: shell:null runs the string unwrapped", async () => {
  const { env, calls } = mockEnv(() => done(), { shell: null });
  await env.exec("echo a\necho b", undefined, ctx);
  assert.ok(calls[0].command.endsWith("\necho a\necho b"));
});

test("exec: argv is quoted, not shell-parsed", async () => {
  const { env, calls } = mockEnv();
  await env.exec(["sh", "-c", "printf %s \"$1\"", "x", "it's $(pwn) `x`", "", "a\nb"], undefined, ctx);
  assert.ok(calls[0].command.endsWith(`exec ${shellQuote(["sh", "-c", 'printf %s "$1"', "x", "it's $(pwn) `x`", "", "a\nb"])}`));
});

test("exec: stdout and stderr are each delivered once, exit codes pass through", async () => {
  const { env } = mockEnv(() => ({ stdout: "out", stderr: "err", exitCode: 3, timedOut: false }));
  const got = [];
  const r = await env.exec("x", { onOutput: (t, _c, i) => got.push([i.stream, t]) }, ctx);
  assert.deepEqual(r, { ok: true, value: { exitCode: 3 } });
  assert.deepEqual(got, [["stdout", "out"], ["stderr", "err"]]);
  const killed = mockEnv(() => ({ stdout: "", stderr: "", timedOut: false })).env;
  assert.equal((await killed.exec("x", undefined, ctx)).value.exitCode, 137);
});

test("exec: timeout seconds become ms and timedOut maps to a timeout error", async () => {
  const { env, calls } = mockEnv(() => ({ stdout: "", stderr: "", timedOut: true }));
  const r = await env.exec("sleep 9", { timeout: 1.5 }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "timeout");
  assert.equal(calls[0].timeoutMs, 1500);
  for (const bad of [0, -1, Number.NaN, Infinity]) {
    assert.equal((await env.exec("x", { timeout: bad }, ctx)).error.code, "timeout");
  }
});

test("exec: abort before and during the run", async () => {
  const pre = new AbortController();
  pre.abort();
  const { env, calls } = mockEnv();
  assert.equal((await env.exec("x", undefined, withAbortSignal(pre.signal, ctx))).error.code, "aborted");
  assert.equal(calls.length, 0);

  const slow = mockEnv(() => new Promise(() => {})).env; // never resolves
  const live = new AbortController();
  const running = slow.exec("sleep 99", undefined, withAbortSignal(live.signal, ctx));
  setTimeout(() => live.abort(), 20);
  assert.equal((await running).error.code, "aborted");
});

test("exec: spawn errors (empty argv, missing program, missing cwd, bash failure)", async () => {
  const { env } = mockEnv();
  assert.equal((await env.exec([], undefined, ctx)).error.code, "spawn_error");
  const missing = mockEnv(() => ({ stdout: "", stderr: "sh: 1: exec: nope: not found\n", exitCode: 127 })).env;
  assert.equal((await missing.exec(["nope"], undefined, ctx)).error.code, "spawn_error");
  // The same exit code from a string command is an ordinary result.
  assert.equal((await missing.exec("nope", undefined, ctx)).value.exitCode, 127);
  const nocwd = mockEnv(() => ({ stdout: "", stderr: "tarsbot: working directory does not exist\n", exitCode: 125 })).env;
  assert.equal((await nocwd.exec("ls", undefined, ctx)).error.code, "spawn_error");
  const broken = mockEnv(() => { throw new Error("space down"); }).env;
  const r = await broken.exec("ls", undefined, ctx);
  assert.equal(r.error.code, "spawn_error");
  assert.match(r.error.message, /space down/);
});

test("exec: a throwing onOutput becomes callback_error", async () => {
  const { env } = mockEnv(() => done("x"));
  const r = await env.exec("x", { onOutput() { throw new Error("cb"); } }, ctx);
  assert.equal(r.error.code, "callback_error");
});

// --- metadata -----------------------------------------------------------------------------------------------

test("fileInfo parses stat output (kinds, seconds to ms)", async () => {
  const kinds = [["regular file", "file"], ["regular empty file", "file"], ["directory", "directory"], ["symbolic link", "symlink"]];
  for (const [text, kind] of kinds) {
    const { env, calls } = mockEnv(() => done(`${text}|42|1700000000.250\n`));
    const r = await env.fileInfo("a/f.txt", ctx);
    assert.deepEqual(r.value, { name: "f.txt", path: "/home/cua/work/a/f.txt", kind, size: 42, mtimeMs: 1700000000250 });
    assert.match(calls[0].command, /^stat -c /, "lstat semantics: no -L");
    assert.doesNotMatch(calls[0].command, / -L /);
  }
  const odd = mockEnv(() => done("fifo|0|1.0\n")).env;
  assert.equal((await odd.fileInfo("p", ctx)).error.code, "invalid");
  const gone = mockEnv(() => ({ stdout: "", stderr: "stat: cannot statx 'p': No such file or directory", exitCode: 1 })).env;
  assert.equal((await gone.fileInfo("p", ctx)).error.code, "not_found");
});

test("listDir parses NUL-separated find output and skips unsupported kinds", async () => {
  const out = "f\t3\t1700000000.5\ta.txt\0d\t4096\t1700000001.0\tsub\0p\t0\t1.0\tfifo\0l\t5\t2.0\tname\twith tab\0";
  const { env } = mockEnv(() => done(out));
  const r = await env.listDir(".", ctx);
  assert.deepEqual(r.value.map((e) => [e.name, e.kind]), [["a.txt", "file"], ["sub", "directory"], ["name\twith tab", "symlink"]]);
  assert.equal(r.value[0].path, "/home/cua/work/a.txt");
  assert.equal(r.value[0].mtimeMs, 1700000000500);
});

// --- reading ------------------------------------------------------------------------------------------------

test("read text / binary via base64", async () => {
  const bytes = Buffer.from([0, 255, 10, 200]);
  const { env, calls } = mockEnv(() => done(bytes.toString("base64")));
  const bin = await env.readBinaryFile("b", ctx);
  assert.deepEqual([...bin.value], [...bytes]);
  assert.match(calls[0].command, /^base64 -w0 -- '\/home\/cua\/work\/b'$/);
  const text = mockEnv(() => done(Buffer.from("héllo\n", "utf8").toString("base64"))).env;
  assert.equal((await text.readTextFile("t", ctx)).value, "héllo\n");
  const lines = mockEnv(() => done(Buffer.from("a\nb\n\nc", "utf8").toString("base64"))).env;
  assert.deepEqual((await lines.readTextLines("t", undefined, ctx)).value, ["a", "b", "", "c"]);
  assert.deepEqual((await lines.readTextLines("t", { maxLines: 2 }, ctx)).value, ["a", "b"]);
});

test("openBinaryReader: in-memory reads, directories, size limit, noFollow", async () => {
  const data = Buffer.from("hello world");
  const reply = (command) => {
    if (command.startsWith("stat -L")) return done(`regular file|${data.length}|1700000000.000\n`);
    if (command.startsWith("base64")) return done(data.toString("base64"));
    throw new Error(`unexpected ${command}`);
  };
  const { env } = mockEnv(reply);
  const reader = (await env.openBinaryReader("d.txt", undefined, ctx)).value;
  assert.deepEqual((await reader.info(ctx)).value, { name: "d.txt", path: "/home/cua/work/d.txt", kind: "file", size: 11, mtimeMs: 1700000000000 });
  assert.equal(Buffer.from((await reader.read(6, 100, ctx)).value).toString(), "world");
  assert.equal((await reader.read(50, 1, ctx)).value.length, 0);
  assert.equal((await reader.read(-1, 1, ctx)).error.code, "invalid");
  assert.equal((await reader.scanLines({ startLine: 0 }, ctx)).value.newlines, 0);
  await reader.close(ctx);
  assert.equal((await reader.read(0, 1, ctx)).error.code, "invalid");

  const dir = mockEnv(() => done("directory|4096|1.0\n")).env;
  assert.equal((await dir.openBinaryReader("d", undefined, ctx)).error.code, "is_directory");

  const big = mockEnv(() => done(`regular file|${MAX_READER_BYTES + 1}|1.0\n`)).env;
  assert.equal((await big.openBinaryReader("big", undefined, ctx)).error.code, "invalid");

  const link = mockEnv((c) => (c.includes("%F'") && !c.includes("-L") ? done("symbolic link\n") : done("regular file|0|1.0\n"))).env;
  assert.equal((await link.openBinaryReader("l", { noFollow: true }, ctx)).error.code, "invalid");
  assert.equal((await link.openBinaryReader("l", undefined, ctx)).ok, true);
});

// --- writing ------------------------------------------------------------------------------------------------

/** Rebuild the file content a sequence of write commands would produce (parses our own command shape). */
function replayWrites(calls) {
  let buf = Buffer.alloc(0);
  for (const { command } of calls) {
    const m = command.match(/printf %s '([A-Za-z0-9+/=]*)' \| base64 -d (>>?) '/);
    assert.ok(m, command.slice(0, 120));
    const chunk = Buffer.from(m[1], "base64");
    assert.ok(chunk.length <= WRITE_CHUNK_BYTES);
    buf = m[2] === ">" ? chunk : Buffer.concat([buf, chunk]);
  }
  return buf;
}

test("writeFile: mkdir -p, base64, one command for small files", async () => {
  const { env, calls } = mockEnv();
  assert.equal((await env.writeFile("a/b/c.txt", "héllo 'q' $x\n", ctx)).ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /^mkdir -p -- '\/home\/cua\/work\/a\/b' && printf %s '/);
  assert.match(calls[0].command, / \| base64 -d > '\/home\/cua\/work\/a\/b\/c\.txt'$/);
  assert.equal(replayWrites(calls).toString("utf8"), "héllo 'q' $x\n");
});

test("writeFile: large content is chunked (first >, rest >>) and lossless", async () => {
  const data = Buffer.alloc(WRITE_CHUNK_BYTES * 2 + 1234);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 255;
  const { env, calls } = mockEnv();
  assert.equal((await env.writeFile("big.bin", new Uint8Array(data), ctx)).ok, true);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].command.includes("base64 -d > ") && calls[1].command.includes("base64 -d >> ") && calls[2].command.includes("base64 -d >> "));
  assert.ok(calls.every((c) => c.command.length < 120_000), "each command stays under the 128KiB argument limit");
  assert.ok(replayWrites(calls).equals(data));
});

test("appendFile appends; empty content still creates the file", async () => {
  const { env, calls } = mockEnv();
  await env.appendFile("log.txt", "x", ctx);
  assert.match(calls[0].command, /base64 -d >> '\/home\/cua\/work\/log\.txt'$/);
  await env.writeFile("empty", "", ctx);
  assert.match(calls[1].command, /: > '\/home\/cua\/work\/empty'$/);
});

test("writeFile stops at the first failing chunk and maps the error", async () => {
  const data = Buffer.alloc(WRITE_CHUNK_BYTES * 3, 1);
  const { env, calls } = mockEnv((_c, all) => (all.length === 2 ? { stdout: "", stderr: "No space left on device", exitCode: 1 } : done()));
  const r = await env.writeFile("f", data, ctx);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 2);
  const denied = mockEnv(() => ({ stdout: "", stderr: "sh: 1: cannot create /x/f: Permission denied", exitCode: 2 })).env;
  assert.equal((await denied.writeFile("f", "x", ctx)).error.code, "permission_denied");
});

test("rename / remove / createDir / truncate / flush command shapes", async () => {
  const { env, calls } = mockEnv();
  await env.renameFile("a", "b c", ctx);
  await env.remove("d", { recursive: true, force: true }, ctx);
  await env.remove("d", undefined, ctx);
  await env.createDir("x/y", undefined, ctx);
  await env.createDir("x", { recursive: false }, ctx);
  await env.truncateFile("f", 10, ctx);
  await env.flushFile("f", ctx);
  const cmds = calls.map((c) => c.command);
  assert.equal(cmds[0], "mv -T -- '/home/cua/work/a' '/home/cua/work/b c'");
  assert.equal(cmds[1], "rm -rf -- '/home/cua/work/d'");
  assert.equal(cmds[2], "rm -- '/home/cua/work/d'");
  assert.equal(cmds[3], "mkdir -p -- '/home/cua/work/x/y'");
  assert.equal(cmds[4], "mkdir -- '/home/cua/work/x'");
  assert.match(cmds[5], /truncate -c -s 10 -- '\/home\/cua\/work\/f'$/);
  assert.match(cmds[6], /sync -- '\/home\/cua\/work\/f'$/);
  assert.equal((await env.truncateFile("f", -1, ctx)).error.code, "invalid");
  assert.equal((await env.truncateFile("f", 1.5, ctx)).error.code, "invalid");
});

test("canonicalPath, createTempDir, createTempFile", async () => {
  const { env, calls } = mockEnv((c) => done(c.startsWith("realpath") ? "/real/path\n" : "/tmp/tmp-abc123\n"));
  assert.equal((await env.canonicalPath("l", ctx)).value, "/real/path");
  assert.match(calls[0].command, /^realpath -e -- /);
  assert.equal((await env.createTempDir(undefined, ctx)).value, "/tmp/tmp-abc123");
  assert.match(calls[1].command, /mktemp -d -- '\/tmp\/tmp-XXXXXX'/);
  await env.createTempFile({ prefix: "p-", suffix: ".log" }, ctx);
  assert.match(calls[2].command, /mktemp '--suffix=\.log' -- '\/tmp\/p-XXXXXX'/);
});

test("aborted context short-circuits file operations without touching the Space", async () => {
  const ac = new AbortController();
  ac.abort();
  const c = withAbortSignal(ac.signal, ctx);
  const { env, calls } = mockEnv();
  for (const r of [await env.readTextFile("f", c), await env.writeFile("f", "x", c), await env.fileInfo("f", c), await env.listDir(".", c)]) {
    assert.equal(r.error.code, "aborted");
  }
  assert.equal(calls.length, 0);
});

test("directory reader lists names once and stats lazily per page", async () => {
  const names = ["a", "b", "c"];
  const { env, calls } = mockEnv((c) => {
    if (c.includes("find -H")) return done(names.join("\0") + "\0");
    // stat batch: answer for every requested name except "b" (removed meanwhile)
    return done(["a", "c"].filter((n) => c.includes(`'${n}'`)).map((n) => `regular file|1|1.5|${n}\0`).join(""));
  });
  const reader = (await env.openDirReader(".", ctx)).value;
  assert.equal(calls.length, 1);
  const p1 = (await reader.next(1, ctx)).value;
  assert.deepEqual(p1.entries.map((e) => e.name), ["a"]);
  assert.equal(p1.done, false);
  // "b" vanished: the page is refilled from the next name instead of coming back short.
  const p2 = (await reader.next(1, ctx)).value;
  assert.deepEqual(p2.entries.map((e) => e.name), ["c"]);
  assert.equal(p2.done, true);
  assert.equal((await reader.next(0, ctx)).error.code, "invalid");
  await reader.close(ctx);
  assert.equal((await reader.next(1, ctx)).error.code, "invalid");
});

test("watch is a polling watcher that reports created, changed and removed paths", async () => {
  let n = 0;
  const snaps = [
    "/w/f\tf\t1\t1.0\t10\0",
    "/w/f\tf\t1\t1.0\t10\0",
    "/w/f\tf\t2\t2.0\t10\0/w/g\tf\t1\t1.0\t11\0",
    "/w/g\tf\t1\t1.0\t11\0",
  ];
  const { env } = mockEnv(() => done(snaps[Math.min(n++, snaps.length - 1)]), { watchIntervalMs: 10 });
  const changes = [];
  const w = (await env.watch([{ path: "/w", recursive: true }], (c) => changes.push(c), ctx)).value;
  assert.equal(w.mode, "polling");
  await new Promise((r) => setTimeout(r, 200));
  await w.close(ctx);
  const after = changes.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(changes.length, after, "no reports after close");
  assert.deepEqual(changes, [{ paths: ["/w/f", "/w/g"] }, { paths: ["/w/f"] }]);
});

// --- sandbox switch (config computed at import time -> child processes) ---------------------------------------

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_URL = pathToFileURL(`${ROOT}src/env.mjs`).href;
const CONFIG_URL = pathToFileURL(`${ROOT}src/config.mjs`).href;

/** Run `code` (ESM) in a fresh node with a clean TARSBOT_* environment plus `vars`. Returns {status, stdout, stderr}. */
function child(code, vars = {}, nodeArgs = []) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TARSBOT_")));
  try {
    const stdout = execFileSync(process.execPath, [...nodeArgs, "--input-type=module", "-e", code], {
      cwd: ROOT,
      env: { ...base, TARSBOT_NO_DOTENV: "1", ...vars },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

test("config: sandbox settings per mode (pure function)", async () => {
  const { sandboxSettings } = await import("../src/config.mjs");
  assert.deepEqual(sandboxSettings({}), { sandbox: "cua", spriteName: undefined, home: "/home/cua", spaceCwd: "/home/cua/work" });
  assert.equal(sandboxSettings({ TARSBOT_SANDBOX: "" }).sandbox, "cua", "empty means default");
  assert.deepEqual(sandboxSettings({ TARSBOT_SANDBOX: "sprites", TARSBOT_SPRITE_NAME: "s1" }), {
    sandbox: "sprites",
    spriteName: "s1",
    home: "/home/sprite",
    spaceCwd: "/home/sprite/workspace",
  });
  for (const bad of ["Sprites", "docker", " cua", "none"]) {
    assert.throws(() => sandboxSettings({ TARSBOT_SANDBOX: bad }), /Invalid TARSBOT_SANDBOX/, bad);
  }
});

test("config: invalid TARSBOT_SANDBOX makes importing config fail; valid values expose the fields", () => {
  const bad = child(`await import(${JSON.stringify(CONFIG_URL)})`, { TARSBOT_SANDBOX: "docker" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Invalid TARSBOT_SANDBOX/);
  const show = `const { config: c } = await import(${JSON.stringify(CONFIG_URL)}); console.log(JSON.stringify([c.sandbox, c.spriteName, c.home, c.spaceCwd]))`;
  assert.deepEqual(JSON.parse(child(show, {}).stdout), ["cua", null, "/home/cua", "/home/cua/work"]);
  const sp = child(show, { TARSBOT_SANDBOX: "sprites", TARSBOT_SPRITE_NAME: "tars-x" });
  assert.deepEqual(JSON.parse(sp.stdout), ["sprites", "tars-x", "/home/sprite", "/home/sprite/workspace"]);
});

test("sprites mode: `~` resolves to /home/sprite and ids are sprites:<name>", () => {
  const code = `
    const { CuaEnv, resolvePath } = await import(${JSON.stringify(ENV_URL)});
    const bash = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const env = new CuaEnv({ cwd: "/home/sprite/workspace", bash });
    const custom = new CuaEnv({ cwd: "/w", bash, id: "x:y" });
    console.log(JSON.stringify([
      env.id, custom.id,
      (await env.absolutePath("~")).value, (await env.absolutePath("~/n.txt")).value, (await env.absolutePath("a.txt")).value,
      resolvePath("/w", "~/z"),
    ]));`;
  const r = child(code, { TARSBOT_SANDBOX: "sprites", TARSBOT_SPRITE_NAME: "tars-x" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [
    "sprites:tars-x", "x:y", "/home/sprite", "/home/sprite/n.txt", "/home/sprite/workspace/a.txt", "/home/sprite/z",
  ]);
  // cua mode keeps the old values.
  const cua = child(code.replace("/home/sprite/workspace", "/home/cua/work"), {});
  assert.deepEqual(JSON.parse(cua.stdout).filter((_, i) => i !== 1 && i !== 4), ["cua:main", "/home/cua", "/home/cua/n.txt", "/home/cua/z"]);
});

/**
 * Module hooks for a child process: stub both sandbox modules (so nothing touches a network or needs the other
 * worker's file), and record every resolved URL so the test can prove which modules were (not) loaded.
 */
const HOOKS = `
import { registerHooks } from "node:module";
globalThis.__resolved = [];
globalThis.__cmds = [];
const stub = (name) => "export async function " + name + "(c){ globalThis.__cmds.push([" + JSON.stringify(name) + ", c]); return { stdout: '', stderr: '', exitCode: 0 }; }";
registerHooks({
  resolve(spec, ctx, next) {
    if (/sandbox\\/sprites\\.mjs$/.test(spec)) {
      const url = new URL(spec, ctx.parentURL).href;
      globalThis.__resolved.push(url);
      return { url, format: "module", shortCircuit: true };
    }
    const r = next(spec, ctx);
    globalThis.__resolved.push(r.url);
    return r;
  },
  load(url, ctx, next) {
    if (/\\/sandbox\\/sprites\\.mjs$/.test(url)) return { format: "module", shortCircuit: true, source: stub("spritesBash") };
    if (/\\/src\\/space\\.mjs$/.test(url)) return { format: "module", shortCircuit: true, source: stub("spaceBash") };
    return next(url, ctx);
  },
});`;

const hookArg = `data:text/javascript,${encodeURIComponent(HOOKS)}`;

const SPACE_ENV_CODE = `
  const { spaceEnv } = await import(${JSON.stringify(ENV_URL)});
  const env = spaceEnv()({});
  const exec = await env.exec("echo hi");
  const home = await env.absolutePath("~");
  console.log(JSON.stringify({
    id: env.id, cwd: env.cwd, home: home.value, exit: exec.value?.exitCode, cmds: globalThis.__cmds,
    loaded: [...new Set(globalThis.__resolved)].filter((u) => /\\/src\\/space\\.mjs$|@trycua|\\/sandbox\\/sprites\\.mjs$/.test(u)),
  }));`;

test("sprites mode: spaceEnv() never loads src/space.mjs or @trycua/cua; bash goes to sprites.mjs", () => {
  const r = child(SPACE_ENV_CODE, { TARSBOT_SANDBOX: "sprites", TARSBOT_SPRITE_NAME: "tars-x" }, ["--import", hookArg]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.loaded.map((u) => u.replace(/^.*\/(src\/.*)$/, "$1")), ["src/sandbox/sprites.mjs"]);
  assert.ok(!out.loaded.some((u) => /space\.mjs|trycua/.test(u)));
  assert.equal(out.id, "sprites:tars-x");
  assert.equal(out.cwd, "/home/sprite/workspace");
  assert.equal(out.home, "/home/sprite");
  assert.equal(out.exit, 0);
  assert.ok(out.cmds.length >= 2 && out.cmds.every(([who]) => who === "spritesBash"));
  assert.match(out.cmds[0][1], /^mkdir -p -- '\/home\/sprite\/workspace'$/);
  assert.match(out.cmds.at(-1)[1], /cd '\/home\/sprite\/workspace'/);
});

test("cua mode: bash goes to space.mjs and sandbox/sprites.mjs is never loaded", () => {
  const r = child(SPACE_ENV_CODE, {}, ["--import", hookArg]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.loaded.length, 1);
  assert.match(out.loaded[0], /\/src\/space\.mjs$/);
  assert.equal(out.id, "cua:main");
  assert.equal(out.cwd, "/home/cua/work");
  assert.equal(out.home, "/home/cua");
  assert.ok(out.cmds.every(([who]) => who === "spaceBash"));
});

test("sprites mode: spaceEnv() factory requires TARSBOT_SPRITE_NAME", () => {
  const code = `const { spaceEnv } = await import(${JSON.stringify(ENV_URL)}); spaceEnv()({});`;
  const r = child(code, { TARSBOT_SANDBOX: "sprites" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TARSBOT_SPRITE_NAME/);
});
