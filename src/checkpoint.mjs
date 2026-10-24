// Checkpoints: save and restore the uncommitted (and unpushed) state of a workspace repository (M1-09, docs/M1-PLAN.md §3.5/§4.7).
//
// save():   temporary index (`GIT_INDEX_FILE`) + `git add -A` -> `write-tree` -> `commit-tree -p HEAD` -> ref `refs/pca/ckpt/<treeHash>`
//           -> `git bundle` (prerequisite: `origin/<baseBranch>`, else `baseCommit`) -> pulled back to this server in 12 KiB raw
//           base64 chunks (every chunk length-checked, whole file sha256-checked against the remote) -> `<dir>/<workspaceId>/`.
// apply():  sha256 check -> chunked write on the target machine -> `git fetch <bundle>` -> HEAD to the recorded headCommit
//           -> index and working tree restored to the checkpoint tree.
//
// Known limits (also recorded in each manifest `notes`):
//  - Files ignored by .gitignore (.env, node_modules, ...) are NOT saved.
//  - The staged / unstaged split is NOT preserved: after apply everything is unstaged (new files untracked).
//  - Submodule contents and empty directories are not saved.
//
// B4 (docs/m1-probe.md): one exec carries its argv in the URL; 12 KiB raw is the verified-safe chunk, 20 KiB can exceed the
// 64,000-char URL limit with worst-case data. Reads are chunked too (a big stdout has been lost on the platform before).
//
// Bash primitive contract: `bash(command, {timeoutMs}) -> {stdout, stderr, exitCode, timedOut}`; commands run through /bin/sh.
// Nothing here reads environment variables or secrets. Stored paths are relative to `dir`; no absolute server path is ever
// written to a manifest or returned.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Raw bytes per transfer command (same value as env.mjs WRITE_CHUNK_BYTES; B4). */
export const CHUNK_BYTES = 12 * 1024;
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_KEEP = 5;
const GIT_TIMEOUT_MS = 120_000;
const CHUNK_TIMEOUT_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const OBJ_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SAFE_NAME = /^[A-Za-z0-9._\/-]+$/;
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const NOTES = [
  "Files ignored by .gitignore are not saved.",
  "The staged/unstaged split is not preserved; everything is restored as unstaged (new files untracked).",
];
// Matched on the remote with grep -E (basename), then filtered here.
const SECRET_NAME_ERE = String.raw`(^|/)(\.env(\..*)?|id_rsa.*|id_ed25519.*|id_ecdsa.*|[^/]*\.pem|[^/]*\.p12)$`;
const SECRET_NAME_OK = /\.(example|sample|template|dist)$/i;

function fail(message) {
  return new Error(`checkpoint: ${message}`);
}

function short(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
}

async function run(bash, script, what, timeoutMs = GIT_TIMEOUT_MS) {
  const r = await bash(script, { timeoutMs });
  if (r?.timedOut) throw fail(`${what}: timed out`);
  if (!r || r.exitCode !== 0) throw fail(`${what} failed (exit ${r?.exitCode ?? "?"}): ${short(r?.stderr)}`);
  return String(r.stdout ?? "");
}

/** `KEY=value` lines printed by our scripts; first occurrence wins, WARN lines come last so file names cannot spoof keys. */
function parseKv(out) {
  const kv = {};
  const warnings = [];
  for (const line of out.split("\n")) {
    const m = /^([A-Z]+)=(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "WARN") warnings.push(m[2]);
    else if (!(m[1] in kv) && warnings.length === 0) kv[m[1]] = m[2];
  }
  return { kv, warnings };
}

const isoOf = (v) => new Date(v).toISOString();
const stamp = (v) => isoOf(v).replace(/[-:.]/g, "");
const orderKey = (c) => {
  const t = typeof c.createdAt === "number" ? c.createdAt : Date.parse(c.createdAt ?? "");
  return Number.isFinite(t) ? t : 0;
};
/** Newest first (createdAt, then id). */
function newestFirst(list) {
  return [...list].sort((a, b) => orderKey(b) - orderKey(a) || String(b.id).localeCompare(String(a.id), undefined, { numeric: true }));
}

