// M1-00 B: live Sprites probes. Only this run's pca-probe-* Sprites may be changed.
// node --env-file=.env scratch/m1-probe-b.mjs
// node --env-file=.env scratch/m1-probe-b.mjs --check
// Secrets are passed to the SDK only. No GitHub token is sent to a Sprite.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SpritesClient } from "@fly/sprites";
import { createSpritesBash, redactMessage, MAX_EXEC_QUERY_CHARS } from "../src/sandbox/sprites.mjs";

const LABEL = "app:pi-cloud-agents";
const PREFIX = "pca-probe-";
const PATH = fileURLToPath(new URL("./m1-probe-b-results.json", import.meta.url));
const token = process.env.SPRITES_TOKEN;
if (!token) throw new Error("SPRITES_TOKEN missing; use node --env-file=.env (no secret is printed)");
const secrets = [token, ...Object.entries(process.env).filter(([k]) => /TOKEN|SECRET|API_KEY/.test(k)).map(([, v]) => v)].filter(Boolean);
const client = new SpritesClient(token, { timeout: 30_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (v) => createHash("sha256").update(v).digest("hex");
const q = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;
const safe = (v) => redactMessage(String(v), secrets);
const errorInfo = (e) => ({ name: e.name, message: safe(e.message).slice(0, 800), status: e.status, statusCode: e.statusCode, code: e.code, errorCode: e.errorCode, retryAfterSeconds: e.retryAfterSeconds });
const view = (s) => ({ name: s.name, status: s.status, labels: s.labels });

async function listPrefix() {
  const sprites = [];
  let next;
  do {
    const r = await client.listSprites({ prefix: PREFIX, maxResults: 100, ...(next ? { continuationToken: next } : {}) });
    sprites.push(...r.sprites.map(view));
    next = r.hasMore ? r.nextContinuationToken : undefined;
    if (r.hasMore && !next) throw new Error("listSprites says hasMore but has no cursor");
  } while (next);
  return sprites;
}

const stamp = `${Date.now()}-${randomBytes(2).toString("hex")}`;
const names = [1, 2, 3].map((i) => `${PREFIX}${stamp}-${i}`);
const result = { startedAt: new Date().toISOString(), sdkVersion: JSON.parse(readFileSync(new URL("../node_modules/@fly/sprites/package.json", import.meta.url))).version, names, cases: {}, cleanup: [] };
const save = () => writeFileSync(PATH, safe(JSON.stringify(result, null, 2)) + "\n");
function log(v) { console.log(safe(typeof v === "string" ? v : JSON.stringify(v))); }

async function probe(id, fn) {
  const t0 = Date.now();
  log({ probe: id, event: "start" });
  try {
    result.cases[id] = { observed: await fn(), ms: Date.now() - t0 };
  } catch (e) {
    result.cases[id] = { error: errorInfo(e), ms: Date.now() - t0 };
  }
  save();
  log({ probe: id, ...result.cases[id] });
}

async function exec(bash, command, timeoutMs = 40_000) {
  const r = await bash(command, { timeoutMs });
  if (r.timedOut || r.exitCode !== 0) {
    const e = new Error(`exec failed: exit=${r.exitCode} timedOut=${r.timedOut}; ${safe(r.stderr).slice(0, 500)}`);
    e.code = "PROBE_EXEC";
    throw e;
  }
  return r.stdout;
}

// Both prefix+label AND this run's exact name are needed before deletion.
async function cleanup() {
  for (const name of names) {
    try {
      const s = await client.getSprite(name);
      if (!names.includes(name) || !name.startsWith(PREFIX) || !s.labels?.includes(LABEL)) throw new Error("refusing cleanup: missing exact name or ownership label");
      await client.deleteSprite(name);
      result.cleanup.push({ name, deleted: true });
    } catch (e) {
      result.cleanup.push({ name, ...(e.statusCode === 404 ? { absent: true } : { error: errorInfo(e) }) });
    }
    save();
  }
  result.remaining = await listPrefix();
  result.remainingThisRun = result.remaining.filter((s) => names.includes(s.name));
  result.finishedAt = new Date().toISOString();
  save();
  log({ cleanup: result.cleanup, remaining: result.remaining, remainingThisRun: result.remainingThisRun });
}

async function main() {
  result.before = await listPrefix();
  if (result.before.length > 0) throw new Error("pre-existing pca-probe-* instances found; not creating more or deleting them");
  save();
  const created = [];
  try {
    await probe("B1", async () => {
      const observations = [];
      for (const name of names) {
        const t0 = Date.now();
        const s = await client.createSprite(name, { labels: [LABEL, `probe:${stamp}`], waitForCapacity: true });
        if (s.name !== name) throw new Error("create response name does not match request");
        created.push(name);
        observations.push({ name, ms: Date.now() - t0, response: view(s), get: view(await client.getSprite(name)) });
        result.created = observations;
        save();
      }
      let duplicate;
      try {
        const s = await client.createSprite(names[0], { labels: [LABEL, `probe:${stamp}`], waitForCapacity: true });
        duplicate = { unexpectedlySucceeded: true, response: view(s) };
      } catch (e) { duplicate = errorInfo(e); }
      const missingName = `${PREFIX}${stamp}-missing`;
      let missingGet;
      let missingDelete;
      try { await client.getSprite(missingName); missingGet = "unexpectedly found"; } catch (e) { missingGet = errorInfo(e); }
      // This name was never created; no existing remote object is targeted.
      try { await client.deleteSprite(missingName); missingDelete = { success: true }; } catch (e) { missingDelete = errorInfo(e); }
      return { creates: observations, duplicate, missingGet, missingDelete, listed: await listPrefix(), waitForCapacity: "true on all creates; no capacity shortage injected" };
    });
    if (created.length !== 3) throw new Error("did not create all three labelled instances; stopping with cleanup");
    const name = names[0];
    const sprite = client.sprite(name);
    const bash = createSpritesBash({ client, name, secrets: [token], startDelaySec: 0.1 });
    await probe("B2", async () => {
      const command = `printf 'user='; id; printf 'home=%s\\n' "$HOME"; printf 'platform='; uname -sm; for p in setsid flock git gh node base64 sha256sum tar perl dash; do printf '%s=' "$p"; command -v "$p" || true; done; test -r /proc/$$/stat && printf 'proc-stat=available\\n'; test -r /proc/sys/kernel/random/boot_id && printf 'boot-id=available\\n'`;
      return { command, output: await exec(bash, command) };
    });
    await probe("B3", async () => {
      const root = "/tmp/pca-m1-probe";
      const launch = `mkdir -p ${q(root)}; setsid sh -c 'echo $$ > ${root}/pid; sleep 60; echo done > ${root}/done' </dev/null >${root}/log 2>&1 &`;
      await exec(bash, launch);
      const inspect = `p=$(cat ${q(root + "/pid")}); printf 'pid=%s\\n' "$p"; cat /proc/sys/kernel/random/boot_id; cat /proc/"$p"/stat; ps -o pid,ppid,pgid,sid,stat,comm --forest -g "$p"; test -f ${q(root + "/done")} && printf 'done=yes\\n' || true`;
      const first = await exec(bash, inspect);
      await sleep(1500);
      const second = await exec(bash, inspect);
      const kill = `p=$(cat ${q(root + "/pid")}); /bin/kill -TERM -- -"$p"; sleep 0.5; ps -o pid,ppid,pgid,sid,stat,comm --forest -g "$p" || true; test -f ${q(root + "/done")} && printf 'done=yes\\n' || printf 'done=no\\n'`;
      const killed = await exec(bash, kill);
      // A separate 3s detached job proves the wrapper can persist its final exit marker after exec ends.
      const completion = `setsid sh -c 'sleep 3; printf done > ${root}/detached-done' </dev/null >${root}/detached-log 2>&1 &`;
      await exec(bash, completion);
      await sleep(4000);
      const done = await exec(bash, `cat ${q(root + "/detached-done")}`);
      return { launch, first, second, kill, killed, completion, detachedCompletion: done };
    });
    await probe("B4", async () => {
      const transfers = [];
      for (const rawSize of [20 * 1024, 40 * 1024]) {
        const bytes = randomBytes(rawSize);
        const b64 = bytes.toString("base64");
        const command = `printf %s ${q(b64)} | base64 -d | sha256sum`;
        const t0 = Date.now();
        try {
          const output = await exec(bash, command);
          transfers.push({ rawBytes: rawSize, b64Chars: b64.length, commandChars: command.length, matches: output.startsWith(sha(bytes)), ms: Date.now() - t0 });
        } catch (e) { transfers.push({ rawBytes: rawSize, b64Chars: b64.length, commandChars: command.length, error: errorInfo(e), ms: Date.now() - t0 }); }
      }
      // Exact base64-argument lengths (rather than the pre-encoding raw byte counts).
      for (const chars of [20 * 1024, 40 * 1024]) {
        const b64 = randomBytes(chars * 3 / 4).toString("base64");
        try {
          const output = await exec(bash, `printf %s ${q(b64)} | base64 -d | sha256sum`);
          transfers.push({ exactB64Chars: chars, matches: output.startsWith(sha(Buffer.from(b64, "base64"))) });
        } catch (e) { transfers.push({ exactB64Chars: chars, error: errorInfo(e) }); }
      }
      const reads = [];
      for (const count of [48 * 1024, 200 * 1024]) {
        const command = `head -c ${count} /dev/zero | tr '\\000' x`;
        const t0 = Date.now();
        try {
          const output = await exec(bash, command);
          reads.push({ expectedBytes: count, gotBytes: Buffer.byteLength(output), matches: sha(output) === sha(Buffer.alloc(count, "x")), ms: Date.now() - t0 });
        } catch (e) { reads.push({ expectedBytes: count, error: errorInfo(e), ms: Date.now() - t0 }); }
      }
      const chunks = [];
      for (let i = 0; i < 5; i++) {
        const bytes = randomBytes(12 * 1024);
        const b64 = bytes.toString("base64");
        const back = await exec(bash, `printf %s ${q(b64)} | base64 -d | base64 -w 0`);
        chunks.push({ iteration: i + 1, rawBytes: bytes.length, b64Chars: b64.length, roundTrip: back === b64 });
      }
      return { limit: MAX_EXEC_QUERY_CHARS, transfers, reads, chunks, startDelaySec: 0.1 };
    });
    await probe("B5", async () => {
      const observations = [];
      for (let i = 0; i < names.length; i++) {
        const b = createSpritesBash({ client, name: names[i], secrets: [token] });
        const marker = `sprite-${i + 1}`;
        const t0 = Date.now();
        const output = await exec(b, `printf %s ${q(marker)} > /tmp/pca-own-marker; cat /tmp/pca-own-marker`);
        observations.push({ name: names[i], marker, output, matches: output === marker, ms: Date.now() - t0 });
      }
      return { observations, listed: await listPrefix(), note: "three instances created sequentially; no fourth instance or capacity exhaustion attempted" };
    });
    await probe("B6", async () => {
      const curl = (host) => `curl -sS -L -o /dev/null -w '%{http_code}' --max-time 15 ${q(`https://${host}`)} 2>/dev/null || true`;
      const before = await exec(bash, curl("github.com"));
      const original = await sprite.getNetworkPolicy();
      const allow = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];
      const rules = [...allow.map((domain) => ({ action: "allow", domain })), { action: "deny", domain: "*" }];
      let after;
      try {
        await sprite.updateNetworkPolicy({ rules });
        await sleep(1500);
        const policy = await sprite.getNetworkPolicy();
        after = { policy, github: await exec(bash, curl("github.com")), npm: await exec(bash, curl("registry.npmjs.org")), denied: await exec(bash, curl("example.com")) };
      } finally {
        await sprite.updateNetworkPolicy(original);
      }
      return { before, original, rules, after, restored: await sprite.getNetworkPolicy() };
    });
  } finally {
    await cleanup();
  }
}

if (process.argv.includes("--check")) {
  log({ current: await listPrefix(), priorEvidenceExists: existsSync(PATH) });
} else {
  try {
    await main();
    const expected = ["B1", "B2", "B3", "B4", "B5", "B6"];
    if (!expected.every((id) => result.cases[id]?.observed) || result.remainingThisRun?.length || result.cleanup.some((r) => r.error)) {
      throw new Error("probe incomplete or cleanup unconfirmed; inspect the recorded evidence");
    }
    const b4 = result.cases.B4.observed;
    if (!b4.transfers.every((r) => r.matches) || !b4.reads.every((r) => r.matches) || !b4.chunks.every((r) => r.roundTrip)) {
      throw new Error("one or more transfer hashes did not match; inspect B4 evidence");
    }
  } catch (e) {
    result.fatal = errorInfo(e);
    save();
    log({ fatal: result.fatal });
    process.exitCode = 1;
  }
}
