// Offline tests for src/sandbox/sprites.mjs (fake SDK client that mimics SpriteCommand's events/streams).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const { createSpritesBash, MAX_EXEC_QUERY_CHARS, redactMessage } = await import("../src/sandbox/sprites.mjs");

const TOKEN = "ghp_SECRETTOKEN1234567890";
const URL_WITH_SECRETS = `wss://api.sprites.dev/v1/sprites/tarsbot-dev/exec?cmd=%2Fbin%2Fsh&cmd=-c&cmd=echo+hi&env=GH_TOKEN%3D${TOKEN}&stdin=true`;

/**
 * Fake SpriteCommand. `script(cmd)` drives the scenario after construction; helpers mirror the SDK:
 * open() -> emits 'spawn'; exit(code) -> pushes EOF to both streams and emits 'exit'; fail(err) -> emits 'error'.
 */
class FakeCommand extends EventEmitter {
  constructor(args, options) {
    super();
    this.args = args;
    this.options = options;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.closed = false;
  }
  open() {
    this.emit("spawn");
  }
  out(s) {
    this.stdout.push(Buffer.isBuffer(s) ? s : Buffer.from(s));
  }
  err(s) {
    this.stderr.push(Buffer.isBuffer(s) ? s : Buffer.from(s));
  }
  exit(code) {
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("exit", code);
  }
  fail(message) {
    this.emit("error", new Error(message));
  }
  kill(sig) {
    this.signals.push(sig);
  }
  close() {
    this.closed = true;
  }
}

function fakeClient(scenarios) {
  const spawned = [];
  const names = [];
  const client = {
    sprite(name) {
      names.push(name);
      return {
        spawn(file, args, options) {
          const cmd = new FakeCommand(args, options);
          cmd.file = file;
          spawned.push(cmd);
          const scenario = scenarios[Math.min(spawned.length - 1, scenarios.length - 1)];
          setImmediate(() => scenario(cmd));
          return cmd;
        },
      };
    },
  };
  return { client, spawned, names };
}

const opts = (client, extra = {}) => ({ client, name: "tarsbot-dev", retryDelayMs: 0, ...extra });

test("returns stdout/stderr separately and exit code", async () => {
  const { client, spawned, names } = fakeClient([
    (c) => {
      c.open();
      c.out("out\n");
      c.err("err\n");
      c.exit(3);
    },
  ]);
  const bash = createSpritesBash(opts(client));
  const r = await bash("echo out; echo err >&2; exit 3");
  assert.deepEqual(r, { stdout: "out\n", stderr: "err\n", exitCode: 3, timedOut: false });
  assert.deepEqual(names, ["tarsbot-dev"]);
  assert.equal(spawned.length, 1);
});

test("argv: command is its own element (never spliced), delayed start, exec of inner sh", async () => {
  const { client, spawned } = fakeClient([(c) => (c.open(), c.exit(0))]);
  const command = "exec echo 'unterminated # comment";
  await createSpritesBash(opts(client))(command);
  const c = spawned[0];
  assert.equal(c.file, "/bin/sh");
  assert.equal(c.args.length, 4);
  assert.equal(c.args[0], "-c");
  assert.match(c.args[1], /^sleep 0\.1; exec \/bin\/sh -c "\$1"$/);
  assert.equal(c.args[2], "sh");
  assert.equal(c.args[3], command);
  assert.ok(!c.args[1].includes("unterminated"));
});

test("startDelaySec is configurable; 0 omits sleep", async () => {
  const { client, spawned } = fakeClient([(c) => (c.open(), c.exit(0))]);
  await createSpritesBash(opts(client, { startDelaySec: 0 }))("true");
  assert.equal(spawned[0].args[1], 'exec /bin/sh -c "$1"');
});

test("stdin is closed after the WebSocket opens (spawn), not before", async () => {
  let endedBeforeOpen;
  let endedAfterOpen;
  const { client } = fakeClient([
    (c) => {
      endedBeforeOpen = c.stdin.writableEnded;
      c.open();
      setImmediate(() => {
        endedAfterOpen = c.stdin.writableEnded;
        c.exit(0);
      });
    },
  ]);
  await createSpritesBash(opts(client))("cat");
  assert.equal(endedBeforeOpen, false);
  assert.equal(endedAfterOpen, true);
});

