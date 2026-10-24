import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointService } from "../src/checkpoint.mjs";
import { register } from "../src/routes/checkpoints.mjs";

// Local-sh bash primitive: same contract as the sandbox primitives.
const bash = (command, { timeoutMs = 60_000 } = {}) =>
  new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, timedOut: Boolean(error?.killed) });
    });
  });

// Minimal in-memory stand-in for store.checkpoints (M1-01).
function fakeStore() {
  const rows = new Map();
  let n = 0;
  return {
    checkpoints: {
      add: (r) => {
        const row = { id: ++n, pinned: false, createdAt: n, ...r };
        rows.set(row.id, row);
        return { ...row };
      },
      list: (ws) => [...rows.values()].filter((r) => r.workspaceId === ws).map((r) => ({ ...r })),
      get: (id) => (rows.has(id) ? { ...rows.get(id) } : undefined),
      remove: (id) => void rows.delete(id),
      setPinned: (id, p) => void (rows.get(id).pinned = p),
    },
  };
}

const made = [];
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), `pca-ckpt-${prefix}-`));
  made.push(d);
  return d;
}
test.after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function sh(cwd, cmd) {
  const r = await bash(`cd '${cwd}' && ${cmd}`);
  assert.equal(r.exitCode, 0, `${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** origin (bare) + a clone with a user identity, one initial commit pushed. */
async function setupRepo() {
  const root = tmp("repo");
  const origin = join(root, "origin.git");
  await sh(root, `git init -q --bare -b main origin.git`);
  const seed = join(root, "seed");
  await sh(root, `git clone -q origin.git seed 2>/dev/null`);
  await sh(seed, `git config user.name t && git config user.email t@e && git checkout -q -b main 2>/dev/null; true`);
  writeFileSync(join(seed, "a.txt"), "alpha\n");
  writeFileSync(join(seed, "gone.txt"), "to delete\n");
  writeFileSync(join(seed, "run.sh"), "#!/bin/sh\necho hi\n");
  writeFileSync(join(seed, ".gitignore"), "ignored.log\nnode_modules/\n");
  await sh(seed, `git add -A && git commit -q -m init && git push -q origin HEAD:main`);
  const baseCommit = await sh(seed, "git rev-parse HEAD");
  const clone = async (name) => {
    const d = join(root, name);
    await sh(root, `git clone -q origin.git ${name} 2>/dev/null`);
    await sh(d, `git config user.name t && git config user.email t@e && git checkout -q ${baseCommit}`);
    return d;
  };
  const work = await clone("work");
  return { root, origin, baseCommit, clone, work };
}

function fingerprint(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (rel === "" && e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else {
        const st = statSync(join(dir, r));
        out[r] = `${createHash("sha256").update(readFileSync(join(dir, r))).digest("hex")}:${st.mode & 0o111 ? "x" : "-"}`;
      }
    }
  };
  walk("");
  return out;
}

const wsOf = (r, extra = {}) => ({ id: "ws1", cwd: r.work, baseBranch: "main", baseCommit: r.baseCommit, ...extra });

async function dirty(r) {
  // unpushed local commit
  writeFileSync(join(r.work, "local.txt"), "local commit\n");
  await sh(r.work, `git add local.txt && git commit -q -m local`);
  // modify tracked, add untracked text, add binary with NUL, delete, chmod
  writeFileSync(join(r.work, "a.txt"), "alpha changed\n");
  writeFileSync(join(r.work, "new.txt"), "brand new\n");
  mkdirSync(join(r.work, "sub/dir"), { recursive: true });
  writeFileSync(join(r.work, "sub/dir/bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0, 10, 13, 0]));
  rmSync(join(r.work, "gone.txt"));
  chmodSync(join(r.work, "run.sh"), 0o644);
  writeFileSync(join(r.work, "tool.sh"), "#!/bin/sh\n");
  chmodSync(join(r.work, "tool.sh"), 0o755);
  // ignored content must not be saved
  writeFileSync(join(r.work, "ignored.log"), "SECRET-IGNORED\n");
  mkdirSync(join(r.work, "node_modules/x"), { recursive: true });
  writeFileSync(join(r.work, "node_modules/x/i.js"), "x");
}

test("save -> apply on a fresh clone reproduces the tree; unchanged re-save; ignored files excluded; no absolute paths", async () => {
  const r = await setupRepo();
  await dirty(r);
  const dir = join(tmp("store"), "ckpts");
  const store = fakeStore();
  const cps = createCheckpointService({ store, dir });

  const rec = await cps.save({ workspace: wsOf(r), bash, bindingVersion: 3 });
  assert.equal(rec.unchanged, false);
  assert.equal(rec.bindingVersion, 3);
  assert.equal(rec.baseCommit, r.baseCommit);
  assert.ok(await cps.verify(rec));
  assert.ok(existsSync(join(dir, rec.path)));
  assert.ok(existsSync(join(dir, rec.path.replace(/\.bundle$/, ".json"))));
  // no leftovers on the "remote"
  assert.equal(await sh(r.work, `ls "$(git rev-parse --absolute-git-dir)" | grep -c pca-ckpt || true`), "0");
  assert.equal(await sh(r.work, `git for-each-ref refs/pca | wc -l | tr -d ' '`), "0");
  // workspace itself untouched (real index not staged)
  assert.match(await sh(r.work, "git status --porcelain"), /\?\? new\.txt/);

  const m = cps.manifest(rec);
  const mText = JSON.stringify(m) + readFileSync(join(dir, rec.path.replace(/\.bundle$/, ".json")), "utf8");
  assert.ok(!mText.includes(tmpdir()), "no absolute server path in manifest");
  assert.ok(!mText.includes(r.root), "no remote path in manifest");
  assert.equal(m.headCommit, rec.headCommit);
  assert.ok(m.fileCount > 0 && m.createdAt && m.branch !== undefined);

  // apply on a fresh clone at base commit
  const target = await r.clone("target");
  await cps.apply({ checkpoint: rec, bash, cwd: target });
  assert.deepEqual(fingerprint(target), fingerprint(r.work).constructor === Object ? expectedWithoutIgnored(fingerprint(r.work)) : {});
  assert.equal(await sh(target, "git rev-parse HEAD"), rec.headCommit);
  assert.equal(await sh(target, "git diff --cached --name-only"), "");
  assert.ok(!existsSync(join(target, "ignored.log")));
  assert.ok(!existsSync(join(target, "node_modules")));
  assert.ok(!existsSync(join(target, "gone.txt")));
  assert.equal(await sh(target, `git for-each-ref refs/pca | wc -l | tr -d ' '`), "0");

  // same state again
  const again = await cps.save({ workspace: wsOf(r), bash, bindingVersion: 3 });
  assert.equal(again.unchanged, true);
  assert.equal(again.id, rec.id);
  assert.equal(cps.list("ws1").length, 1);
});

function expectedWithoutIgnored(fp) {
  const o = { ...fp };
  for (const k of Object.keys(o)) if (k === "ignored.log" || k.startsWith("node_modules/")) delete o[k];
  return o;
}

test("save falls back to baseCommit when origin/<baseBranch> is missing", async () => {
  const r = await setupRepo();
  writeFileSync(join(r.work, "x.txt"), "x\n");
  const store = fakeStore();
  const cps = createCheckpointService({ store, dir: join(tmp("store"), "c") });
  const rec = await cps.save({ workspace: wsOf(r, { baseBranch: "nonexistent" }), bash });
  const target = await r.clone("t2");
  await cps.apply({ checkpoint: rec, bash, cwd: target });
  assert.equal(readFileSync(join(target, "x.txt"), "utf8"), "x\n");
});

test("size limit fails with a reason and leaves no fragments", async () => {
  const r = await setupRepo();
  writeFileSync(join(r.work, "big.bin"), randomBytes(200_000));
  const dir = join(tmp("store"), "c");
  const store = fakeStore();
  const cps = createCheckpointService({ store, dir, maxBytes: 50_000 });
  await assert.rejects(() => cps.save({ workspace: wsOf(r), bash }), /over the 50000 byte limit/);
  assert.equal(store.checkpoints.list("ws1").length, 0);
  const files = existsSync(join(dir, "ws1")) ? readdirSync(join(dir, "ws1")) : [];
  assert.deepEqual(files, []);
  assert.equal(await sh(r.work, `git for-each-ref refs/pca | wc -l | tr -d ' '`), "0");
  assert.equal(await sh(r.work, `ls "$(git rev-parse --absolute-git-dir)" | grep -c pca-ckpt || true`), "0");
});

test("apply refuses a dirty target; tampered bundle fails verify and apply", async () => {
  const r = await setupRepo();
  writeFileSync(join(r.work, "x.txt"), "x\n");
  const dir = join(tmp("store"), "c");
  const cps = createCheckpointService({ store: fakeStore(), dir });
  const rec = await cps.save({ workspace: wsOf(r), bash });

  const dirtyT = await r.clone("dirty");
  writeFileSync(join(dirtyT, "mine.txt"), "mine\n");
  await assert.rejects(() => cps.apply({ checkpoint: rec, bash, cwd: dirtyT }), /uncommitted/);
  assert.equal(readFileSync(join(dirtyT, "mine.txt"), "utf8"), "mine\n");
  assert.ok(!existsSync(join(dirtyT, "x.txt")));

  const f = join(dir, rec.path);
  const buf = readFileSync(f);
  buf[buf.length - 1] ^= 0xff;
  writeFileSync(f, buf);
  assert.equal(await cps.verify(rec), false);
  const clean = await r.clone("clean");
  await assert.rejects(() => cps.apply({ checkpoint: rec, bash, cwd: clean }), /integrity/);
  assert.ok(!existsSync(join(clean, "x.txt")));
});

test("retention keeps 5 newest, pinned survive, old files deleted after new saved", async () => {
  const r = await setupRepo();
  const dir = join(tmp("store"), "c");
  const store = fakeStore();
  let t = Date.parse("2026-01-01T00:00:00Z");
  const cps = createCheckpointService({ store, dir, now: () => (t += 1000) });
  const recs = [];
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(r.work, "n.txt"), `v${i}\n`);
    recs.push(await cps.save({ workspace: wsOf(r), bash }));
    if (i === 0) store.checkpoints.setPinned(recs[0].id, true);
  }
  const ids = cps.list("ws1").map((c) => c.id);
  // 5 newest unpinned (recs[1..5]) + the pinned oldest (never deleted, kept in addition)
  assert.equal(ids.length, 6);
  assert.ok(ids.includes(recs[1].id) && ids.includes(recs[5].id));
  assert.ok(ids.includes(recs[0].id), "pinned kept");
  assert.ok(existsSync(join(dir, recs[0].path)));
  writeFileSync(join(r.work, "n.txt"), "v6\n");
  await cps.save({ workspace: wsOf(r), bash });
  const ids2 = cps.list("ws1").map((c) => c.id);
  assert.equal(ids2.length, 6);
  assert.ok(!ids2.includes(recs[1].id), "oldest unpinned removed");
  assert.ok(!existsSync(join(dir, recs[1].path)), "its files removed");
  assert.ok(ids2.includes(recs[0].id));
});

test("retention without pins leaves exactly 5", async () => {
  const r = await setupRepo();
  const store = fakeStore();
  let t = Date.parse("2026-01-01T00:00:00Z");
  const cps = createCheckpointService({ store, dir: join(tmp("store"), "c"), now: () => (t += 1000) });
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(r.work, "n.txt"), `v${i}\n`);
    await cps.save({ workspace: wsOf(r), bash });
  }
  assert.equal(cps.list("ws1").length, 5);
});

test("warnings for non-ignored secret-looking files; never blocks save", async () => {
  const r = await setupRepo();
  writeFileSync(join(r.work, ".env.production"), "K=1\n");
  writeFileSync(join(r.work, "key.pem"), "x\n");
  writeFileSync(join(r.work, ".env.example"), "K=\n");
  const cps = createCheckpointService({ store: fakeStore(), dir: join(tmp("store"), "c") });
  const rec = await cps.save({ workspace: wsOf(r), bash });
  const m = cps.manifest(rec);
  assert.equal(m.warnings.length, 2);
  assert.ok(m.warnings.some((w) => w.includes(".env.production")));
  assert.ok(m.warnings.some((w) => w.includes("key.pem")));
});

test("routes: checkpoint + list; 409 when not ready; skipped without ctx", async () => {
  const r = await setupRepo();
  writeFileSync(join(r.work, "x.txt"), "x\n");
  const store = fakeStore();
  const dir = join(tmp("store"), "c");
  const checkpoints = createCheckpointService({ store, dir });
  const ws = { id: "ws1", status: "ready", cwd: r.work, baseBranch: "main", baseCommit: r.baseCommit };
  const control = {
    workspaces: { get: (id) => (id === "ws1" ? ws : id === "ws2" ? { ...ws, id: "ws2", status: "preparing" } : undefined) },
    bindings: { current: () => ({ version: 2 }) },
  };
  const routes = {};
  const mk = (ctx) => ({
    ctx,
    get: (p, h) => (routes[`GET ${p}`] = h),
    post: (p, h) => (routes[`POST ${p}`] = h),
  });
  register(mk({ checkpoints }));
  assert.deepEqual(Object.keys(routes), []);
  register(mk({ checkpoints, control, runtimeBash: async () => bash }));
  const post = routes["POST /api/workspaces/:id/checkpoint"];
  const get = routes["GET /api/workspaces/:id/checkpoints"];
  const out = await post({}, {}, { params: { id: "ws1" } });
  assert.equal(out.bindingVersion, 2);
  assert.equal(out.unchanged, false);
  assert.ok(!JSON.stringify(out).includes(tmpdir()));
  assert.ok(!("path" in out));
  const again = await post({}, {}, { params: { id: "ws1" } });
  assert.equal(again.unchanged, true);
  assert.equal((await get({}, {}, { params: { id: "ws1" } })).length, 1);
  await assert.rejects(() => post({}, {}, { params: { id: "ws2" } }), (e) => e.status === 409);
  await assert.rejects(() => post({}, {}, { params: { id: "nope" } }), (e) => e.status === 404);
});
