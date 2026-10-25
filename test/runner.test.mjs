// Tests for src/runner/runner.sh + src/runner/client.mjs. They run runner.sh LOCALLY (no network, no Sprite): every
// "sandbox exec" is a local `/bin/sh -c`, PCA_HOME points into a mkdtemp directory, and everything the tests start is
// killed and deleted in after().
//
// Process identity needs /proc. On Linux the real /proc is used. On macOS (no /proc) the tests inject
//   PCA_PROC_ROOT -> a fake /proc tree inside the temp dir (only boot_id), and
//   PCA_SETSID    -> a perl shim that calls setsid(2), writes <fake proc>/<pid>/stat for itself, then execs the wrapper
// so runner.sh runs UNCHANGED (production code has no macOS branch). What that cannot cover is listed as skipped tests:
//   - "ident matches the kernel's view": needs a real /proc (skipped without one)
//   - "stat parsing survives ') ' inside comm": only meaningful with the fake stat file (skipped when real /proc exists)
//
// Set PCA_TEST_SHELL=/path/to/sh to choose the shell that runs runner.sh (default: dash if present, else /bin/sh).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { shellQuote } from "../src/env.mjs";
import { MAX_COMMAND_BYTES, MAX_WAIT_BYTES, RunnerError, commandHash, createRunnerClient, parseKeyValues, runIdFor } from "../src/runner/client.mjs";

const RUNNER_SH = new URL("../src/runner/runner.sh", import.meta.url);
const HAS_PROC = process.platform === "linux" && existsSync("/proc/self/stat") && existsSync("/proc/sys/kernel/random/boot_id");
const HAS_PERL = existsSync("/usr/bin/perl") || existsSync("/usr/local/bin/perl") || existsSync("/opt/homebrew/bin/perl");
const DASH = ["/bin/dash", "/usr/bin/dash"].find((p) => existsSync(p));
const PLAIN_SH = "/bin/sh";
const MAIN_SHELL = process.env.PCA_TEST_SHELL || DASH || PLAIN_SH;
const CAN_RUN = HAS_PROC || HAS_PERL;