test("multi-byte characters split across chunks are decoded once at the end", async () => {
  const bytes = Buffer.from("héllo 世界 🎉", "utf8");
  const { client } = fakeClient([
    (c) => {
      c.open();
      for (let i = 0; i < bytes.length; i++) c.out(bytes.subarray(i, i + 1)); // 1-byte chunks cut every code point
      c.exit(0);
    },
  ]);
  const r = await createSpritesBash(opts(client))("x");
  assert.equal(r.stdout, "héllo 世界 🎉");
});

test("data pushed right before exit is not lost", async () => {
  const big = Buffer.alloc(1_000_000, "a");
  const { client } = fakeClient([
    (c) => {
      c.open();
      c.out(big);
      c.exit(0);
    },
  ]);
  const r = await createSpritesBash(opts(client))("x");
  assert.equal(r.stdout.length, big.length);
});

test("signal exit codes (137/143) are returned as-is", async () => {
  for (const code of [137, 143]) {
    const { client } = fakeClient([(c) => (c.open(), c.exit(code))]);
    const r = await createSpritesBash(opts(client))("x");
    assert.equal(r.exitCode, code);
    assert.equal(r.timedOut, false);
  }
});

test("timeout: SIGKILL first, then close; partial output kept; timedOut true", async () => {
  const { client, spawned } = fakeClient([
    (c) => {
      c.open();
      c.out("partial");
      c.err("warn");
    },
  ]);
  const t0 = Date.now();
  const r = await createSpritesBash(opts(client))("sleep 30", { timeoutMs: 80 });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(r, { stdout: "partial", stderr: "warn", timedOut: true });
  assert.deepEqual(spawned[0].signals, ["SIGKILL"]);
  assert.equal(spawned[0].closed, true);
});

test("defaultTimeoutMs applies when no timeoutMs is passed", async () => {
  const { client } = fakeClient([(c) => c.open()]);
  const r = await createSpritesBash(opts(client, { defaultTimeoutMs: 50 }))("sleep 30");
  assert.equal(r.timedOut, true);
});

test("exit -1 (connection ended without exit status) throws instead of returning an exit code; no retry", async () => {
  const { client, spawned } = fakeClient([(c) => (c.open(), c.out("some"), c.exit(-1))]);
  await assert.rejects(createSpritesBash(opts(client))("git commit -m x"), (e) => {
    assert.match(e.message, /Sprite exec connection ended without exit status; command may or may not have run/);
    return true;
  });
  assert.equal(spawned.length, 1);
});

test("failure before the WebSocket opens -> retried once, then succeeds", async () => {
  const logs = [];
  const { client, spawned } = fakeClient([
    (c) => c.fail("WebSocket closed before open: code=1006 reason=none (url: " + URL_WITH_SECRETS + ")"),
    (c) => (c.open(), c.out("ok"), c.exit(0)),
  ]);
  const r = await createSpritesBash(opts(client, { log: (e) => logs.push(e) }))("echo hi");
  assert.equal(r.stdout, "ok");
  assert.equal(r.exitCode, 0);
  assert.equal(spawned.length, 2);
  assert.equal(logs.at(-1).retries, 1);
});

test("the SDK reporting one pre-open failure twice still counts as one failure", async () => {
  const { client, spawned } = fakeClient([
    (c) => {
      c.fail("WebSocket error: boom");
      c.fail("WebSocket error: boom"); // ws 'error' handler and start().catch both emit
    },
    (c) => (c.open(), c.exit(0)),
  ]);
  const r = await createSpritesBash(opts(client))("x");
  assert.equal(r.exitCode, 0);
  assert.equal(spawned.length, 2);
});

test("failure after the command started -> not retried, error thrown", async () => {
  const { client, spawned } = fakeClient([(c) => (c.open(), c.out("partial"), c.fail("WebSocket error: reset"))]);
  await assert.rejects(createSpritesBash(opts(client))("git push"), /connection error after start; command may or may not have run/);
  assert.equal(spawned.length, 1);
});

test("two consecutive pre-open failures -> error, exactly two attempts", async () => {
  const { client, spawned } = fakeClient([(c) => c.fail("WebSocket error: down")]);
  await assert.rejects(createSpritesBash(opts(client))("x"), /could not connect after 1 retry: WebSocket error: down/);
  assert.equal(spawned.length, 2);
});

test("late 'error' events after settling do not throw (listener stays attached)", async () => {
  const { client, spawned } = fakeClient([(c) => (c.open(), c.exit(0))]);
  await createSpritesBash(opts(client))("x");
  assert.doesNotThrow(() => spawned[0].emit("error", new Error("late")));
});

