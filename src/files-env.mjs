// File browsing helper for the Files panel (AMP13-files): resolves the session's server-side working
// directory and exposes list / read / upload on top of the workspace's `bash` primitive + SandboxEnv.
//
// Security contract (docs/tasks/AMP13-files.md):
//  - cwd is decided HERE from stored state: the Bot's own session dir (issueLoop.dir / review.dir /
//    worktree.dir / loopRun.dir) when present, else the workspace's bound cwd. A client-supplied root is never trusted.
//  - The Bot must exist, be linked to a `ready` workspace with an active binding; every op goes through
//    `runtimeBash(workspaceId)` — no host bash, no default Sprite fallback.
//  - Paths are user-controlled but confined to the session root: `cd -P`/`pwd -P` (POSIX, GNU and BSD
//    alike — unlike `realpath -m`) canonicalizes the directory portion, the final component's symlink
//    is refused by lstat, and anything outside the root or matching a protected name (.env*, .git) is
//    refused.
//  - Uploads are bounded (MAX_UPLOAD_BYTES) and never overwrite an existing file unless the caller set
//    `overwrite: true`.
//
// Errors throw as FileError (from env.mjs) with a `code`; the route maps them to HTTP status codes.
import { posix } from "node:path";
import { FileError } from "@earendil-works/pi-durable/env";
import { SandboxEnv, resolvePath, shellQuote } from "./env.mjs";

/** Largest file `read` returns (base64). */
export const MAX_READ_BYTES = 2 * 1024 * 1024;
/** Largest upload the write route accepts (decoded bytes). */
export const MAX_UPLOAD_BYTES = 1024 * 1024;
/** Most entries one `list` returns; beyond that the response carries `truncated: true`. */
export const MAX_LIST_ENTRIES = 2000;

/** Names that must never be read or overwritten (credentials, repository internals). */
const PROTECTED_SEGMENT_RE = /^\.env(?:\..*)?$/;

const homeOf = (app) => (typeof app.ctx.homeDir === "function" ? app.ctx.homeDir() : "/home/sprite") || "/home/sprite";

const bad = (message, path, code = "invalid") => new FileError(code, message, path);

/** `p` relative to `root`; `p` must already be canonicalized inside root (or equal it). */
const canonRel = (root, p) => (p === root ? "" : p.startsWith(`${root}/`) ? p.slice(root.length + 1) : posix.relative(root, p));

/** True when any path segment is protected (.env / .env.* / .git). */
function isProtectedPath(relPath) {
  return relPath.split("/").some((seg) => seg === ".git" || PROTECTED_SEGMENT_RE.test(seg));
}

/**
 * Resolve the session root for a Bot. The Bot's own recorded session dir wins (issue-loop discussions and
 * executions, PR reviews, hand-added sessions and Loop-run sessions all run in their own directories); the
 * workspace's bound cwd is the fallback for the primary session. Returns { workspace, root } or throws FileError.
 */
export function sessionRootOf(app, botId) {
  const { bots, control } = app.ctx;
  if (!bots || typeof bots.get !== "function") throw bad("bot registry is not available");
  if (!control) throw bad("control store is not available");
  const bot = bots.get(botId);
  if (!bot) throw bad(`bot not found: ${botId}`, undefined, "not_found");
  const workspace = control.links.workspaceOf(String(bot.conversationId));
  if (!workspace) throw bad(`session ${botId} has no linked workspace`, undefined, "conflict");
  if (workspace.status !== "ready") throw bad(`workspace ${workspace.id} is not ready (status: ${workspace.status})`, undefined, "conflict");
  if (!control.bindings.current(workspace.id)) throw bad(`workspace ${workspace.id} has no active runtime binding`, undefined, "conflict");
  const root = bot.issueLoop?.dir ?? bot.review?.dir ?? bot.worktree?.dir ?? bot.loopRun?.dir ?? workspace.cwd;
  if (typeof root !== "string" || !root.startsWith("/")) throw bad(`session ${botId} has no usable working directory`, undefined, "conflict");
  return { workspace, root };
}

