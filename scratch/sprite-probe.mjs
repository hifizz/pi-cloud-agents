// S0-probe: measure @fly/sprites@0.2.3 and Sprites platform behaviour. Usage:
//   node scratch/sprite-probe.mjs <probe> [args]      probes: info p1 p2 p3 p4 p5 p6 <min> p7 [idleSec] p8 p9 p10 p11 p12 sh <cmd> all-quick
// Safety: operates ONLY on the Sprite named below (hard-checked against TARSBOT_SPRITE_NAME); never lists the org's
// Sprites; never prints tokens (all output goes through redact()). SDK errors embed the exec URL (which carries env
// values and argv) so every message is redacted.
import { createHash } from "node:crypto";
import { SpritesClient, ExecError } from "@fly/sprites";

process.loadEnvFile(".env");

export const NAME = "pi-cloud-agents";
if (process.env.TARSBOT_SPRITE_NAME !== NAME) {
  console.error(`refusing to run: TARSBOT_SPRITE_NAME must be exactly "${NAME}"`);
  process.exit(2);
}
const TOKEN = process.env.SPRITES_TOKEN;
if (!TOKEN) {
  console.error("SPRITES_TOKEN missing in .env");
  process.exit(2);
}
const BASE = "https://api.sprites.dev";
const SECRETS = [TOKEN, process.env.GITHUB_TOKEN].filter(Boolean);