export function createCheckpointService({ store, dir, now = Date.now, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
  if (!store?.checkpoints) throw new TypeError("createCheckpointService: store.checkpoints is required");
  if (typeof dir !== "string" || !dir) throw new TypeError("createCheckpointService: dir is required");
  const root = resolve(dir);
  const queues = new Map();

  const abs = (rel) => {
    const p = resolve(root, rel);
    if (!p.startsWith(root + sep)) throw fail("stored path escapes the checkpoint directory");
    return p;
  };
  const manifestPathOf = (rel) => rel.replace(/\.bundle$/, ".json");

  /** Public manifest of a checkpoint record: no bundle content, no absolute path. */
  function manifest(checkpoint) {
    let m = {};
    try {
      m = JSON.parse(readFileSync(abs(manifestPathOf(checkpoint.path)), "utf8"));
    } catch {
      /* fall back to the record */
    }
    return {
      id: checkpoint.id,
      workspaceId: checkpoint.workspaceId,
      pinned: Boolean(checkpoint.pinned),
      bindingVersion: checkpoint.bindingVersion ?? m.bindingVersion ?? null,
      sha256: checkpoint.sha256,
      size: checkpoint.size,
      baseCommit: checkpoint.baseCommit ?? null,
      headCommit: checkpoint.headCommit,
      treeHash: checkpoint.treeHash,
      branch: m.branch ?? null,
      createdAt: m.createdAt ?? checkpoint.createdAt ?? null,
      fileCount: m.fileCount ?? null,
      warnings: m.warnings ?? [],
      notes: m.notes ?? NOTES,
    };
  }

  function list(workspaceId) {
    return newestFirst(store.checkpoints.list(workspaceId) ?? []);
  }

  async function verify(checkpoint) {
    try {
      const buf = readFileSync(abs(checkpoint.path));
      return buf.length === checkpoint.size && sha256(buf) === checkpoint.sha256;
    } catch {
      return false;
    }
  }

  function removeFiles(rel) {
    rmSync(abs(rel), { force: true });
    rmSync(abs(manifestPathOf(rel)), { force: true });
  }

  function prune(workspaceId) {
    const all = list(workspaceId);
    for (const c of all.slice(keep)) {
      if (c.pinned) continue;
      store.checkpoints.remove(c.id);
      removeFiles(c.path);
    }
  }

  async function saveInner({ workspace, bash, bindingVersion }) {
    if (!workspace?.id || !SAFE_ID.test(String(workspace.id))) throw fail("invalid workspace id");
    if (typeof bash !== "function") throw fail("bash primitive is required");
    const cwd = workspace.cwd;
    const baseBranch = workspace.baseBranch ?? "";
    const baseCommit = workspace.baseCommit ?? "";
    if (baseBranch && !SAFE_NAME.test(baseBranch)) throw fail("unsupported base branch name");
    if (baseCommit && !OBJ_ID.test(baseCommit)) throw fail("invalid baseCommit");

    const rand = randomBytes(6).toString("hex");
    const pre = `set -e\n${cwd ? `cd ${q(cwd)}\n` : ""}G=$(git rev-parse --absolute-git-dir)\nW="$G/pca-ckpt-${rand}"\n`;
    let tree = "";
    const tmpFiles = [];
    try {
      // 1. tree of the whole workspace via a temporary index
      const a = parseKv(
        await run(
          bash,
          `${pre}mkdir -p "$W"
GIT_INDEX_FILE="$W/index" git add -A >&2
TREE=$(GIT_INDEX_FILE="$W/index" git write-tree)
echo "TREE=$TREE"
echo "HEAD=$(git rev-parse HEAD)"
echo "BRANCH=$(git rev-parse --abbrev-ref HEAD)"
echo "COUNT=$(git ls-tree -r --name-only "$TREE" | wc -l | tr -d ' ')"
git -c core.quotepath=off ls-tree -r --name-only "$TREE" | grep -E ${q(SECRET_NAME_ERE)} | head -50 | sed 's/^/WARN=/' || true`,
          "snapshot",
        ),
      );
      tree = a.kv.TREE ?? "";
      const head = a.kv.HEAD ?? "";
      if (!OBJ_ID.test(tree) || !OBJ_ID.test(head)) throw fail("snapshot failed: unexpected git output");
      const count = Number.parseInt(a.kv.COUNT ?? "", 10);
      const warnings = [...new Set(a.warnings)]
        .filter((n) => !SECRET_NAME_OK.test(n))
        .map((n) => `possible secret file is not ignored and is included: ${n}`);

      // unchanged -> reuse the previous checkpoint
      const prev = list(workspace.id)[0];
      if (prev && prev.treeHash === tree && prev.headCommit === head && existsSync(abs(prev.path))) {
        return { ...prev, unchanged: true };
      }

      // 2. checkpoint commit, ref, bundle
      const b = parseKv(
        await run(
          bash,
          `${pre}T=${q(tree)}
H=${q(head)}
BASEBR=${q(baseBranch)}
BASEC=${q(baseCommit)}
export GIT_AUTHOR_NAME=pca GIT_AUTHOR_EMAIL=pca@localhost GIT_COMMITTER_NAME=pca GIT_COMMITTER_EMAIL=pca@localhost
C=$(git commit-tree "$T" -p "$H" -m "pca checkpoint")
git update-ref "refs/pca/ckpt/$T" "$C"
EX=""
if [ -n "$BASEBR" ] && git rev-parse --verify -q "refs/remotes/origin/$BASEBR^{commit}" >/dev/null; then EX="origin/$BASEBR"
elif [ -n "$BASEC" ] && git cat-file -e "$BASEC^{commit}" 2>/dev/null; then EX="$BASEC"; fi
if [ -n "$EX" ]; then git bundle create "$W/b.bundle" "refs/pca/ckpt/$T" "^$EX" >&2
else git bundle create "$W/b.bundle" "refs/pca/ckpt/$T" >&2; fi
echo "SIZE=$(wc -c < "$W/b.bundle" | tr -d ' ')"
echo "SHA=$( (sha256sum "$W/b.bundle" 2>/dev/null || shasum -a 256 "$W/b.bundle") | cut -d' ' -f1)"`,
          "bundle",
        ),
      );
      const size = Number.parseInt(b.kv.SIZE ?? "", 10);
      const remoteSha = b.kv.SHA ?? "";
      if (!Number.isSafeInteger(size) || size <= 0 || !/^[0-9a-f]{64}$/.test(remoteSha)) throw fail("bundle failed: unexpected output");
      if (size > maxBytes) {
        throw fail(`bundle is ${size} bytes, over the ${maxBytes} byte limit; reduce uncommitted changes or large files and retry`);
      }

      // 3. chunked read-back
      const parts = [];
      for (let off = 0; off < size; off += CHUNK_BYTES) {
        const want = Math.min(CHUNK_BYTES, size - off);
        const out = (
          await run(
            bash,
            `${pre}dd if="$W/b.bundle" bs=${CHUNK_BYTES} skip=${off / CHUNK_BYTES} count=1 2>/dev/null | base64 | tr -d '\\n'`,
            "read chunk",
            CHUNK_TIMEOUT_MS,
          )
        ).trim();
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(out)) throw fail("read chunk: malformed data");
        const buf = Buffer.from(out, "base64");
        if (buf.length !== want) throw fail(`read chunk at ${off}: expected ${want} bytes, got ${buf.length}`);
        parts.push(buf);
      }
      const data = Buffer.concat(parts);
      const localSha = sha256(data);
      if (data.length !== size || localSha !== remoteSha) throw fail("bundle transfer corrupted (sha256 mismatch)");

      // 4. write locally (temp file + rename), then record
      const createdMs = now();
      const wsDir = join(root, workspace.id);
      mkdirSync(wsDir, { recursive: true });
      const name = `${stamp(createdMs)}-${tree.slice(0, 8)}`;
      const rel = `${workspace.id}/${name}.bundle`;
      const bundleTmp = join(wsDir, `.${name}.${rand}.bundle.tmp`);
      const jsonTmp = join(wsDir, `.${name}.${rand}.json.tmp`);
      tmpFiles.push(bundleTmp, jsonTmp);
      const bv = bindingVersion ?? store.bindings?.current?.(workspace.id)?.version ?? null;
      const mf = {
        version: 1,
        workspaceId: workspace.id,
        bundle: `${name}.bundle`,
        ref: `refs/pca/ckpt/${tree}`,
        baseBranch: baseBranch || null,
        baseCommit: baseCommit || null,
        headCommit: head,
        treeHash: tree,
        branch: a.kv.BRANCH || null,
        createdAt: isoOf(createdMs),
        bindingVersion: bv,
        fileCount: Number.isFinite(count) ? count : null,
        size,
        sha256: localSha,
        warnings,
        notes: NOTES,
      };
      writeFileSync(bundleTmp, data);
      writeFileSync(jsonTmp, `${JSON.stringify(mf, null, 2)}\n`);
      renameSync(bundleTmp, abs(rel));
      renameSync(jsonTmp, abs(manifestPathOf(rel)));
      let record;
      try {
        record = store.checkpoints.add({
          workspaceId: workspace.id,
          bindingVersion: bv,
          path: rel,
          sha256: localSha,
          size,
          baseCommit: baseCommit || null,
          headCommit: head,
          treeHash: tree,
        });
      } catch (e) {
        removeFiles(rel);
        throw e;
      }
      try {
        prune(workspace.id); // build first, delete after
      } catch {
        /* retention failure must not fail a successful save */
      }
      return { ...record, unchanged: false };
    } finally {
      for (const f of tmpFiles) rmSync(f, { force: true });
      try {
        await bash(`${pre.replace("set -e\n", "")}rm -rf "$W"${tree ? `; git update-ref -d "refs/pca/ckpt/${tree}"` : ""}; true`, {
          timeoutMs: CHUNK_TIMEOUT_MS,
        });
      } catch {
        /* best effort */
      }
    }
  }

  /** Save a checkpoint of `workspace` (needs id, cwd, baseBranch, baseCommit). Serialized per workspace. */
  function save(args) {
    const key = args?.workspace?.id ?? "";
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => saveInner(args));
    queues.set(key, next);
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }).catch(() => {});
    return next;
  }

  async function apply({ checkpoint, bash, cwd }) {
    if (!checkpoint?.path) throw fail("checkpoint is required");
    if (typeof bash !== "function") throw fail("bash primitive is required");
    if (typeof cwd !== "string" || !cwd) throw fail("cwd is required");
    const tree = checkpoint.treeHash;
    const head = checkpoint.headCommit;
    if (!OBJ_ID.test(tree ?? "") || !OBJ_ID.test(head ?? "")) throw fail("checkpoint has invalid commit ids");
    let data;
    try {
      data = readFileSync(abs(checkpoint.path));
    } catch {
      throw fail("bundle file is missing");
    }
    if (data.length !== checkpoint.size || sha256(data) !== checkpoint.sha256) {
      throw fail("integrity check failed: bundle sha256 does not match; refusing to apply");
    }

    const rand = randomBytes(6).toString("hex");
    const pre = `cd ${q(cwd)}\nG=$(git rev-parse --absolute-git-dir)\nW="$G/pca-apply-${rand}"\n`;
    try {
      // refuse on uncommitted content
      const chk = await bash(`set -e\n${pre}if [ -n "$(git status --porcelain --untracked-files=all)" ]; then echo DIRTY >&2; exit 3; fi\nmkdir -p "$W"`, {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (chk.exitCode === 3) throw fail("target directory has uncommitted changes; refusing to overwrite");
      if (chk.exitCode !== 0) throw fail(`target check failed (exit ${chk.exitCode}): ${short(chk.stderr)}`);

      for (let off = 0; off < data.length; off += CHUNK_BYTES) {
        const b64 = data.subarray(off, off + CHUNK_BYTES).toString("base64");
        await run(bash, `set -e\n${pre}printf %s ${q(b64)} | base64 -d ${off === 0 ? ">" : ">>"} "$W/b.bundle"`, "write chunk", CHUNK_TIMEOUT_MS);
      }
      const v = parseKv(
        await run(
          bash,
          `set -e\n${pre}echo "SIZE=$(wc -c < "$W/b.bundle" | tr -d ' ')"\necho "SHA=$( (sha256sum "$W/b.bundle" 2>/dev/null || shasum -a 256 "$W/b.bundle") | cut -d' ' -f1)"`,
          "verify upload",
        ),
      );
      if (Number(v.kv.SIZE) !== data.length || v.kv.SHA !== checkpoint.sha256) throw fail("bundle upload corrupted (sha256 mismatch)");

      await run(
        bash,
        `set -e\n${pre}T=${q(tree)}
H=${q(head)}
git fetch -q "$W/b.bundle" "+refs/pca/ckpt/$T:refs/pca/ckpt/$T"
git cat-file -e "$H^{commit}"
git reset -q --hard "$H"
git read-tree -u --reset "$T"
git reset -q
git update-ref -d "refs/pca/ckpt/$T"`,
        "restore",
      );
    } finally {
      try {
        await bash(`${pre}rm -rf "$W"; true`, { timeoutMs: CHUNK_TIMEOUT_MS });
      } catch {
        /* best effort */
      }
    }
  }

  return { save, apply, list, verify, manifest };
}