/**
 * Build the per-session file environment. `env` is a SandboxEnv pinned at the session root so relative
 * paths resolve inside it; `resolve` maps a user path (relative or absolute) to a canonical absolute
 * path inside the root, refusing symlink escapes and protected names.
 *
 * @param {any} app route app (app.ctx.bots / control / runtimeBash / homeDir?)
 * @param {string} botId
 */
export async function createFilesEnv(app, botId) {
  const { workspace, root } = sessionRootOf(app, botId);
  if (typeof app.ctx.runtimeBash !== "function") throw bad("runtime bash is not available", undefined, "conflict");
  let bash;
  try {
    bash = await app.ctx.runtimeBash(workspace.id);
  } catch (e) {
    throw bad(`runtime unavailable: ${String(e?.message ?? e).slice(0, 200)}`, undefined, "conflict");
  }
  const env = new SandboxEnv({ cwd: root, bash, home: homeOf(app) });

  // The physical root: `root` itself may contain symlink components, so it is canonicalized once and
  // every path check compares against this value.
  const rootCanon = await env._sh(`cd ${shellQuote([root])} && pwd -P`, undefined, root);
  if (!rootCanon.ok) throw rootCanon.error;
  const physicalRoot = rootCanon.value.stdout.trim();

  // First-existing-ancestor canonicalization in pure POSIX sh (portable: GNU and BSD toolchains
  // alike — `realpath -m` is GNU-only). `..` is already resolved lexically by resolvePath; what
  // remains are symlinks. The walk climbs to the first component that exists, resolves it with
  // `cd -P`/`pwd -P` (directories) or its parent (files), and re-appends the missing suffix. An
  // existing DIRECTORY that is a symlink resolves through `cd -P` and escapes to the prefix check;
  // an existing FILE symlink keeps its name (lstat in each op refuses to follow it).
  const canonScript = (target) => {
    const t = shellQuote([target]);
    return (
      `d=${t}; s=; ` +
      `while [ ! -e "$d" ]; do s="/${'${d##*/}'}$s"; d=${'${d%/*}'}; [ -n "$d" ] || d=/; done; ` +
      `if [ -d "$d" ]; then p=$(cd "$d" && pwd -P); printf '%s%s\n' "$p" "$s"; ` +
      `else p=$(cd "${'${d%/*}'}" && pwd -P); printf '%s/%s%s\n' "$p" "${'${d##*/}'}" "$s"; fi`
    );
  };

  /**
   * Canonical absolute path for `userPath`, verified to stay inside `physicalRoot`. Symlinks in any
   * component are resolved before the prefix check; the final component's symlink-ness is enforced by
   * lstat in each operation (reads refuse to follow it, overwrites refuse it).
   */
  async function resolve(userPath, context) {
    const abs = resolvePath(root, userPath === undefined || userPath === "" ? "." : userPath, homeOf(app));
    const r = await env._sh(canonScript(abs), context, abs);
    if (!r.ok) return r;
    const canon = r.value.stdout.trim();
    if (canon !== physicalRoot && !canon.startsWith(`${physicalRoot}/`)) {
      return { ok: false, error: bad("path is outside the session directory", canon, "permission_denied") };
    }
    const rel = canon === physicalRoot ? "" : canon.slice(physicalRoot.length + 1);
    if (isProtectedPath(rel)) {
      return { ok: false, error: bad("refusing to touch a protected path (.env / .git)", canon, "permission_denied") };
    }
    return { ok: true, value: canon };
  }

  /**
   * List one directory. `path` may be relative to the root or absolute-inside-root.
   * Returns { path, root, entries: [{name, path(rel), kind, size, mtimeMs, protected}], truncated }.
   */
  async function list(userPath, context) {
    const canon = await resolve(userPath, context);
    if (!canon.ok) return canon;
    const dir = canon.value;
    // One exec lists names AND metadata: `stat --printf` (GNU syntax — the Sprite toolchain) over the
    // directory's glob, NUL-separated. An entry that is a symlink to outside is LISTED (kind
    // "symlink") so the user sees it; read/write resolution still refuses it.
    const script =
      `cd ${shellQuote([dir])} && for entry in .[!.]* ..?* *; do ` +
      `[ -e "$entry" ] || [ -L "$entry" ] || continue; ` +
      `stat --printf '%F|%s|%.3Y|%n\\0' -- "$entry"; done`;
    const r = await env._sh(script, context, dir);
    if (!r.ok) return r;
    const entries = [];
    let truncated = false;
    for (const rec of r.value.stdout.split("\0")) {
      if (!rec) continue;
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        break;
      }
      const i1 = rec.indexOf("|");
      const i2 = rec.indexOf("|", i1 + 1);
      const i3 = rec.indexOf("|", i2 + 1);
      if (i3 < 0) continue;
      const type = rec.slice(0, i1);
      const kind = type.startsWith("regular") ? "file" : type === "directory" ? "directory" : type === "symbolic link" ? "symlink" : undefined;
      if (!kind) continue;
      const name = rec.slice(i3 + 1);
      const rel = canonRel(physicalRoot, posix.join(dir, name));
      entries.push({
        name,
        path: rel,
        kind,
        size: Number(rec.slice(i1 + 1, i2)),
        mtimeMs: Math.round(Number(rec.slice(i2 + 1, i3)) * 1000),
        protected: isProtectedPath(rel),
      });
    }
    entries.sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || a.name.localeCompare(b.name));
    return { ok: true, value: { path: canonRel(physicalRoot, dir) || ".", root, entries, truncated } };
  }

  /**
   * Read a regular file as base64. Symlinks and anything outside the root are refused; files bigger
   * than MAX_READ_BYTES are refused explicitly (never silently truncated).
   */
  async function read(userPath, context) {
    const canon = await resolve(userPath, context);
    if (!canon.ok) return canon;
    const abs = canon.value;
    const s = await env.fileInfo(abs, context); // lstat: a symlink reports kind "symlink", never followed
    if (!s.ok) return s;
    if (s.value.kind === "symlink") return { ok: false, error: bad("refusing to follow a symlink", abs, "permission_denied") };
    if (s.value.kind === "directory") return { ok: false, error: bad("Is a directory", abs, "is_directory") };
    if (s.value.kind !== "file") return { ok: false, error: bad("Not a regular file", abs, "invalid") };
    if (s.value.size > MAX_READ_BYTES) {
      return { ok: false, error: bad(`File is larger than ${MAX_READ_BYTES} bytes`, abs, "invalid") };
    }
    const b = await env.readBinaryFile(abs, context);
    if (!b.ok) return b;
    return {
      ok: true,
      value: {
        path: canonRel(physicalRoot, abs),
        size: b.value.length,
        mtimeMs: s.value.mtimeMs,
        base64: Buffer.from(b.value).toString("base64"),
      },
    };
  }

  /**
   * Upload bytes to `userPath`. Parent directories must exist already (no implicit mkdir, matching the
   * "browse then drop a file into the shown directory" flow). An existing file requires
   * `opts.overwrite === true`; without it the call fails with code "conflict".
   */
  async function write(userPath, bytes, opts, context) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("write requires bytes");
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return { ok: false, error: bad(`Upload is larger than ${MAX_UPLOAD_BYTES} bytes`, userPath, "invalid") };
    }
    const canon = await resolve(userPath, context);
    if (!canon.ok) return canon;
    const abs = canon.value;
    const s = await env.fileInfo(abs, context);
    if (s.ok) {
      if (s.value.kind === "directory") return { ok: false, error: bad("Is a directory", abs, "is_directory") };
      if (s.value.kind === "symlink") return { ok: false, error: bad("refusing to overwrite a symlink", abs, "permission_denied") };
      if (opts?.overwrite !== true) {
        return { ok: false, error: bad(`File exists; pass overwrite to replace it`, abs, "conflict") };
      }
    } else if (s.error.code !== "not_found") {
      return s;
    }
    const parent = await env.fileInfo(posix.dirname(abs), context);
    if (!parent.ok) return parent;
    if (parent.value.kind !== "directory") return { ok: false, error: bad("Not a directory", abs, "not_directory") };
    const w = await env.writeFile(abs, bytes, context);
    if (!w.ok) return w;
    const after = await env.fileInfo(abs, context);
    return { ok: true, value: { path: canonRel(physicalRoot, abs), size: after.ok ? after.value.size : bytes.length } };
  }

  return { env, root: physicalRoot, workspace, list, read, write, resolve };
}