const q = (s) => shellQuote([s]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

async function until(fn, { timeoutMs = 10_000, everyMs = 50, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// perl is only used to get setsid(2) on a machine without setsid(1), and to give the new session a fake /proc entry.
const SETSID_SHIM = String.raw`#!/bin/sh
exec perl -MPOSIX -e '
POSIX::setsid() or die "setsid: $!";
my $dir = "$ENV{PCA_PROC_ROOT}/$$";
mkdir $dir;
my @f = ($$, "(w) S 9 (x y)", "S", 1, $$, $$, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, 1000000 + $$);
push @f, (0) x 30;
open(my $fh, ">", "$dir/stat") or die "stat: $!";
print $fh join(" ", @f), "\n";
close $fh;
exec(@ARGV) or die "exec: $!";
' "$@"
`;

/** Local stand-in for the Sprite `bash` primitive. Output is decoded as UTF-8 like the real one. */
function makeBash(baseEnv, calls) {
  const fn = (command, { timeoutMs = 120_000, env } = {}) =>
    new Promise((resolve, reject) => {
      calls.push({ command, envNames: env ? Object.keys(env) : null });
      const child = spawn("/bin/sh", ["-c", command], { env: { ...baseEnv, ...(env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
      const out = [];
      const err = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), exitCode: code ?? -1, timedOut });
      });
    });
  fn.supportsEnv = true;
  return fn;
}

class Sandbox {
  constructor({ shell }) {
    this.root = mkdtempSync(join(tmpdir(), "pca-runner-test-"));
    this.home = join(this.root, "pca");
    this.work = join(this.root, "work");
    this.files = join(this.root, "files");
    mkdirSync(this.work);
    mkdirSync(this.files);
    this.counter = 0;
    this.extraPids = new Set();
    this.calls = [];
    this.runnerPath = join(this.home, "runner.sh");
    this.shell = shell;
    // runner.sh with its shebang pointing at the shell under test
    const src = readFileSync(RUNNER_SH, "utf8").replace(/^#!.*\n/, `#!${shell}\n`);
    this.runnerSource = join(this.root, "runner-under-test.sh");
    writeFileSync(this.runnerSource, src);
    this.env = { ...process.env, PCA_SH: shell };
    delete this.env.PCA_HOME;
    if (!HAS_PROC) {
      this.procRoot = join(this.root, "proc");
      mkdirSync(join(this.procRoot, "sys/kernel/random"), { recursive: true });
      writeFileSync(join(this.procRoot, "sys/kernel/random/boot_id"), "11111111-2222-3333-4444-555555555555\n");
      const shim = join(this.root, "setsid-shim");
      writeFileSync(shim, SETSID_SHIM);
      chmodSync(shim, 0o755);
      this.env.PCA_PROC_ROOT = this.procRoot;
      this.env.PCA_SETSID = shim;
    }
    this.bash = makeBash(this.env, this.calls);
  }

  client(over = {}) {
    return createRunnerClient({ bash: this.bash, home: this.home, runnerSource: this.runnerSource, retryDelayMs: 5, ...over });
  }

  id() {
    return runIdFor({ namespace: "test", generation: 1, taskId: ++this.counter });
  }

  dir(id) {
    return join(this.home, "runs", id);
  }

  out(name) {
    return join(this.work, `${name}-${++this.counter}`);
  }

  /** Run the runner directly (no client), as the sandbox would. */
  async raw(args, env) {
    const cmd = `PCA_HOME=${q(this.home)} ${q(this.runnerPath)} ${args.map(q).join(" ")}`;
    const r = await this.bash(cmd, env ? { env } : {});
    return { ...r, kv: parseKeyValues(r.stdout) };
  }

  /** prepare + start. */
  async launch(client, command, over = {}) {
    const id = over.id ?? this.id();
    await client.prepare({ id, cwd: over.cwd ?? this.work, command, env: over.env });
    const started = await client.start(id, over.startEnv ? { env: over.startEnv } : {});
    return { id, started };
  }

  /** Follow `wait` until the run ends. */
  async readAll(client, id, { maxSeconds = 5, deadlineMs = 60_000 } = {}) {
    let from = 0;
    const chunks = [];
    const sizes = [];
    let text = "";
    const t0 = Date.now();
    for (;;) {
      const r = await client.wait({ id, from, maxSeconds });
      chunks.push(r.bytes);
      sizes.push(r.bytes.length);
      text += r.text;
      from = r.offset;
      if (r.done || (r.state !== "running" && r.state !== "exited")) {
        return { bytes: Buffer.concat(chunks), text, exit: r.exit, sizes, state: r.state, done: r.done };
      }
      if (Date.now() - t0 > deadlineMs) throw new Error(`run ${id} did not finish`);
    }
  }

  async run(client, command, over) {
    const { id } = await this.launch(client, command, over);
    return { id, ...(await this.readAll(client, id)) };
  }

  walk(dir = this.home) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...this.walk(p));
      else out.push(p);
    }
    return out;
  }

  cleanup() {
    for (const pid of this.extraPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    // Every wrapper we started is its own group leader (pgid == pid). Skip runs that already wrote `exit`.
    const runs = join(this.home, "runs");
    if (existsSync(runs)) {
      for (const id of readdirSync(runs)) {
        const dir = join(runs, id);
        if (existsSync(join(dir, "exit")) || !existsSync(join(dir, "ident"))) continue;
        const kv = parseKeyValues(readFileSync(join(dir, "ident"), "utf8"));
        const pid = Number(kv.pid);
        if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid && Number(kv.pgid) === pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // gone
          }
        }
      }
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}

const skipAll = CAN_RUN ? false : "needs /proc (Linux) or perl (to emulate setsid + /proc on macOS)";

// ---------------------------------------------------------------------------------------------------------------
describe("runner client helpers", () => {
  it("runIdFor is sha256(namespace:generation:taskId) first 24 hex chars, and pure", () => {
    const id = runIdFor({ namespace: "ns", generation: 2, taskId: 17 });
    assert.equal(id, createHash("sha256").update("ns:2:17").digest("hex").slice(0, 24));
    assert.match(id, /^[0-9a-f]{24}$/);
    assert.equal(runIdFor({ namespace: "ns", generation: 2, taskId: 17 }), id);
    assert.notEqual(runIdFor({ namespace: "ns", generation: 2, taskId: 13 }), id);
    assert.notEqual(runIdFor({ namespace: "ns", generation: 3, taskId: 17 }), id);
    assert.notEqual(runIdFor({ namespace: "other", generation: 2, taskId: 17 }), id);
    assert.throws(() => runIdFor({ namespace: "ns", generation: 1 }), TypeError);
  });

  it("commandHash covers both command and cwd and is unambiguous", () => {
    const h = commandHash("echo hi", "/work");
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(commandHash("echo hi", "/work"), h);
    assert.notEqual(commandHash("echo hi", "/other"), h);
    assert.notEqual(commandHash("echo ho", "/work"), h);
    assert.notEqual(commandHash("b", "/a"), commandHash("/a\nb", ""));
  });

  it("parseKeyValues stops at the first non key=value line", () => {
    assert.deepEqual(parseKeyValues("state=exited\nexit=3\n--data--\nx=y\n"), { state: "exited", exit: "3" });
  });
});

describe("runner client without a sandbox (injected failures)", () => {
  const okReply = "prepared=new\nstate=claimed\nsize=0\nlaunched=0\n";

  it("prepare and start are never retried; thrown errors pass through untouched", async () => {
    for (const kind of ["prepare", "start"]) {
      const seen = [];
      const boom = new Error("Sprite exec connection ended without exit status; command may or may not have run");
      const bash = async (command) => {
        seen.push(command);
        if (new RegExp(`runner\\.sh' ${kind} `).test(command)) throw boom;
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      };
      bash.supportsEnv = true;
      const c = createRunnerClient({ bash, home: "/h", runnerSource: RUNNER_SH, retryDelayMs: 1 });
      const op = kind === "prepare" ? () => c.prepare({ id: "abc", cwd: "/w", command: "true" }) : () => c.start("abc");
      await assert.rejects(op, (e) => e === boom);
      assert.equal(seen.filter((s) => new RegExp(`runner\\.sh' ${kind} `).test(s)).length, 1, `${kind} must be sent exactly once`);
    }
  });

  it("a timed-out prepare / start is reported as outcome unknown, not as failure", async () => {
    for (const kind of ["prepare", "start"]) {
      const bash = async (command) => {
        if (new RegExp(`runner\\.sh' ${kind} `).test(command)) return { stdout: "", stderr: "", exitCode: undefined, timedOut: true };
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      };
      bash.supportsEnv = true;
      const c = createRunnerClient({ bash, home: "/h", runnerSource: RUNNER_SH });
      const op = kind === "prepare" ? () => c.prepare({ id: "abc", cwd: "/w", command: "true" }) : () => c.start("abc");
      await assert.rejects(op, (e) => e instanceof RunnerError && e.outcomeUnknown === true && e.code === "RUNNER_TIMEOUT");
    }
  });

  it("status and wait are read-only and retried a limited number of times", async () => {
    let n = 0;
    const flaky = async () => {
      n++;
      if (n <= 2) throw new Error("connection reset");
      return { stdout: "state=running\nsize=0\ncmd_sha256=x\ncwd=/w\nlaunched=1\n", stderr: "", exitCode: 0, timedOut: false };
    };
    const c = createRunnerClient({ bash: flaky, home: "/h", runnerSource: RUNNER_SH, retryDelayMs: 1, readRetries: 2 });
    assert.equal((await c.status("abc")).state, "running");
    assert.equal(n, 3);
    n = -10;
    await assert.rejects(() => c.status("abc"), /connection reset/);
    assert.equal(n, -7, "1 try + 2 retries, then give up");
  });

  it("wait rejects data whose length disagrees with the reported offsets (lost / truncated output)", async () => {
    const full = Buffer.from("hello world").toString("base64");
    const bash = async () => ({
      stdout: `state=running\noffset=11\nsize=11\nencoding=base64\n--data--\n${full.slice(0, 8)}`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    const c = createRunnerClient({ bash, home: "/h", runnerSource: RUNNER_SH, retryDelayMs: 1, readRetries: 1 });
    await assert.rejects(() => c.wait({ id: "abc", from: 0, maxSeconds: 0 }), (e) => e instanceof RunnerError && /offsets/.test(e.message));
  });

  it("env is refused when the bash primitive cannot pass it out of band, and nothing is sent", async () => {
    const calls = [];
    const bash = async (command) => {
      calls.push(command);
      return { stdout: okReply, stderr: "", exitCode: 0, timedOut: false };
    };
    const c = createRunnerClient({ bash, home: "/h", runnerSource: RUNNER_SH });
    await assert.rejects(() => c.prepare({ id: "abc", cwd: "/w", command: "true", env: { TOKEN: "sk-secret-value" } }), (e) => e instanceof RunnerError && e.code === "RUNNER_ENV_UNSUPPORTED");
    assert.equal(calls.length, 0);
  });

  it("rejects bad input before touching the sandbox", async () => {
    const calls = [];
    const bash = async (command) => {
      calls.push(command);
      return { stdout: okReply, stderr: "", exitCode: 0, timedOut: false };
    };
    bash.supportsEnv = true;
    const c = createRunnerClient({ bash, home: "/h", runnerSource: RUNNER_SH });
    await assert.rejects(() => c.prepare({ id: "../x", cwd: "/w", command: "true" }), TypeError);
    await assert.rejects(() => c.prepare({ id: "abc", cwd: "relative", command: "true" }), TypeError);
    await assert.rejects(() => c.prepare({ id: "abc", cwd: "/w", command: "" }), RangeError);
    await assert.rejects(() => c.prepare({ id: "abc", cwd: "/w", command: "echo \0" }), RangeError);
    await assert.rejects(() => c.prepare({ id: "abc", cwd: "/w", command: "x".repeat(MAX_COMMAND_BYTES + 1) }), RangeError);
    await assert.rejects(() => c.prepare({ id: "abc", cwd: "/w", command: "true", env: { "BAD NAME": "v" } }), TypeError);
    await assert.rejects(() => c.prepare({ id: "abc", cwd: "/w", command: "true", env: { PCA_HOME: "/etc" } }), TypeError);
    await assert.rejects(() => c.status("a b"), TypeError);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe(`runner.sh (shell: ${MAIN_SHELL}, ${HAS_PROC ? "real /proc" : "fake /proc + setsid shim"})`, { skip: skipAll }, () => {
  /** @type {Sandbox} */
  let sb;
  before(() => {
    sb = new Sandbox({ shell: MAIN_SHELL });
  });
  after(() => sb?.cleanup());

  it("install is idempotent, chunked, executable, and replaces a stale copy", async () => {
    const c = sb.client();
    const first = await c.install();
    assert.equal(first.installed, true);
    assert.ok(statSync(sb.runnerPath).mode & 0o111, "executable");
    assert.equal(sha256(readFileSync(sb.runnerPath)), sha256(readFileSync(sb.runnerSource)));
    assert.ok(readFileSync(sb.runnerSource).length > 12 * 1024, "runner.sh is larger than one chunk, so chunking is exercised");
    const n = sb.calls.length;
    assert.equal((await c.install()).installed, false);
    assert.equal(sb.calls.length - n, 1, "second install only probes the version");
    writeFileSync(sb.runnerPath, "#!/bin/sh\necho version=1\n"); // right version number, wrong content
    chmodSync(sb.runnerPath, 0o755);
    assert.equal((await c.install()).installed, true);
    assert.equal(sha256(readFileSync(sb.runnerPath)), sha256(readFileSync(sb.runnerSource)));
    assert.ok(!sb.walk(sb.home).some((f) => f.includes("runner.install")), "no leftover upload parts");
  });

  it("prepare twice with the same id claims once and the second call changes nothing", async () => {
    const c = sb.client();
    const id = sb.id();
    const marker = sb.out("marker");
    const p1 = await c.prepare({ id, cwd: sb.work, command: `echo first > ${q(marker)}` });
    assert.equal(p1.prepared, "new");
    assert.equal(p1.state, "claimed");
    const snapshot = () => Object.fromEntries(sb.walk(sb.dir(id)).map((f) => [f, [readFileSync(f).toString("base64"), statSync(f).mtimeMs]]));
    const before = snapshot();
    const p2 = await c.prepare({ id, cwd: sb.work, command: `echo SECOND > ${q(marker)}` });
    assert.equal(p2.prepared, "existing");
    assert.equal(p2.state, "claimed");
    assert.deepEqual(snapshot(), before, "run directory untouched by the second prepare");
    assert.ok(!existsSync(join(sb.home, "stage", id)), "stage cleaned up");
    await c.start(id);
    await sb.readAll(c, id);
    assert.equal(readFileSync(marker, "utf8"), "first\n");
  });

  it("concurrent prepares of one id: exactly one wins the claim and its command is the one stored", async () => {
    await sb.client().install();
    const id = sb.id();
    const cmds = [];
    for (let i = 0; i < 8; i++) {
      const body = Buffer.from(`echo contender-${i}`);
      const f = join(sb.files, `cmd-${id}-${i}`);
      writeFileSync(f, body);
      cmds.push({ f, body, sha: sha256(body) });
    }
    const results = await Promise.all(cmds.map((c) => sb.raw(["prepare", id, "--cwd", sb.work, "--cmd-file", c.f, "--cmd-sha256", c.sha])));
    const winners = results.map((r, i) => [r, i]).filter(([r]) => r.kv.prepared === "new");
    assert.equal(winners.length, 1, results.map((r) => r.stdout).join("---"));
    assert.equal(results.filter((r) => r.kv.prepared === "existing").length, 7);
    assert.deepEqual(readFileSync(join(sb.dir(id), "cmd")), cmds[winners[0][1]].body);
  });

  it("start twice (and six at once) executes the command exactly once", async () => {
    const c = sb.client();
    const counter = sb.out("counter");
    const { id, started } = await sb.launch(c, `echo x >> ${q(counter)}; sleep 0.3`);
    assert.equal(started.started, "new");
    const again = await c.start(id);
    assert.equal(again.started, "already");
    const burst = await Promise.all([1, 2, 3, 4, 5, 6].map(() => sb.client().start(id)));
    assert.ok(burst.every((r) => r.started === "already"));
    await sb.readAll(c, id);
    assert.equal(readFileSync(counter, "utf8"), "x\n");
    assert.equal((await c.start(id)).started, "already", "start after exit does nothing either");
    assert.equal(readFileSync(counter, "utf8"), "x\n");

    // Concurrent first starts: still one execution.
    const counter2 = sb.out("counter");
    const id2 = sb.id();
    await c.prepare({ id: id2, cwd: sb.work, command: `echo y >> ${q(counter2)}; sleep 0.3` });
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => sb.client().start(id2)));
    assert.equal(rs.filter((r) => r.started === "new").length, 1);
    assert.equal(rs.filter((r) => r.started === "already").length, 5);
    await sb.readAll(c, id2);
    assert.equal(readFileSync(counter2, "utf8"), "y\n");
  });

  it("stopping after prepare leaves `claimed`: no process, and nothing but start() can launch it", async () => {
    const c = sb.client();
    const id = sb.id();
    const marker = sb.out("marker");
    await c.prepare({ id, cwd: sb.work, command: `echo ran > ${q(marker)}` });
    // a fresh client (a "restarted control service") looks at it in every way except start
    const c2 = sb.client();
    const st = await c2.status(id);
    assert.equal(st.state, "claimed");
    assert.equal(st.launched, false);
    const w = await c2.wait({ id, from: 0, maxSeconds: 1 });
    assert.equal(w.state, "claimed");
    assert.equal(w.bytes.length, 0);
    assert.equal(w.done, false);
    assert.equal((await c2.kill(id, { graceSeconds: 1 })).killed, "not-found");
    const again = await c2.prepare({ id, cwd: sb.work, command: `echo ran > ${q(marker)}` });
    assert.equal(again.prepared, "existing");
    assert.equal(again.state, "claimed");
    await sleep(800);
    assert.ok(!existsSync(marker), "the command did not run");
    assert.ok(!existsSync(join(sb.dir(id), "ident")) && !existsSync(join(sb.dir(id), "starting")), "no identity, no start latch");
    // ...and an explicit start does run it, once
    assert.equal((await c2.start(id)).started, "new");
    await sb.readAll(c2, id);
    assert.equal(readFileSync(marker, "utf8"), "ran\n");
  });

  it("crash between the start latch and the process identity leaves `claimed` + launched=1 and is never retried", async () => {
    const c = sb.client();
    const id = sb.id();
    const marker = sb.out("marker");
    await c.prepare({ id, cwd: sb.work, command: `echo ran > ${q(marker)}` });
    mkdirSync(join(sb.dir(id), "starting")); // what a start that died right after its mkdir leaves behind
    const r = await c.start(id);
    assert.equal(r.started, "already");
    assert.equal(r.state, "claimed");
    assert.equal(r.launched, true);
    assert.equal((await c.status(id)).launched, true);
    await sleep(600);
    assert.ok(!existsSync(marker), "must not be started: it is unknown whether the first start launched anything");
  });

  it("start throwing before / after the exec took effect: a caller retry cannot run the command twice", async () => {
    const counter = sb.out("counter");
    // after: the command line really ran on the sandbox, then the connection "dropped"
    const flakyAfter = async (command, o) => {
      const r = await sb.bash(command, o);
      if (/runner\.sh' start /.test(command)) throw new Error("connection ended; command may have run");
      return r;
    };
    flakyAfter.supportsEnv = true;
    const c = sb.client({ bash: flakyAfter });
    const id = sb.id();
    await c.prepare({ id, cwd: sb.work, command: `echo x >> ${q(counter)}; sleep 0.3` });
    await assert.rejects(() => c.start(id), /connection ended/);
    const st = await sb.client().status(id);
    assert.ok(["running", "exited"].includes(st.state), `got ${st.state}`);
    assert.equal((await sb.client().start(id)).started, "already");
    await sb.readAll(sb.client(), id);
    assert.equal(readFileSync(counter, "utf8"), "x\n");

    // before: nothing reached the sandbox -> still claimed, and the caller decides
    const counter2 = sb.out("counter");
    const flakyBefore = async (command, o) => {
      if (/runner\.sh' start /.test(command)) throw new Error("could not connect");
      return sb.bash(command, o);
    };
    flakyBefore.supportsEnv = true;
    const c2 = sb.client({ bash: flakyBefore });
    const id2 = sb.id();
    await c2.prepare({ id: id2, cwd: sb.work, command: `echo y >> ${q(counter2)}` });
    await assert.rejects(() => c2.start(id2), /could not connect/);
    assert.equal((await sb.client().status(id2)).state, "claimed");
    await sleep(300);
    assert.ok(!existsSync(counter2));
  });

  it("a client that stopped waiting does not stop the command; a new client picks the run up by id", async () => {
    const c1 = sb.client();
    const { id } = await sb.launch(c1, `for i in 1 2 3 4; do echo line$i; sleep 0.4; done; exit 5`);
    const abandoned = c1.wait({ id, from: 0, maxSeconds: 1 }).catch(() => {}); // control service "goes away"
    void abandoned;
    const c2 = sb.client(); // brand-new client: no memory of c1
    const st = await c2.status(id);
    assert.ok(["running", "exited"].includes(st.state));
    const r = await sb.readAll(c2, id);
    assert.equal(r.text, "line1\nline2\nline3\nline4\n");
    assert.equal(r.exit, 5);
    assert.equal(r.state, "exited");
    assert.equal(r.done, true);
  });

  it("wait blocks until max seconds when nothing new arrives, and returns early on output or exit", async () => {
    const c = sb.client();
    const { id } = await sb.launch(c, "sleep 3; echo late");
    const t0 = Date.now();
    const w = await c.wait({ id, from: 0, maxSeconds: 1 });
    const dt = Date.now() - t0;
    assert.equal(w.state, "running");
    assert.equal(w.bytes.length, 0);
    assert.ok(dt >= 900 && dt < 2800, `waited ${dt} ms`);
    const t1 = Date.now();
    const w2 = await c.wait({ id, from: 0, maxSeconds: 10 });
    assert.equal(w2.text, "late\n");
    assert.ok(Date.now() - t1 < 6000, "returned when output arrived, not at max");
    const fin = await sb.readAll(c, id);
    assert.equal(fin.exit, 0);
  });

  it("wait resumes by byte offset: pieces concatenate to the full log, multi-byte characters split at 32 KiB stay whole", async () => {
    const c = sb.client();
    const line = (i) => `你好世界-${String(i).padStart(5, "0")}-€€€ \n`;
    let expected = "";
    for (let i = 0; i < 3000; i++) expected += line(i);
    const expBytes = Buffer.from(expected, "utf8");
    assert.equal(expBytes.length, 90_000);
    assert.equal(expBytes[MAX_WAIT_BYTES] & 0xc0, 0x80, "sanity: the first 32 KiB boundary falls inside a character");
    const id = (await sb.launch(c, `i=0; while [ $i -lt 3000 ]; do printf '%s-%05d-%s \\n' '你好世界' $i '€€€'; i=$((i+1)); done`)).id;
    await until(async () => (await c.status(id)).state === "exited", { what: "exit" });
    const r = await sb.readAll(sb.client(), id);
    assert.deepEqual(r.bytes, expBytes, "raw bytes identical");
    assert.equal(r.text, expected, "decoded text identical (no replacement characters)");
    assert.ok(r.sizes.every((n) => n <= MAX_WAIT_BYTES), `chunk sizes ${r.sizes}`);
    assert.deepEqual(r.sizes.slice(0, 2), [MAX_WAIT_BYTES, MAX_WAIT_BYTES]);
    assert.ok(r.sizes.length >= 3);
    // resuming from an arbitrary earlier offset gives the same bytes
    const mid = await c.wait({ id, from: 1000, maxSeconds: 1, decoder: { decode: () => "" } });
    assert.deepEqual(mid.bytes, expBytes.subarray(1000, 1000 + MAX_WAIT_BYTES));
    assert.equal(mid.offset, 1000 + MAX_WAIT_BYTES);
    // asking past the end yields nothing and the same offset
    const end = await c.wait({ id, from: 90_000, maxSeconds: 1 });
    assert.equal(end.bytes.length, 0);
    assert.equal(end.offset, 90_000);
    assert.equal(end.done, true);
  });

  it("exit status: non-zero, command not found, killed by a signal, missing cwd", async () => {
    const c = sb.client();
    const r1 = await sb.run(c, "echo out; echo err >&2; exit 7");
    assert.equal(r1.exit, 7);
    assert.match(r1.text, /out\n/);
    assert.match(r1.text, /err\n/, "stderr is merged into the log");
    const r2 = await sb.run(c, "definitely_not_a_command_xyz");
    assert.equal(r2.exit, 127);
    assert.match(r2.text, /not found/);
    const r3 = await sb.run(c, "kill -9 $$");
    assert.equal(r3.exit, 137, "killed by SIGKILL -> 128+9");
    const r4 = await sb.run(c, "kill -TERM $$");
    assert.equal(r4.exit, 143);
    const r5 = await sb.run(c, "true", { cwd: join(sb.work, "no-such-dir") });
    assert.equal(r5.exit, 126);
    assert.match(r5.text, /cannot cd|No such file/);
    const pwdOut = sb.out("pwd");
    await sb.run(c, `pwd -P > ${q(pwdOut)}`);
    assert.equal(readFileSync(pwdOut, "utf8").trim(), realpathSync(sb.work), "runs in the requested cwd");
  });

  it("the user's command runs under bash even when the wrapper shell is dash (arrays, [[ ]], <(...), {1..3}, $'..')", { skip: existsSync("/bin/bash") ? false : "no /bin/bash on this machine" }, async () => {
    const c = sb.client();
    await c.install();
    const cmd = `arr=(x y z); echo "arr=\${arr[1]}"; [[ abc == a* ]] && echo dbl-bracket; echo {1..3}; diff <(echo 1) <(echo 1) && echo procsub; echo $'a\\tb' | od -c | head -1; echo "shell=$(readlink /proc/$$/exe 2>/dev/null || echo unknown)"`;
    const r = await sb.run(c, cmd);
    assert.equal(r.exit, 0, r.text);
    assert.match(r.text, /arr=y/);
    assert.match(r.text, /dbl-bracket/);
    assert.match(r.text, /1 2 3/);
    assert.match(r.text, /procsub/);
  });

  it("PCA_CMD_SH overrides the command shell; the wrapper itself keeps using PCA_SH", { skip: DASH ? false : "no dash on this machine (macOS /bin/sh is bash)" }, async () => {
    const c = sb.client();
    await c.install();
    const marker = sb.out("cmd-shell");
    const saved = sb.env.PCA_CMD_SH;
    sb.env.PCA_CMD_SH = DASH;
    try {
      const r = await sb.run(c, `echo "BASH_VERSION=\${BASH_VERSION:-none}" > ${q(marker)}`);
      assert.equal(r.exit, 0, r.text);
      assert.match(readFileSync(marker, "utf8"), /BASH_VERSION=none/, "dash does not define BASH_VERSION");
    } finally {
      if (saved === undefined) delete sb.env.PCA_CMD_SH;
      else sb.env.PCA_CMD_SH = saved;
    }
  });

  it("kill takes down the whole process group, and the exit is recorded", async () => {
    const c = sb.client();
    const pidfile = sb.out("childpid");
    const { id } = await sb.launch(c, `sleep 120 & echo $! > ${q(pidfile)}; wait`);
    const childPid = Number(await until(() => existsSync(pidfile) && readFileSync(pidfile, "utf8").trim(), { what: "child pid" }));
    sb.extraPids.add(childPid);
    assert.ok(alive(childPid));
    const k = await c.kill(id, { graceSeconds: 3 });
    assert.equal(k.killed, "confirmed");
    await until(() => !alive(childPid), { what: "child gone" });
    const st = await c.status(id);
    assert.equal(st.state, "exited");
    assert.equal(st.exit, 143);
    assert.equal((await c.kill(id)).killed, "not-found", "nothing left to kill");
  });

  it("kill escalates to SIGKILL after the grace period for a command that ignores SIGTERM", async () => {
    const c = sb.client();
    const { id } = await sb.launch(c, `trap '' TERM; while :; do sleep 1; done`);
    await sleep(300);
    const t0 = Date.now();
    const k = await c.kill(id, { graceSeconds: 1 });
    assert.equal(k.killed, "confirmed");
    assert.ok(Date.now() - t0 >= 900, "waited out the grace period first");
    const st = await c.status(id);
    assert.equal(st.state, "exited");
    assert.equal(st.exit, 137);
  });

  it("kill does nothing when the recorded identity does not match", async () => {
    const c = sb.client();
    const { id } = await sb.launch(c, "sleep 30");
    await sleep(200);
    const identFile = join(sb.dir(id), "ident");
    const original = readFileSync(identFile, "utf8");
    const pid = Number(parseKeyValues(original).pid);
    const forged = [
      ["start ticks", original.replace(/^start=.*$/m, "start=1")],
      ["boot id", original.replace(/^boot_id=.*$/m, "boot_id=00000000-dead-beef-0000-000000000000")],
      ["pid of an unrelated live process (this test runner)", original.replace(/^pid=.*$/m, `pid=${process.pid}`).replace(/^pgid=.*$/m, `pgid=${process.pid}`)],
    ];
    for (const [what, text] of forged) {
      writeFileSync(identFile, text);
      const st = await c.status(id);
      assert.equal(st.state, "lost", what);
      const k = await c.kill(id, { graceSeconds: 1 });
      assert.equal(k.killed, "not-found", what);
      assert.ok(alive(pid), `${what}: real process must still be alive`);
      assert.ok(alive(process.pid), `${what}: runner must not touch the test runner`);
    }
    // pgid that is not the wrapper's own pid is refused even though pid/start match
    writeFileSync(identFile, original.replace(/^pgid=.*$/m, "pgid=1"));
    const k = await c.kill(id, { graceSeconds: 1 });
    assert.equal(k.killed, "not-found");
    assert.equal(k.reason, "bad-ident");
    assert.ok(alive(pid));
    // restored identity -> the kill works
    writeFileSync(identFile, original);
    assert.equal((await c.kill(id, { graceSeconds: 2 })).killed, "confirmed");
  });

  it("`exit` removed and the process gone -> lost; unknown id -> missing; neither is ever restarted", async () => {
    const c = sb.client();
    const counter = sb.out("counter");
    const { id } = await sb.launch(c, `echo x >> ${q(counter)}`);
    const first = await sb.readAll(c, id);
    assert.equal(first.exit, 0);
    unlinkSync(join(sb.dir(id), "exit"));
    const st = await c.status(id);
    assert.equal(st.state, "lost");
    assert.equal(st.exit, undefined);
    const w = await c.wait({ id, from: 0, maxSeconds: 1 });
    assert.equal(w.state, "lost");
    assert.equal(w.done, false, "lost is not a completion");
    assert.equal((await c.start(id)).started, "already");
    assert.equal((await c.prepare({ id, cwd: sb.work, command: `echo x >> ${q(counter)}` })).prepared, "existing");
    await sleep(300);
    assert.equal(readFileSync(counter, "utf8"), "x\n", "still one execution");

    const ghost = sb.id();
    assert.equal((await c.status(ghost)).state, "missing");
    const s = await c.start(ghost);
    assert.equal(s.started, "no");
    assert.equal(s.state, "missing");
    assert.equal((await c.kill(ghost)).killed, "not-found");
    assert.equal((await c.wait({ id: ghost, from: 0, maxSeconds: 1 })).state, "missing");
    assert.ok(!existsSync(sb.dir(ghost)), "nothing was created for an unknown id");
  });

  it("a 25 KiB command made of every byte 0x01-0xFF runs byte-for-byte; staging uses small chunks", async () => {
    const c = sb.client();
    const all = Buffer.alloc(255);
    for (let i = 0; i < 255; i++) all[i] = i + 1; // 0x01..0xFF, no NUL
    const payload = Buffer.concat(Array.from({ length: 100 }, () => all));
    const outFile = sb.out("bytes");
    const quoted = Buffer.from(payload.toString("latin1").replaceAll("'", "'\\''"), "latin1");
    const command = Buffer.concat([Buffer.from("printf %s '"), quoted, Buffer.from(`' > ${q(outFile)}`)]);
    assert.ok(command.length > 25_000);
    const n0 = sb.calls.length;
    const r = await sb.run(c, command);
    assert.equal(r.exit, 0, r.text);
    assert.deepEqual(readFileSync(outFile), payload, "payload arrived unchanged");
    assert.equal(sha256(readFileSync(join(sb.dir(r.id), "cmd"))), sha256(command), "stored command is exactly what was sent");
    const lens = sb.calls.slice(n0).map((x) => x.command.length);
    assert.ok(Math.max(...lens) < 20_000, `largest exec was ${Math.max(...lens)} chars (Sprite limit is 64,000 after URL encoding)`);
  });

  it("commands around chunk boundaries (12 KiB multiples) are assembled correctly", async () => {
    const c = sb.client();
    for (const size of [12 * 1024, 12 * 1024 + 1, 24 * 1024, 40_000]) {
      const outFile = sb.out("bnd");
      const prefix = `printf %s '`;
      const suffix = `' > ${q(outFile)}`;
      const body = "ab\n".repeat(Math.ceil(size / 3)).slice(0, size - prefix.length - suffix.length);
      const command = prefix + body + suffix;
      assert.equal(Buffer.byteLength(command), size);
      const r = await sb.run(c, command);
      assert.equal(r.exit, 0);
      assert.equal(readFileSync(outFile, "utf8"), body, `size ${size}`);
    }
  });

  it("a bad upload is rejected before the id is claimed", async () => {
    await sb.client().install();
    const id = sb.id();
    const f = join(sb.files, `bad-${id}`);
    writeFileSync(f, "echo hi");
    const r = await sb.raw(["prepare", id, "--cwd", sb.work, "--cmd-file", f, "--cmd-sha256", "0".repeat(64)]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.kv.error, "sha-mismatch");
    assert.ok(!existsSync(sb.dir(id)), "id not burned");
    const r2 = await sb.raw(["prepare", id, "--cwd", sb.work, "--cmd-file", join(sb.files, "nope"), "--cmd-sha256", "0".repeat(64)]);
    assert.equal(r2.kv.error, "stage-missing");
    const r3 = await sb.raw(["prepare", "../escape", "--cwd", sb.work, "--cmd-file", f, "--cmd-sha256", sha256("echo hi")]);
    assert.equal(r3.kv.error, "bad-id");
    const r4 = await sb.raw(["frobnicate", id]);
    assert.equal(r4.kv.error, "bad-command");
    const ef = join(sb.files, `env-${id}`);
    writeFileSync(ef, "TOKEN=sk-leaky\n");
    const r5 = await sb.raw(["prepare", id, "--cwd", sb.work, "--cmd-file", f, "--cmd-sha256", sha256("echo hi"), "--env-file", ef]);
    assert.equal(r5.kv.error, "env-file-has-value");
    assert.ok(!existsSync(sb.dir(id)));
  });

  it("environment values reach the command but are never written anywhere nor sent in a command line", async () => {
    const c = sb.client();
    const SECRET = `sk-test-${randomBytes(12).toString("hex")}`;
    const OTHER = `ghp_${randomBytes(10).toString("hex")}`;
    const outFile = sb.out("secret");
    const n0 = sb.calls.length;
    const { id } = await sb.launch(c, `printf '%s|%s' "$FAKE_SECRET" "$FAKE_OTHER" > ${q(outFile)}`, { env: { FAKE_SECRET: SECRET, FAKE_OTHER: OTHER } });
    const r = await sb.readAll(c, id);
    assert.equal(r.exit, 0);
    assert.equal(readFileSync(outFile, "utf8"), `${SECRET}|${OTHER}`, "the command saw the values (inherited from start's environment)");
    for (const secret of [SECRET, OTHER]) {
      const needles = [secret, Buffer.from(secret).toString("base64"), encodeURIComponent(secret), Buffer.from(secret).toString("hex")];
      for (const file of sb.walk(sb.home)) {
        const bytes = readFileSync(file).toString("latin1");
        for (const n of needles) assert.ok(!bytes.includes(n), `${file} leaks a secret`);
      }
      for (const call of sb.calls.slice(n0)) for (const n of needles) assert.ok(!call.command.includes(n), "secret in a command line");
    }
    const dir = sb.dir(id);
    assert.ok(!existsSync(join(sb.home, "stage", id)), "stage removed");
    const meta = parseKeyValues(readFileSync(join(dir, "meta"), "utf8"));
    assert.equal(meta.env_names, "FAKE_SECRET,FAKE_OTHER");
    assert.ok(!readFileSync(join(dir, "cmd"), "utf8").includes("FAKE_SECRET="));
    const withEnv = sb.calls.slice(n0).filter((x) => x.envNames);
    assert.equal(withEnv.length, 1, "values travel only on the start exec");
    assert.deepEqual(withEnv[0].envNames, ["FAKE_SECRET", "FAKE_OTHER"]);
    assert.match(withEnv[0].command, /runner\.sh' start /);
  });

  it("start refuses to run when a declared environment variable is not set, and does not latch", async () => {
    const c = sb.client();
    const marker = sb.out("marker");
    const id = sb.id();
    await c.prepare({ id, cwd: sb.work, command: `echo ok > ${q(marker)}`, env: { NEEDED_VAR: "value-1234567" } });
    const other = sb.client(); // a restarted service has no values
    await assert.rejects(() => other.start(id), (e) => e instanceof RunnerError && e.code === "env-missing");
    const st = await other.status(id);
    assert.equal(st.state, "claimed");
    assert.equal(st.launched, false);
    assert.ok(!existsSync(marker));
    assert.equal((await other.start(id, { env: { NEEDED_VAR: "value-1234567" } })).started, "new");
    await sb.readAll(other, id);
    assert.equal(readFileSync(marker, "utf8"), "ok\n");
  });

  it("env is refused (and nothing staged) when the bash primitive cannot pass env", async () => {
    const n0 = sb.calls.length;
    const noEnv = async (command, o) => sb.bash(command, o);
    const c = sb.client({ bash: noEnv });
    const id = sb.id();
    await assert.rejects(() => c.prepare({ id, cwd: sb.work, command: "true", env: { TOKEN: "sk-should-not-be-staged" } }), (e) => e.code === "RUNNER_ENV_UNSUPPORTED");
    assert.equal(sb.calls.length, n0);
    assert.ok(!existsSync(join(sb.home, "stage", id)));
  });

  it("the run directory holds no environment values: meta lists names only", async () => {
    const c = sb.client();
    const id = sb.id();
    await c.prepare({ id, cwd: sb.work, command: "true", env: { A_B1: "value-aaaa1111", C_D2: "value-bbbb2222" } });
    const meta = readFileSync(join(sb.dir(id), "meta"), "utf8");
    assert.match(meta, /^env_names=A_B1,C_D2$/m);
    assert.ok(!meta.includes("value-aaaa1111") && !meta.includes("value-bbbb2222"));
    assert.deepEqual(sb.walk(join(sb.home, "stage")).filter((f) => f.includes(id)), []);
  });

  it("ident matches the kernel's view (real /proc)", { skip: HAS_PROC ? false : "no /proc on this platform (macOS): process identity is only checked against the injected fake" }, async () => {
    const c = sb.client();
    const { id } = await sb.launch(c, "sleep 5");
    const ident = parseKeyValues(readFileSync(join(sb.dir(id), "ident"), "utf8"));
    const stat = readFileSync(`/proc/${ident.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    assert.equal(ident.start, fields[19], "field 22 of /proc/<pid>/stat");
    assert.equal(ident.pgid, fields[2], "field 5 (pgrp)");
    assert.equal(ident.pgid, ident.pid, "wrapper is its own group leader");
    assert.equal(ident.boot_id, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
    assert.equal((await c.kill(id, { graceSeconds: 2 })).killed, "confirmed");
  });

  it("stat parsing survives ') ' inside comm", { skip: HAS_PROC ? "real /proc in use: comm is not controllable" : false }, async () => {
    const c = sb.client();
    const { id } = await sb.launch(c, "sleep 5");
    const pid = parseKeyValues(readFileSync(join(sb.dir(id), "ident"), "utf8")).pid;
    assert.match(readFileSync(join(sb.procRoot, pid, "stat"), "utf8"), /\(w\) S 9 \(x y\)/);
    assert.equal((await c.status(id)).state, "running");
    assert.equal((await c.kill(id, { graceSeconds: 2 })).killed, "confirmed");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The same core flow under each shell flavour that exists on this machine.
for (const [name, path] of [["dash", DASH], ["sh", PLAIN_SH]]) {
  const skip = !CAN_RUN ? skipAll : !path ? `${name} not available` : path === MAIN_SHELL ? "already covered by the full suite above" : false;
  describe(`runner.sh smoke under ${name} (${path ?? "n/a"})`, { skip }, () => {
    /** @type {Sandbox} */
    let sb;
    before(() => {
      sb = new Sandbox({ shell: path });
    });
    after(() => sb?.cleanup());

    it("prepare / start once / read multi-byte output / exit code / kill", async () => {
      const c = sb.client();
      await c.install();
      const counter = sb.out("counter");
      const { id } = await sb.launch(c, `echo x >> ${q(counter)}; printf 'héllo wörld €\\n'; exit 3`);
      assert.equal((await c.start(id)).started, "already");
      const r = await sb.readAll(c, id);
      assert.equal(r.text, "héllo wörld €\n");
      assert.equal(r.exit, 3);
      assert.equal(readFileSync(counter, "utf8"), "x\n");
      const long = await sb.launch(c, "sleep 30 & wait");
      await sleep(200);
      assert.equal((await c.kill(long.id, { graceSeconds: 2 })).killed, "confirmed");
      assert.equal((await c.status(long.id)).exit, 143);
      const claimed = sb.id();
      await c.prepare({ id: claimed, cwd: sb.work, command: "true" });
      assert.equal((await c.status(claimed)).state, "claimed");
    });

    it("every byte except NUL survives the round trip", async () => {
      const c = sb.client();
      const all = Buffer.alloc(255);
      for (let i = 0; i < 255; i++) all[i] = i + 1;
      const outFile = sb.out("bytes");
      const quoted = Buffer.from(all.toString("latin1").replaceAll("'", "'\\''"), "latin1");
      const command = Buffer.concat([Buffer.from("printf %s '"), quoted, Buffer.from(`' > ${q(outFile)}`)]);
      const r = await sb.run(c, command);
      assert.equal(r.exit, 0);
      assert.deepEqual(readFileSync(outFile), all);
    });
  });
}

// Optional: against a real Sprite. Opt-in only; never runs by default and never from this file's default test run.
describe("runner on a real Sprite", { skip: process.env.TARSBOT_LIVE_SPRITE ? "not implemented in M1-04: run the checks above through the Sprites provider (M1-14)" : "set TARSBOT_LIVE_SPRITE to enable (not implemented here; needs a pca- test Sprite)" }, () => {
  it("placeholder", () => {});
});