/** Remove secrets and exec-URL query strings (they carry env values / argv) from any text. */
export function redact(s) {
  let t = String(s ?? "");
  for (const v of SECRETS) t = t.split(v).join("<redacted>");
  t = t.replace(/(wss?:\/\/[^\s)?]+)\?[^\s)]*/g, "$1?<query-redacted>");
  return t;
}
const say = (...a) => console.log(redact(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const ms = (t0) => Math.round(now() - t0);
const sha = (b) => createHash("sha256").update(b).digest("hex");

export const client = new SpritesClient(TOKEN);
export const sprite = client.sprite(NAME);

// ---------------------------------------------------------------- REST helper (only paths under our Sprite)
async function rest(method, path, body) {
  const t0 = now();
  const res = await fetch(`${BASE}/v1/sprites/${encodeURIComponent(NAME)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  return { status: res.status, text: redact(text), ms: ms(t0) };
}

// ---------------------------------------------------------------- Sprite info / status
async function status() {
  const s = await client.getSprite(NAME);
  return { status: s.status, lastRunningAt: s.lastRunningAt?.toISOString?.(), lastWarmingAt: s.lastWarmingAt?.toISOString?.(), version: s.version };
}

/** Poll status every `everyMs`, print transitions; stop() returns the full log. */
function pollStatus(label, everyMs = 5000) {
  const t0 = Date.now();
  const log = [];
  let last;
  let stopped = false;
  const tick = async () => {
    try {
      const s = await status();
      const t = Math.round((Date.now() - t0) / 1000);
      log.push({ t, status: s.status });
      if (s.status !== last) {
        last = s.status;
        say(`  [${label}] +${t}s status=${s.status}`);
      }
    } catch (e) {
      say(`  [${label}] status poll error: ${redact(e.message).slice(0, 120)}`);
    }
  };
  tick();
  const h = setInterval(() => !stopped && tick(), everyMs);
  return {
    stop() {
      stopped = true;
      clearInterval(h);
      return log;
    },
  };
}

async function ensureSprite() {
  const t0 = now();
  try {
    const s = await status();
    say("sprite exists:", s, `(${ms(t0)}ms)`);
    return { created: false };
  } catch (e) {
    if (e?.statusCode !== 404 && !/404|not found/i.test(String(e?.message))) throw e;
  }
  say("sprite does not exist; creating", NAME);
  const t1 = now();
  const sp = await client.createSprite(NAME, { waitForCapacity: true });
  say("created in", ms(t1), "ms; status=", sp.status, "url? ", sp.url ? "(has url)" : "(none)");
  return { created: true, createMs: ms(t1) };
}

// ---------------------------------------------------------------- THE recommended exec primitive (see docs/sprites-probe.md P1)
/**
 * Run argv on the Sprite over the WebSocket exec protocol. Never rejects.
 * @returns {{stdout:Buffer, stderr:Buffer, exitCode:number|null, timedOut:boolean, error?:string, openMs:number|null, totalMs:number, closeInfo?:object}}
 *  exitCode === -1  -> WebSocket closed without an exit frame (connection lost / paused / killed by platform).
 *  exitCode === null -> client side error (connect failure) or timeout without exit frame; see `error` / `timedOut`.
 */
export function runExec(sp, argv, o = {}) {
  const { env, cwd, input, timeoutMs, killSignal = "SIGTERM", killGraceMs = 5000, collect = true, onStdout, abortAfterMs, abortMode = "kill", signal } = o;
  const [file, ...args] = argv;
  const t0 = now();
  return new Promise((resolve) => {
    const cmd = sp.spawn(file, args, { env, cwd });
    const out = [];
    const err = [];
    let outBytes = 0;
    let done = false;
    let timedOut = false;
    let openMs = null;
    let closeInfo;
    const timers = [];
    const finish = (extra) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try {
        cmd.close();
      } catch {}
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), outBytes, timedOut, openMs, totalMs: ms(t0), closeInfo, ...extra });
    };
    cmd.stdout.on("data", (c) => {
      outBytes += c.length;
      if (collect) out.push(c);
      onStdout?.(c);
    });
    cmd.stderr.on("data", (c) => err.push(c));
    cmd.on("spawn", () => {
      openMs = ms(t0);
      // Diagnostics only: SDK keeps the WebSocket in a private field; capture its close code/reason.
      try {
        cmd.wsCmd.ws.addEventListener("close", (e) => (closeInfo = { code: e.code, reason: e.reason || "", atMs: ms(t0) }));
      } catch {}
      // stdin MUST be ended after the socket is open, otherwise the EOF frame is silently dropped (sendStdinEOF checks readyState).
      if (input !== undefined) cmd.stdin.write(input);
      cmd.stdin.end();
    });
    cmd.on("exit", (code) => setImmediate(() => finish({ exitCode: code })));
    cmd.on("error", (e) => finish({ exitCode: null, error: redact(e.message) }));
    const stop = (mode) => {
      if (mode === "close") return finish({ exitCode: null, aborted: "close" });
      timedOut = true;
      cmd.kill(killSignal); // exit frame normally follows; otherwise give up after grace
      timers.push(setTimeout(() => finish({ exitCode: null }), killGraceMs));
    };
    if (timeoutMs) timers.push(setTimeout(() => stop("kill"), timeoutMs));
    if (abortAfterMs) timers.push(setTimeout(() => stop(abortMode), abortAfterMs));
    signal?.addEventListener("abort", () => stop("kill"), { once: true });
  });
}

const str = (b) => b.toString("utf8");
/** Run a shell script via /bin/sh -c; returns compact summary. */
async function sh(script, o = {}) {
  const r = await runExec(sprite, ["/bin/sh", "-c", script], o);
  return { ...r, out: str(r.stdout), err: str(r.stderr) };
}
const brief = (r) => ({ exit: r.exitCode, ms: r.totalMs, openMs: r.openMs, out: r.out?.trim().slice(0, 400), err: r.err?.trim().slice(0, 300), ...(r.error ? { error: r.error } : {}) });

// ================================================================ probes
const probes = {};

probes.info = async () => {
  say(await status());
};

probes.p1 = async () => {
  say("== P1 SDK API shape (static, from dist/*.d.ts) ==");
  say("client = new SpritesClient(token, {baseURL?, timeout?, controlMode?}); sprite = client.sprite(name) (no HTTP); await client.getSprite(name) -> Sprite{status,...}; client.createSprite(name,{config,waitForCapacity,...})");
  say("sprite.spawn(file, args[], {env:{K:V}, cwd, tty, detachable, maxRunAfterDisconnect}) -> SpriteCommand (EventEmitter; stdin/stdout/stderr streams; wait(); kill(sig); close(); exitCode())");
  say("sprite.execFile(file, args[], {env,cwd,timeout,signal,maxBuffer,encoding}) -> {stdout,stderr,exitCode}; REJECTS ExecError on exitCode!=0; sprite.exec(str) splits on whitespace (NOT a shell)");
  say("== P1 live: termination semantics ==");
  // (a) kill SIGTERM
  let r = await runExec(sprite, ["sleep", "301"], { abortAfterMs: 3000, abortMode: "kill", killSignal: "SIGTERM" });
  say("(a) kill(SIGTERM) on `sleep 301`:", { exitCode: r.exitCode, ms: r.totalMs, closeInfo: r.closeInfo, timedOut: r.timedOut });
  await sleep(1500);
  let ps = await sh("ps -eo pid,etimes,args | grep '[s]leep 301' || echo none");
  say("   remote after kill+1.5s:", ps.out.trim());
  // (b) kill SIGKILL
  r = await runExec(sprite, ["sleep", "303"], { abortAfterMs: 3000, abortMode: "kill", killSignal: "SIGKILL" });
  say("(b) kill(SIGKILL) on `sleep 303`:", { exitCode: r.exitCode, ms: r.totalMs, closeInfo: r.closeInfo });
  await sleep(1500);
  ps = await sh("ps -eo pid,etimes,args | grep '[s]leep 303' || echo none");
  say("   remote after kill+1.5s:", ps.out.trim());
  // (c) close() only (no signal)
  r = await runExec(sprite, ["sleep", "302"], { abortAfterMs: 3000, abortMode: "close" });
  say("(c) ws.close() only on `sleep 302`:", { exitCode: r.exitCode, ms: r.totalMs });
  for (const wait of [2000, 10000, 20000]) {
    await sleep(wait);
    ps = await sh("ps -eo pid,etimes,args | grep '[s]leep 302' || echo none");
    say(`   remote after close +${wait}ms (cumulative step):`, ps.out.trim());
  }
  // (d) AbortSignal through SDK execFile
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 3000);
  const t0 = now();
  try {
    await sprite.execFile("sleep", ["304"], { signal: ac.signal });
  } catch (e) {
    say("(d) execFile({signal}) rejects:", { name: e.name, message: redact(e.message), ms: ms(t0) });
  }
  await sleep(1500);
  ps = await sh("ps -eo pid,etimes,args | grep '[s]leep 304' || echo none");
  say("   remote after abort+1.5s:", ps.out.trim());
  // (e) execFile timeout
  const t1 = now();
  try {
    await sprite.execFile("sleep", ["305"], { timeout: 3000 });
  } catch (e) {
    say("(e) execFile({timeout}) rejects:", { name: e.name, message: redact(e.message), ms: ms(t1) });
  }
  await sleep(1500);
  ps = await sh("ps -eo pid,etimes,args | grep '[s]leep 30[0-9]' || echo none");
  say("   remote sleeps still alive:", ps.out.trim());
  await sh("pkill -x sleep || true");
};

probes.p2 = async () => {
  say("== P2 basic correctness ==");
  const argv = ["/bin/sh", "-c", "echo out; echo err >&2; exit 3"];
  const r = await runExec(sprite, argv);
  say("spawn-based runExec:", { stdout: str(r.stdout), stderr: str(r.stderr), exitCode: r.exitCode, openMs: r.openMs, totalMs: r.totalMs });
  try {
    const x = await sprite.execFile(argv[0], argv.slice(1));
    say("sdk execFile resolved?!", x);
  } catch (e) {
    say("sdk execFile rejects:", { isExecError: e instanceof ExecError, exitCode: e.exitCode, stdout: String(e.stdout), stderr: String(e.stderr), message: redact(e.message) });
  }
  say("-- edge cases --");
  say("exit 300 (mod 256):", brief(await sh("exit 300")));
  say("kill -9 self:", brief(await sh("kill -9 $$")));
  say("kill -TERM self:", brief(await sh("kill -TERM $$")));
  const nb = await runExec(sprite, ["/nonexistent/bin"]);
  say("nonexistent binary:", { exit: nb.exitCode, out: str(nb.stdout).trim(), err: str(nb.stderr).trim(), error: nb.error, ms: nb.totalMs });
  const bc = await runExec(sprite, ["/bin/sh", "-c", "pwd"], { cwd: "/nonexistent/dir" });
  say("nonexistent cwd:", { exit: bc.exitCode, out: str(bc.stdout).trim(), err: str(bc.stderr).trim(), error: bc.error });
  const cwdOk = await runExec(sprite, ["/bin/sh", "-c", "pwd"], { cwd: "/tmp" });
  say("cwd=/tmp:", str(cwdOk.stdout).trim());
  const dflt = await runExec(sprite, ["/bin/sh", "-c", "pwd; echo HOME=$HOME; echo PATH=$PATH; id -un"]);
  say("default env:", str(dflt.stdout).trim().split("\n"));
  // stdin handling: cat reads until EOF
  const cat = await runExec(sprite, ["cat"], { input: "hello-stdin", timeoutMs: 15000 });
  say("cat with stdin ended after open:", { out: str(cat.stdout), exit: cat.exitCode, timedOut: cat.timedOut });
  const t0 = now();
  try {
    const x = await sprite.execFile("cat", [], { timeout: 12000 });
    say("SDK execFile(cat) returned:", { out: String(x.stdout), ms: ms(t0) });
  } catch (e) {
    say("SDK execFile(cat) (stdin never closed):", { name: e.name, message: redact(e.message), ms: ms(t0) });
  }
  await sh("pkill -x cat || true");
  // stdin that reads 'read' with no input
  const rd = await runExec(sprite, ["/bin/sh", "-c", "read x; echo got=[$x]"], { timeoutMs: 15000 });
  say("`read` with EOF stdin:", { out: str(rd.stdout).trim(), exit: rd.exitCode, timedOut: rd.timedOut });
  // argv quoting round trip
  const weird = ["a b", "q'uote", 'd"q', "$HOME", "`id`", "new\nline", "ünï-中文-🙂", "a&b=c+d%20e?f#g", "", "  lead", "back\\slash", "x".repeat(2000)];
  const rt = await runExec(sprite, ["/bin/sh", "-c", 'for a in "$@"; do printf "%s\\0" "$a"; done', "sh", ...weird]);
  const got = str(rt.stdout).split("\0");
  got.pop();
  say("argv round-trip identical:", JSON.stringify(got) === JSON.stringify(weird), got.length, "of", weird.length, rt.error ?? "");
  if (JSON.stringify(got) !== JSON.stringify(weird)) weird.forEach((w, i) => got[i] !== w && say("   mismatch", i, JSON.stringify(w.slice(0, 40)), "->", JSON.stringify((got[i] ?? "<missing>").slice(0, 40))));
};

probes.p3 = async () => {
  say("== P3 env injection ==");
  const argv = ["/bin/sh", "-c", 'test "$PROBE_SECRET" = xyz'];
  const r = await runExec(sprite, argv, { env: { PROBE_SECRET: "xyz" } });
  say("test \"$PROBE_SECRET\" = xyz ->", { exitCode: r.exitCode, ms: r.totalMs });
  say("argv contains secret text?", argv.some((a) => a.includes("xyz")), "(argv:", JSON.stringify(argv), ")");
  const again = await sh('test -z "$PROBE_SECRET" && echo clean || echo LEAKED');
  say("next exec without env sees:", again.out.trim());
  const cmdline = await runExec(sprite, ["/bin/sh", "-c", 'tr "\\0" " " < /proc/$$/cmdline; echo; echo -n "env has it: "; tr "\\0" "\\n" < /proc/$$/environ | grep -c "^PROBE_SECRET=xyz$"'], { env: { PROBE_SECRET: "xyz" } });
  say("remote /proc view:", str(cmdline.stdout).trim().split("\n"));
  const disk = await sh("grep -rIl 'PROBE_SECRET' /home/sprite /tmp /root 2>/dev/null | head -5; echo scan-done");
  say("secret/env name found on disk (home,/tmp):", disk.out.trim());
  const odd = ["A=with=equals", "B=with space", "C=new\nline", "D=ünï中文", "E=a&b%20c+d", "F="];
  const ev = await runExec(sprite, ["/bin/sh", "-c", 'printf "[%s]\\n" "$A" "$B" "$C" "$D" "$E" "$F"'], { env: Object.fromEntries(odd.map((x) => { const i = x.indexOf("="); return [x.slice(0, i), x.slice(i + 1)]; })) });
  say("odd env values:", JSON.stringify(str(ev.stdout)));
  // Does an SDK-level error leak env values? Simulate with a dead local endpoint and fake secret (no real token).
  const fake = new SpritesClient("fake-token-not-real", { baseURL: "http://127.0.0.1:9" });
  const fr = await runExec(fake.sprite("nonexistent-local"), ["true"], { env: { PROBE_SECRET: "xyz-leak-check" } });
  say("raw SDK error text (UNREDACTED, local fake endpoint) leaks env value?", /xyz-leak-check/.test(String(fr.error)) || "see below");
  // fr.error is already passed through redact(); re-run raw to prove the leak exists
  const rawErr = await new Promise((res) => {
    const c = fake.sprite("nonexistent-local").spawn("true", [], { env: { PROBE_SECRET: "xyz-leak-check" } });
    c.on("error", (e) => res(e.message));
  });
  say("raw SDK error contains env value:", rawErr.includes("xyz-leak-check"), "| contains argv:", rawErr.includes("cmd=true"), "| redacted form:", redact(rawErr).slice(0, 160));
};

probes.p4 = async () => {
  say("== P4 large output ==");
  // 5,000,000 random bytes -> base64 (6,666,668 chars), compare with sha computed remotely
  const w = await sh("head -c 5000000 /dev/urandom | base64 -w0 > /tmp/p4.b64; wc -c < /tmp/p4.b64; sha256sum < /tmp/p4.b64");
  const [remoteLen, remoteSha] = w.out.trim().split(/\s+/);
  say("remote file:", { len: remoteLen, sha: remoteSha?.slice(0, 16) });
  for (const label of ["spawn-based runExec", "sdk execFile", "spawn-based runExec", "sdk execFile", "sdk execFile"]) {
    const t0 = now();
    try {
      let buf;
      let extra = {};
      if (label.startsWith("spawn")) {
        const r = await runExec(sprite, ["cat", "/tmp/p4.b64"]);
        buf = r.stdout;
        extra = { exit: r.exitCode, closeInfo: r.closeInfo };
      } else buf = (await sprite.execFile("cat", ["/tmp/p4.b64"], { encoding: "buffer" })).stdout;
      say(`${label}:`, { len: buf.length, shaMatch: sha(buf) === remoteSha, lenMatch: String(buf.length) === remoteLen, ms: ms(t0), ...extra });
    } catch (e) {
      say(`${label} FAILED:`, { name: e.name, message: redact(e.message), exitCode: e.exitCode, stdoutLen: e.stdout?.length, stderr: String(e.stderr ?? "").slice(0, 200), ms: ms(t0) });
    }
  }
  // Exactly the command from the task, piped directly (no temp file)
  const t1 = now();
  const direct = await runExec(sprite, ["/bin/sh", "-c", "head -c 5000000 /dev/urandom | base64 -w0"]);
  const dl = direct.stdout.length;
  say("direct pipeline stdout length:", dl, "(expected 6666668)", { ms: ms(t1), exit: direct.exitCode });
  // binary-safe raw bytes, 3 MB
  await sh("head -c 3000000 /dev/urandom > /tmp/p4.bin");
  const rs = (await sh("sha256sum < /tmp/p4.bin")).out.trim().split(/\s+/)[0];
  const raw = await runExec(sprite, ["cat", "/tmp/p4.bin"]);
  say("raw binary 3MB:", { len: raw.stdout.length, shaMatch: sha(raw.stdout) === rs });
  // stderr heavy + stdout concurrently
  const both = await runExec(sprite, ["/bin/sh", "-c", "head -c 2000000 /dev/zero | tr '\\0' a & head -c 2000000 /dev/zero | tr '\\0' b >&2 & wait"]);
  say("2MB stdout + 2MB stderr concurrently:", { out: both.stdout.length, err: both.stderr.length, exit: both.exitCode });
  // streaming 40 MB (not buffered) to observe throughput + integrity
  const h = createHash("sha256");
  const t2 = now();
  const big = await runExec(sprite, ["/bin/sh", "-c", "head -c 30000000 /dev/urandom > /tmp/p4.big; sha256sum < /tmp/p4.big >&2; cat /tmp/p4.big"], { collect: false, onStdout: (c) => h.update(c) });
  say("30MB streamed:", { bytes: big.outBytes, shaMatch: h.digest("hex") === str(big.stderr).trim().split(/\s+/)[0], ms: ms(t2), MBps: Math.round((big.outBytes / 1e6 / (ms(t2) / 1000)) * 10) / 10, exit: big.exitCode });
  await sh("rm -f /tmp/p4.b64 /tmp/p4.bin /tmp/p4.big");
};

probes.p11 = async () => {
  say("== P11 environment ==");
  const script = String.raw`
uname -a; id; echo HOME=$HOME; echo SHELL=$SHELL; echo PATH=$PATH; pwd; echo LANG=$LANG; echo TZ=$TZ
echo --- os; head -3 /etc/os-release
echo --- which; for c in git gh node python3 base64 stat find realpath truncate mktemp bash sh curl wget sprite-env pip pip3 npm jq tmux rg; do printf '%s=%s\n' $c "$(command -v $c || echo MISSING)"; done
echo --- versions; stat --version | head -1; find --version | head -1; base64 --version | head -1; realpath --version | head -1; truncate --version | head -1; mktemp --version | head -1; git --version; node -v; python3 -V; (gh --version | head -1) 2>&1; curl --version | head -1
echo --- cuaenv-forms
stat --printf '%F|%s|%.3Y|%n\0' -- /etc/hostname | tr '\0' '@'; echo
stat -c '%F|%s|%.3Y' -L -- /etc/hostname
find -H /etc -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%T@\t%f\0' | head -c 120 | tr '\0' '@'; echo
printf hello | base64 -w0; echo
mktemp -d -- /tmp/probeXXXXXX | sed 's/X*$//'; realpath -e -- /etc/hostname
echo --- resources; nproc; free -m | head -2; df -h / | tail -1
echo --- sprite-dir; ls -la /.sprite 2>&1 | head -20
echo --- git-config; git config --global -l 2>&1 | head; ls -la ~ | head -30
`;
  const r = await sh(script);
  console.log(redact(r.out));
  if (r.err.trim()) say("stderr:", r.err.trim().slice(0, 500));
};

probes.p12 = async () => {
  say("== P12 (extra) command-size limits: argv is carried in the WebSocket URL query ==");
  for (const kb of [4, 16, 32, 64, 100, 128, 256, 512]) {
    const payload = "x".repeat(kb * 1024);
    const r = await runExec(sprite, ["/bin/sh", "-c", `printf %s '${payload}' | wc -c`], { timeoutMs: 30000 });
    say(`argv ${kb} KiB:`, { exit: r.exitCode, out: str(r.stdout).trim(), error: r.error?.slice(0, 200), closeInfo: r.closeInfo, ms: r.totalMs });
    if (r.exitCode !== 0) break;
  }
  say("-- base64-ish payload (chars that need %-encoding) --");
  for (const kb of [64, 90, 128]) {
    const raw = Buffer.alloc(Math.floor((kb * 1024 * 3) / 4), 0xfb).toString("base64");
    const r = await runExec(sprite, ["/bin/sh", "-c", `printf %s '${raw}' | wc -c`], { timeoutMs: 30000 });
    say(`base64 argv ${kb} KiB (${raw.length} chars):`, { exit: r.exitCode, out: str(r.stdout).trim(), error: r.error?.slice(0, 200) });
    if (r.exitCode !== 0) break;
  }
  say("-- script via stdin (`sh -s`) --");
  for (const kb of [256, 1024, 4096]) {
    const script = `printf %s '${"y".repeat(kb * 1024)}' | wc -c\n`;
    const r = await runExec(sprite, ["/bin/sh", "-s"], { input: script, timeoutMs: 60000 });
    say(`stdin script ${kb} KiB:`, { exit: r.exitCode, out: str(r.stdout).trim(), error: r.error?.slice(0, 200) });
  }
  say("-- many env vars / large env value --");
  const r = await runExec(sprite, ["/bin/sh", "-c", 'printf %s "$BIG" | wc -c'], { env: { BIG: "z".repeat(60 * 1024) } });
  say("60 KiB env value:", { exit: r.exitCode, out: str(r.stdout).trim(), error: r.error?.slice(0, 200) });
};

probes.p13 = async (n = "30", gapMs = "1500", variant = "echo") => {
  say(`== P13 (extra) flakiness hunt: ${n} sequential execs, gap ${gapMs}ms, variant=${variant} ==`);
  const scripts = {
    echo: "echo hi",
    big: "head -c 2000000 /dev/urandom | base64 -w0",
    mixed: "head -c 1000000 /dev/zero | tr '\\0' a",
  };
  const poll = pollStatus("p13", 3000);
  for (let i = 0; i < Number(n); i++) {
    const r = await sh(scripts[variant] ?? variant, { timeoutMs: 40000 });
    const bad = r.exitCode !== 0;
    say(`#${i} ${new Date().toISOString().slice(11, 23)} exit=${r.exitCode} ms=${r.totalMs} open=${r.openMs} out=${r.outBytes}${bad ? " <<<<< FAIL " + JSON.stringify(r.closeInfo ?? {}) + (r.error ?? "") : ""}`);
    await sleep(Number(gapMs));
  }
  poll.stop();
};

probes.p14 = async (runs = "6", gapMs = "1000") => {
  say("== P14 (extra) exec reliability matrix: which commands lose their result (exit -1 after ~11s)? ==");
  await sh("rm -f /tmp/side.log");
  const variants = {
    echo: "echo hi",
    "100KB": "head -c 100000 /dev/zero | tr '\\0' a",
    "1MB": "head -c 1000000 /dev/zero | tr '\\0' a",
    "2.6MB-urandom-b64": "head -c 2000000 /dev/urandom | base64 -w0",
    "2.6MB-yes": "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 2600000",
    "sleep3": "sleep 3; echo hi",
    "2.6MB-to-stderr": "head -c 2600000 /dev/zero | tr '\\0' a >&2",
  };
  const summary = {};
  for (const [name, body] of Object.entries(variants)) {
    let ok = 0;
    let bad = 0;
    const times = [];
    for (let i = 0; i < Number(runs); i++) {
      const r = await sh(`echo ${JSON.stringify(name)} >> /tmp/side.log; ${body}`, { timeoutMs: 40000 });
      if (r.exitCode === 0) ok++;
      else bad++;
      times.push(`${r.exitCode}:${r.totalMs}`);
      await sleep(Number(gapMs));
    }
    summary[name] = { ok, bad, times: times.join(" ") };
    say(name, summary[name]);
  }
  const side = await sh("sort /tmp/side.log | uniq -c");
  say("attempts that actually ran on the Sprite (side-effect lines):\n" + side.out);
};

const TASK = "probe-hold";
async function taskCall(method, path, body) {
  const data = body ? ` -d '${JSON.stringify(body)}'` : "";
  const r = await sh(`sprite-env curl -sS -X ${method} ${path}${data}; echo " [http-exit=$?]"`, { timeoutMs: 30000 });
  return r.exitCode === 0 ? r.out.trim() : `exec-failed(${r.exitCode}) ${r.error ?? ""}`;
}
async function holdTask(expire = "10m") {
  return taskCall("PUT", `/v1/tasks/${TASK}`, { expire }); // upsert
}
async function releaseTask() {
  return taskCall("DELETE", `/v1/tasks/${TASK}`);
}

probes.p15 = async (runs = "4") => {
  say("== P15 (extra) why do exec results get lost? scenarios for `head -c 100000 /dev/zero | tr \\\\0 a` ==");
  const body = "head -c 100000 /dev/zero | tr '\\0' a";
  const attempt = async (label, fn) => {
    const res = [];
    for (let i = 0; i < Number(runs); i++) {
      const t0 = now();
      let rec;
      try {
        rec = await fn();
      } catch (e) {
        rec = `threw:${e.name}:${redact(e.message).slice(0, 60)}`;
      }
      res.push(`${rec}:${ms(t0)}`);
      await sleep(1000);
    }
    say(label, res.join(" "));
  };
  const plain = async () => {
    const r = await sh(body, { timeoutMs: 40000 });
    return `${r.exitCode}/${r.outBytes}B`;
  };
  await attempt("S0 baseline (spawn, stdin ended):", plain);
  // S1: concurrent silent holder exec
  const holder = runExec(sprite, ["sleep", "100"], { timeoutMs: 100000 });
  await sleep(1500);
  await attempt("S1 with concurrent `sleep 100` exec open:", plain);
  holder.then(() => {});
  await sh("pkill -x sleep || true");
  await holder;
  // S2 Tasks hold
  say("task hold:", await holdTask());
  await attempt("S2 with Tasks API hold registered:", plain);
  say("task release:", await releaseTask());
  await sleep(1000);
  // S3 HTTP exec
  await attempt("S3 execFileHTTP:", async () => {
    const r = await sprite.execFileHTTP("/bin/sh", ["-c", body], { timeout: 30000 });
    return `${r.exitCode}/${String(r.stdout).length}B`;
  });
  // S4 tty
  await attempt("S4 spawn tty:true:", async () => {
    const cmd = sprite.spawn("/bin/sh", ["-c", body], { tty: true });
    let n = 0;
    cmd.stdout.on("data", (c) => (n += c.length));
    const code = await Promise.race([cmd.wait(), sleep(30000).then(() => "timeout")]);
    cmd.close();
    return `${code}/${n}B`;
  });
  // S5 output size sweep
  for (const bytes of [8192, 32768, 60000, 66000, 130000]) {
    await attempt(`S5 size ${bytes}:`, async () => {
      const r = await sh(`head -c ${bytes} /dev/zero | tr '\\0' a`, { timeoutMs: 40000 });
      return `${r.exitCode}/${r.outBytes}B`;
    });
  }
  // S6 redirect to file then cat in a second exec (output in separate exec)
  await attempt("S6 `cat` of existing 100KB file:", async () => {
    await sh("head -c 100000 /dev/zero | tr '\\0' a > /tmp/p15.txt");
    const r = await runExec(sprite, ["cat", "/tmp/p15.txt"], { timeoutMs: 40000 });
    return `${r.exitCode}/${r.outBytes}B`;
  });
  say("final task state:", await taskCall("GET", "/v1/tasks"));
};

probes.p16 = async (runs = "4") => {
  say("== P16 (extra) raw WebSocket client: which handshake parameters avoid the lost-output failure (>=64KiB stdout)? ==");
  const body = "head -c 100000 /dev/zero | tr '\\0' a";
  const rawExec = (variant) =>
    new Promise((resolve) => {
      const u = new URL(`wss://api.sprites.dev/v1/sprites/${encodeURIComponent(NAME)}/exec`);
      for (const a of ["/bin/sh", "-c", body]) u.searchParams.append("cmd", a);
      u.searchParams.set("path", "/bin/sh");
      if (variant.stdin) u.searchParams.set("stdin", "true");
      for (const [k, v] of Object.entries(variant.params ?? {})) u.searchParams.set(k, v);
      const t0 = now();
      const ws = new WebSocket(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
      ws.binaryType = "arraybuffer";
      let bytes = 0;
      let frames = 0;
      let exit = null;
      let texts = [];
      let t1 = null;
      const timer = setTimeout(() => ws.close(), 30000);
      ws.addEventListener("open", () => {
        if (variant.eofOnOpen) ws.send(Uint8Array.from([4]));
        if (variant.eofAfterMs) setTimeout(() => ws.readyState === 1 && ws.send(Uint8Array.from([4])), variant.eofAfterMs);
      });
      ws.addEventListener("message", (e) => {
        if (typeof e.data === "string") return texts.push(e.data.slice(0, 80));
        const b = Buffer.from(e.data);
        frames++;
        if (b[0] === 1) {
          bytes += b.length - 1;
          t1 ??= ms(t0);
        } else if (b[0] === 3) exit = b.length > 1 ? b[1] : 0;
      });
      ws.addEventListener("close", (e) => {
        clearTimeout(timer);
        resolve(`exit=${exit} bytes=${bytes} frames=${frames} firstData=${t1} close=${e.code}/${e.reason || "-"} text=${JSON.stringify(texts)} ${ms(t0)}ms`);
      });
      ws.addEventListener("error", () => {});
    });
  const variants = {
    "stdin=true, no EOF": { stdin: true },
    "stdin=true, EOF on open": { stdin: true, eofOnOpen: true },
    "stdin=true, EOF after 500ms": { stdin: true, eofAfterMs: 500 },
    "no stdin param": { stdin: false },
    "no stdin + tty=false": { stdin: false, params: { tty: "false" } },
  };
  for (const [label, v] of Object.entries(variants)) {
    const res = [];
    for (let i = 0; i < Number(runs); i++) {
      res.push(await rawExec(v));
      await sleep(1000);
    }
    say(label + ":\n   " + res.join("\n   "));
  }
};

probes.p17 = async () => {
  say("== P17 (extra) workarounds for >=64KiB stdout: fs API read, and chunked reads ==");
  await sh("head -c 3000000 /dev/urandom > /tmp/p17.bin");
  const want = (await sh("sha256sum < /tmp/p17.bin")).out.trim().split(/\s+/)[0];
  const fsys = sprite.filesystem("/");
  for (let i = 0; i < 4; i++) {
    const t0 = now();
    try {
      const b = await fsys.readFile("/tmp/p17.bin", null);
      say(`fs.readFile 3MB #${i}: len=${b.length} shaMatch=${sha(b) === want} ${ms(t0)}ms`);
    } catch (e) {
      say(`fs.readFile #${i} FAILED: ${redact(e.message).slice(0, 150)} ${ms(t0)}ms`);
    }
  }
  // chunked exec reads (<=48000 bytes of stdout per exec)
  const t1 = now();
  const parts = [];
  let fails = 0;
  for (let off = 0; off < 300000; off += 48000) {
    const r = await runExec(sprite, ["/bin/sh", "-c", `dd if=/tmp/p17.bin bs=1 skip=${off} count=48000 2>/dev/null | base64 -w0 | head -c 60000`], { timeoutMs: 30000 });
    if (r.exitCode !== 0) fails++;
    parts.push(r.exitCode);
  }
  say(`chunked 7 execs of <=60KB stdout: exits=${parts.join(",")} fails=${fails} ${ms(t1)}ms`);
  await sh("rm -f /tmp/p17.bin");
};


async function startTicker() {
  await sh("rm -f /tmp/tick; (setsid nohup sh -c 'timeout 1500 sh -c \"while :; do date +%s%N >> /tmp/tick; sleep 1; done\"' >/dev/null 2>&1 &) ; sleep 1.2; wc -l < /tmp/tick");
}
/** Inspect the in-Sprite 1Hz ticker: gaps > 3s mean the VM was frozen; dead ticker = cold restart/processes killed. */
async function tickerReport(label) {
  const r = await sh("pgrep -f 'while :; do date' >/dev/null && echo alive || echo DEAD; date +%s%N; tail -n 1400 /tmp/tick");
  const [alive, nowNs, ...ticks] = r.out.trim().split("\n");
  const t = ticks.map((x) => Number(BigInt(x) / 1000000n));
  let maxgap = 0;
  const gaps = [];
  for (let i = 1; i < t.length; i++) {
    const g = (t[i] - t[i - 1]) / 1000;
    if (g > maxgap) maxgap = g;
    if (g > 3) gaps.push(`${g.toFixed(1)}s@tick${i}/${t.length}`);
  }
  const age = (Number(BigInt(nowNs) / 1000000n) - t[t.length - 1]) / 1000;
  say(`   [ticker ${label}] ticker=${alive} ticks=${t.length} maxgap=${maxgap.toFixed(1)}s gaps>3s=[${gaps.join(", ")}] lastTickAge=${age.toFixed(1)}s`, r.exitCode !== 0 ? `(exec exit ${r.exitCode} ${r.err.slice(0, 100)})` : "");
}
async function stopTicker() {
  await sh("pkill -f 'while :; do date' || true; rm -f /tmp/tick");
}

/** Pause detector without a background process: CLOCK_MONOTONIC stops while a VM is suspended, wall clock does not. */
async function monoMark() {
  const r = await sh("python3 -c 'import time;print(time.monotonic(), time.time())'; cut -d' ' -f1 /proc/uptime");
  const [a, b] = r.out.trim().split("\n");
  const [mono, wall] = a.split(" ").map(Number);
  return { mono, wall, uptime: Number(b), wakeMs: r.totalMs, ok: r.exitCode === 0 };
}
function monoReport(label, m0, m1) {
  const dw = m1.wall - m0.wall;
  const dm = m1.mono - m0.mono;
  say(`   [mono ${label}] wall +${dw.toFixed(1)}s, monotonic +${dm.toFixed(1)}s => frozen/suspended ~ ${(dw - dm).toFixed(1)}s${dm < 0 ? " (monotonic went BACKWARDS: VM restarted)" : ""}; uptime ${m0.uptime}->${m1.uptime}`);
}

probes.p5 = async () => {
  say("== P5 long command (sleep 90; echo done) with pause detector (monotonic vs wall clock) ==");
  const m0 = await monoMark();
  const r = await runExec(sprite, ["/bin/sh", "-c", "sleep 90; echo done"]);
  say("result:", { stdout: str(r.stdout).trim(), exit: r.exitCode, totalMs: r.totalMs, closeInfo: r.closeInfo, error: r.error });
  const m1 = await monoMark();
  monoReport("across the 90s exec", m0, m1);
};

probes.p6 = async (minutes = "5") => {
  const min = Number(minutes);
  say(`== P6 single exec duration: sleep ${min * 60}; echo done ==`);
  const poll = pollStatus("p6", 30000);
  const started = new Date();
  say("start", started.toISOString());
  const hb = setInterval(() => say(`  ...${Math.round((Date.now() - started) / 60000)} min elapsed`), 60000);
  const r = await runExec(sprite, ["/bin/sh", "-c", `sleep ${min * 60}; echo done`]);
  clearInterval(hb);
  poll.stop();
  say("end", new Date().toISOString(), { stdout: str(r.stdout).trim(), exit: r.exitCode, elapsedSec: Math.round(r.totalMs / 1000), closeInfo: r.closeInfo, error: r.error });
};

probes.p7 = async (idleSec = "60") => {
  const idle = Number(idleSec);
  say(`== P7 wake after ${idle}s idle ==`);
  const hot = [];
  for (let i = 0; i < 3; i++) hot.push((await sh("true")).totalMs);
  say("hot exec latencies (ms):", hot);
  const cc = new SpritesClient(TOKEN, { controlMode: true }).sprite(NAME); // pooled multiplexed connection
  let t0 = now();
  try {
    const x = await cc.execFile("echo", ["cc1"], { timeout: 30000 });
    say("control-mode exec #1:", { out: String(x.stdout).trim(), ms: ms(t0) });
  } catch (e) {
    say("control-mode exec #1 FAILED:", redact(e.message).slice(0, 200), ms(t0));
  }
  let m0 = await monoMark();
  say(`idle ${idle}s (no requests at all) ...`);
  await sleep(idle * 1000);
  t0 = now();
  try {
    const x = await cc.execFile("echo", ["cc2"], { timeout: 40000 });
    say(`A) first exec after idle via OLD control connection:`, { out: String(x.stdout).trim(), ms: ms(t0) });
  } catch (e) {
    say(`A) first exec after idle via OLD control connection FAILED:`, { name: e.name, message: redact(e.message).slice(0, 200), exitCode: e.exitCode, ms: ms(t0) });
  }
  let m1 = await monoMark();
  monoReport(`idle A (${idle}s)`, m0, m1);
  say("   status (GET) right after:", (await status()).status);
  m0 = m1;
  say(`idle ${idle}s again ...`);
  await sleep(idle * 1000);
  const w = await sh("echo wake-normal");
  say(`B) first normal (new WebSocket) exec after idle:`, brief(w), "retry-needed?", w.exitCode !== 0);
  if (w.exitCode !== 0) say("   retry:", brief(await sh("echo wake-retry")));
  m1 = await monoMark();
  monoReport(`idle B (${idle}s)`, m0, m1);
};

probes.p8 = async () => {
  say("== P8 keep-alive via Tasks API (/.sprite/api.sock, run through exec) ==");
  say("existing tasks:", await taskCall("GET", "/v1/tasks"));
  let m0 = await monoMark();
  await sleep(50_000);
  let m1 = await monoMark();
  monoReport("CONTROL: 50s idle, no task", m0, m1);
  say("create hold (4m expiry):", await holdTask("4m"));
  m0 = await monoMark();
  await sleep(135_000);
  m1 = await monoMark();
  monoReport("WITH task: 135s idle", m0, m1);
  say("tasks listed:", await taskCall("GET", "/v1/tasks"));
  say("refresh (PUT upsert):", await holdTask("4m"));
  say("release (DELETE):", await releaseTask());
  m0 = await monoMark();
  await sleep(75_000);
  m1 = await monoMark();
  monoReport("AFTER release: 75s idle", m0, m1);
  say("tasks now:", await taskCall("GET", "/v1/tasks"));
};

const PROBE_HOSTS = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];
async function getPolicy() {
  return rest("GET", "/policy/network");
}
async function setPolicy(rules) {
  return rest("POST", "/policy/network", { rules });
}
const CURL_ALL = `for u in https://github.com https://api.github.com https://codeload.github.com https://objects.githubusercontent.com https://registry.npmjs.org/express https://pypi.org/simple/pip/ https://files.pythonhosted.org/ https://example.com https://www.google.com https://1.1.1.1; do printf '%s ' $u; curl -sS -o /dev/null -m 8 -w '%{http_code} %{time_total}s' $u 2>&1 | tail -1; echo; done`;

probes.p9 = async () => {
  say("== P9 network policy ==");
  say("SDK:", "sprite.getNetworkPolicy()/updateNetworkPolicy(policy) — SDK expects 204 on update");
  say("initial GET:", await getPolicy());
  const before = await sh(CURL_ALL, { timeoutMs: 120000 });
  say("BEFORE policy (unrestricted):\n" + before.out.trim());
  const rules = [...PROBE_HOSTS.map((domain) => ({ action: "allow", domain })), { action: "deny", domain: "*" }];
  // 1) via SDK
  const t0 = now();
  let sdkResult;
  try {
    await sprite.updateNetworkPolicy({ rules });
    sdkResult = "ok";
  } catch (e) {
    sdkResult = `threw: ${redact(e.message).slice(0, 200)}`;
  }
  say(`SDK updateNetworkPolicy -> ${sdkResult} (${ms(t0)}ms)`);
  say("GET after:", await getPolicy());
  let blockedAfter = null;
  const t1 = now();
  for (let i = 0; i < 15; i++) {
    const r = await sh("curl -sS -o /dev/null -m 5 -w '%{http_code}' https://example.com 2>&1 | tail -1", { timeoutMs: 20000 });
    if (!/^2|^3/.test(r.out.trim())) {
      blockedAfter = ms(t1);
      break;
    }
    await sleep(1000);
  }
  say("example.com became unreachable after (ms since policy applied):", blockedAfter);
  const during = await sh(CURL_ALL, { timeoutMs: 120000 });
  say("DURING policy:\n" + during.out.trim());
  const dns = await sh("getent hosts example.com; echo \"getent-exit=$?\"; getent hosts github.com | head -1");
  say("DNS:", dns.out.trim());
  const extra = await sh(
    `git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' ls-remote https://github.com/hifizz/tars-sandbox-playground.git HEAD 2>&1 | sed 's/\\t/ /' | cut -c1-60; echo "git-exit=$?"
rm -rf /tmp/pipdl; (pip download --no-deps -q -d /tmp/pipdl tomli 2>&1 | tail -2); ls /tmp/pipdl 2>&1 | head -2
npm view left-pad version 2>&1 | tail -2
(curl -sS -m 8 -o /dev/null -w 'apt archive.ubuntu.com: %{http_code}\\n' http://archive.ubuntu.com/ubuntu/ 2>&1 | tail -1)
(curl -sS -m 8 -o /dev/null -w 'cli.github.com (gh apt repo): %{http_code}\\n' https://cli.github.com/packages/githubcli-archive-keyring.gpg 2>&1 | tail -1)`,
    { env: { GH_TOKEN: process.env.GITHUB_TOKEN ?? "" }, timeoutMs: 180000 },
  );
  say("git / pip / npm / apt under policy:\n" + extra.out.trim() + (extra.err.trim() ? "\nSTDERR " + extra.err.trim().slice(0, 300) : ""));
  say("-- restoring unrestricted --");
  await restorePolicy();
};

async function restorePolicy() {
  const r = await setPolicy([]);
  say("POST {rules:[]} ->", r.status, r.text.slice(0, 100));
  say("GET:", await getPolicy());
  let ok = false;
  const t0 = now();
  for (let i = 0; i < 20; i++) {
    const c = await sh("curl -sS -o /dev/null -m 6 -w '%{http_code}' https://example.com 2>&1 | tail -1", { timeoutMs: 25000 });
    if (/^[23]/.test(c.out.trim())) {
      ok = true;
      break;
    }
    await sleep(1500);
  }
  say(`RESTORED? example.com reachable again: ${ok} (after ${ms(t0)}ms)`);
  const all = await sh(CURL_ALL, { timeoutMs: 120000 });
  say("AFTER restore:\n" + all.out.trim());
  return ok;
}

probes.p9restore = async () => {
  await restorePolicy();
};

probes.p10 = async () => {
  say("== P10 checkpoint ==");
  say("existing checkpoints:", (await rest("GET", "/checkpoints")).text);
  await sh("rm -f /home/sprite/probe-cp-file.txt");
  let t0 = now();
  const msgs = [];
  const s = await sprite.createCheckpoint("probe-cp");
  await s.processAll((m) => {
    msgs.push(`${m.type}:${(m.data ?? m.error ?? "").toString().slice(0, 80)}`);
  });
  const createMs = ms(t0);
  say("create probe-cp:", createMs, "ms; stream:", msgs.slice(-6));
  const list = JSON.parse((await rest("GET", "/checkpoints")).text);
  const cp = list.find((c) => c.comment === "probe-cp");
  say("checkpoint record:", cp);
  if (!cp) throw new Error("probe-cp not found after creation");
  const w = await sh("echo marker > /home/sprite/probe-cp-file.txt; cat /home/sprite/probe-cp-file.txt");
  say("wrote file:", w.out.trim());
  // restore (async on the server)
  t0 = now();
  const rmsgs = [];
  try {
    const rs = await sprite.restoreCheckpoint(cp.id);
    await rs.processAll((m) => rmsgs.push(`${m.type}:${(m.data ?? m.error ?? "").toString().slice(0, 80)}`));
  } catch (e) {
    rmsgs.push("threw:" + redact(e.message).slice(0, 120));
  }
  say("restore stream finished after", ms(t0), "ms:", rmsgs.slice(-6));
  let readyMs = null;
  let tries = 0;
  for (; tries < 20; tries++) {
    const r = await sh("cat /home/sprite/probe-cp-file.txt 2>&1; echo \"exit=$?\"", { timeoutMs: 30000 });
    if (r.exitCode === 0) {
      readyMs = ms(t0);
      say(`first successful exec after restore (+${readyMs}ms, attempt ${tries + 1}):`, r.out.trim());
      break;
    }
    await sleep(1000);
  }
  // delete: may be refused when it is the current checkpoint
  let del = await rest("DELETE", `/checkpoints/${encodeURIComponent(cp.id)}`);
  say(`DELETE /checkpoints/${cp.id} ->`, del.status, del.text.slice(0, 200), `(${del.ms}ms)`);
  if (del.status >= 300) {
    const prior = list.find((c) => c.id !== cp.id && c.id !== "Current" && !c.is_auto);
    say("delete refused; restoring", prior?.id, "(pre-existing, fresh-Sprite checkpoint) then retrying delete");
    if (prior) {
      const rs = await sprite.restoreCheckpoint(prior.id);
      await rs.processAll(() => {});
      for (let i = 0; i < 20; i++) {
        const r = await sh("true", { timeoutMs: 30000 });
        if (r.exitCode === 0) break;
        await sleep(1000);
      }
      del = await rest("DELETE", `/checkpoints/${encodeURIComponent(cp.id)}`);
      say(`retry DELETE ->`, del.status, del.text.slice(0, 200));
    }
  }
  say("checkpoints now:", (await rest("GET", "/checkpoints")).text);
};

probes.sh = async (script) => {
  const r = await sh(script);
  console.log(redact(r.out));
  if (r.err.trim()) console.error(redact(r.err));
  say("exit", r.exitCode, "ms", r.totalMs, r.error ?? "");
};

export { probes, say, sleep, now, ms, sh, rest, status, pollStatus, ensureSprite, str, sha, brief };

// extensions (p5..p10) are appended below

// ---------------------------------------------------------------- dispatcher (keep last)
const [, , which, ...rest_] = process.argv;
if (which && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const fn = probes[which];
  if (!fn) {
    console.error(`unknown probe ${which}; have: ${Object.keys(probes).join(" ")}`);
    process.exit(2);
  }
  try {
    if (which !== "info") await ensureSprite();
    await fn(...rest_);
  } catch (e) {
    console.error("PROBE FAILED:", redact(e?.stack ?? e));
    process.exitCode = 1;
  } finally {
    if (["p9"].includes(which)) {
      try {
        await restorePolicy();
      } catch {}
    }
    if (["p8", "p15"].includes(which)) {
      try {
        say("cleanup: release task ->", await releaseTask());
      } catch {}
    }
  }
  process.exit(process.exitCode ?? 0);
}