test("GH_TOKEN goes only into the exec env option, never argv/logs/results", async () => {
  const logs = [];
  const { client, spawned } = fakeClient([(c) => (c.open(), c.exit(0))]);
  const bash = createSpritesBash(opts(client, { env: { GH_TOKEN: TOKEN }, log: (e) => logs.push(e) }));
  await bash("gh pr list");
  const c = spawned[0];
  assert.deepEqual(c.options.env, { GH_TOKEN: TOKEN });
  assert.ok(!JSON.stringify(c.args).includes(TOKEN));
  assert.ok(!JSON.stringify(logs).includes(TOKEN));
});

test("no env option when env is empty", async () => {
  const { client, spawned } = fakeClient([(c) => (c.open(), c.exit(0))]);
  await createSpritesBash(opts(client))("true");
  assert.equal(spawned[0].options.env, undefined);
});

test("errors are redacted: URL query and env values removed (pre-open, post-start, exit -1)", async () => {
  const cases = [
    [(c) => c.fail(`WebSocket error: x (url: ${URL_WITH_SECRETS})`), 'echo "secret command text"'],
    [(c) => (c.open(), c.fail(`WebSocket closed: ${URL_WITH_SECRETS} token ${TOKEN}`)), "x"],
  ];
  for (const [scenario, command] of cases) {
    const { client } = fakeClient([scenario]);
    const bash = createSpritesBash(opts(client, { env: { GH_TOKEN: TOKEN } }));
    await assert.rejects(bash(command), (e) => {
      assert.ok(!e.message.includes(TOKEN), e.message);
      assert.ok(!e.message.includes("env="), e.message);
      assert.ok(!e.message.includes("echo"), e.message);
      assert.ok(!e.message.includes("?"), e.message);
      assert.match(e.message, /wss:\/\/api\.sprites\.dev\/v1\/sprites\/tarsbot-dev\/exec/);
      return true;
    });
  }
});

test("redactMessage: secrets (plain and URL-encoded) become ***; query strings dropped; short secrets ignored", () => {
  const out = redactMessage(`bad ${TOKEN} and ${encodeURIComponent("a b&c=dddd")} (url: https://x.dev/p?a=1&b=2) end`, [TOKEN, "a b&c=dddd", "ab"]);
  assert.equal(out, "bad *** and *** (url: https://x.dev/p) end");
});

test("log receives only length, duration, exit code, retries (no command text or output)", async () => {
  const logs = [];
  const { client } = fakeClient([(c) => (c.open(), c.out("OUTPUT-TEXT"), c.exit(0))]);
  await createSpritesBash(opts(client, { log: (e) => logs.push(e) }))("echo COMMAND-TEXT");
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ["commandLength", "exitCode", "retries", "ms", "outcome"].sort());
  assert.equal(logs[0].commandLength, "echo COMMAND-TEXT".length);
  const s = JSON.stringify(logs);
  assert.ok(!s.includes("COMMAND-TEXT") && !s.includes("OUTPUT-TEXT"));
});

test("a throwing log function does not break the call", async () => {
  const { client } = fakeClient([(c) => (c.open(), c.exit(0))]);
  const r = await createSpritesBash(opts(client, { log: () => { throw new Error("log down"); } }))("x");
  assert.equal(r.exitCode, 0);
});

test("oversized command (exec URL would exceed the platform limit) fails fast, no connection, no command text in error", async () => {
  const { client, spawned } = fakeClient([(c) => (c.open(), c.exit(0))]);
  const bash = createSpritesBash(opts(client));
  const secret = "TOPSECRETWORD";
  await assert.rejects(bash(`echo ${secret} ${"a".repeat(MAX_EXEC_QUERY_CHARS)}`), (e) => {
    assert.equal(e.code, "SPRITES_COMMAND_TOO_LARGE");
    assert.ok(!e.message.includes(secret));
    return true;
  });
  assert.equal(spawned.length, 0);
  // percent-encoding counts: 30k quotes become 90k chars
  await assert.rejects(bash("'".repeat(30_000)), /too large/);
  const r = await bash("a".repeat(MAX_EXEC_QUERY_CHARS - 1000)); // just below the limit still runs
  assert.equal(r.exitCode, 0);
});

test("factory validates arguments", () => {
  assert.throws(() => createSpritesBash({ name: "x" }), TypeError);
  assert.throws(() => createSpritesBash({ client: { sprite() {} } }), TypeError);
});
