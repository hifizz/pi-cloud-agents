// Delegation helper (AMP13-delegation): small file support for the product "委派子任务" panel.
// The user explicitly picks a file that lives INSIDE a session's worktree; the content is read
// through the workspace's own Sprite bash (never a host path) and returned as text for the
// delegation/message forms. Everything is opt-in per request: nothing scans a worktree on its own.
import { SandboxEnv, resolvePath } from "./env.mjs";

/** Largest file the delegation reader will return; bigger is an explicit error, never a silent cut. */
export const MAX_FILE_BYTES = 64 * 1024;
/** Largest message a delegation route sends into a conversation. */
export const MAX_TEXT_CHARS = 20_000;
/** Bounded delegation tree: a session may not delegate once it is itself a delegation child at this depth. */
export const MAX_DEPTH = 2;
/** Max delegation children per parent session (children + failed creation attempts). */
export const MAX_CHILDREN = 10;
/** Max pending results a parent session accumulates before another read is refused. */
export const MAX_RESULTS = 20;
/** How much of one result is inlined into the parent message; the rest is stored on the task record. */
export const RESULT_INLINE_CHARS = 8_000;
/** How much of one result is kept on the task record at all. */
export const RESULT_STORED_CHARS = 20_000;
/** Child sessions get their own branch + worktree so they never write into the parent's directory. */
export const CHILD_BRANCH_RE = /^tarsbot\/task-[0-9a-z]+$/;

const HOME_FALLBACK = "/home/sprite";

/** Basenames that must never be read out of a worktree (case-insensitive). `.env*` covers every
 * variant (.env, .env.local, .env.production, …); SSH key filenames are matched by prefix too. */
const DENIED_EXACT = new Set([".netrc", ".gitconfig", ".git-credentials", "credentials", "authorized_keys", "known_hosts", "config.json"]);
const DENIED_PREFIX = [".env", "id_rsa", "id_dsa", "id_ed25519", "id_ecdsa"];
/** Protected single path segments — a symlink that resolves into any of these is refused. Entries are
 * single names (".config/gh" can never match a split segment). `.git` here means the git metadata dir,
 * not every dot-directory. */
const DENIED_SEGMENTS = new Set([".git", ".ssh", ".gnupg", ".aws", ".config", ".kube", ".docker"]);

/** A basename is protected when it is exactly denied, is an `.env*` variant, or an SSH key name. */
function deniedBasename(name) {
  const n = String(name ?? "").toLowerCase();
  if (!n) return false;
  return DENIED_EXACT.has(n) || DENIED_PREFIX.some((p) => n === p || n.startsWith(`${p}.`));
}

/** A resolved path is safe only when no segment is protected and the basename is not protected. */
export function isProtectedPath(abs) {
  const segments = String(abs).split("/").filter(Boolean);
  if (segments.some((s) => DENIED_SEGMENTS.has(s))) return "path crosses a protected directory";
  if (deniedBasename(segments.at(-1))) return "this file type is not transferable";
  return undefined;
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Validate a user-typed path and resolve it inside `dir` (the session's real, server-recorded worktree).
 * Relative paths resolve against `dir`; absolute paths are allowed only inside `dir` or the workspace's
 * own repo dir `ws.cwd`. Lexical containment first — everything deeper is checked again by the
 * realpath guard in the env.
 * @returns {{ ok: true, abs: string } | { ok: false, message: string }}
 */
export function resolveWorktreePath(input, { dir, workspaceCwd }) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, message: "path is required" };
  if (raw.includes("\0")) return { ok: false, message: "path contains a NUL byte" };
  const abs = resolvePath(dir, raw, HOME_FALLBACK);
  const inDir = abs === dir || abs.startsWith(`${dir}/`);
  const inRepo = typeof workspaceCwd === "string" && workspaceCwd && (abs === workspaceCwd || abs.startsWith(`${workspaceCwd}/`));
  if (!inDir && !inRepo) return { ok: false, message: "path must be inside the session worktree or the workspace repository" };
  const segments = abs.split("/").filter(Boolean);
  const why = isProtectedPath(abs);
  if (why) return { ok: false, message: why };
  return { ok: true, abs };
}

/** One bash primitive call mapped to a visible failure (never a silent empty file). */
async function sh(bash, command, timeoutMs = 30_000) {
  const r = await bash(command, { timeoutMs });
  if (r?.timedOut) throw fail("unknown", "sprite command timed out");
  if (r?.exitCode !== 0) throw fail("unknown", `sprite command failed (${r?.exitCode}): ${String(r?.stderr ?? "").trim().slice(0, 200)}`);
  return String(r?.stdout ?? "");
}

/**
 * Read a validated worktree file on the workspace's Sprite.
 * - `realpath -e` resolves the file and the result must still be inside the session dir / repo dir
 *   (symlink escape refused).
 * - `stat` follows the link and requires a regular file (directories / fifos / devices refused).
 * - Size is checked BEFORE reading; an over-limit file is an explicit error.
 * `bash` is `app.ctx.runtimeBash(workspaceId)`'s result — the active binding of THIS workspace only.
 * @returns {Promise<{ path: string, resolvedPath: string, size: number, truncated: false, content: string }>}
 */
export async function readWorktreeFile({ bash, dir, workspaceCwd, path }) {
  if (typeof bash !== "function") throw fail("unavailable", "runtime bash is not available");
  const resolved = resolveWorktreePath(path, { dir, workspaceCwd });
  if (!resolved.ok) throw fail("invalid", resolved.message);
  const abs = resolved.abs;
  const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
  const canon = (await sh(bash, `realpath -e -- ${q(abs)}`)).split("\n")[0].trim();
  const inDir = canon === dir || canon.startsWith(`${dir}/`);
  const inRepo = typeof workspaceCwd === "string" && workspaceCwd && (canon === workspaceCwd || canon.startsWith(`${workspaceCwd}/`));
  if (!inDir && !inRepo) throw fail("invalid", "path resolves outside the session worktree (symlink escape refused)");
  const canonSegments = canon.split("/").filter(Boolean);
  if (canonSegments.some((s) => DENIED_SEGMENTS.has(s))) throw fail("invalid", "resolved path crosses a protected directory");
  if (deniedBasename(canonSegments.at(-1))) throw fail("invalid", "resolved file type is not transferable");
  const stat = await sh(bash, `stat -Lc '%F|%s' -- ${q(canon)}`);
  const [kind, sizeText] = stat.split("|");
  if (!/^regular file/.test(kind ?? "")) throw fail("invalid", `not a regular file: ${path}`);
  const size = Number(sizeText);
  if (!Number.isInteger(size) || size < 0) throw fail("unknown", "could not stat the file");
  if (size > MAX_FILE_BYTES) throw fail("too_large", `file is ${size} bytes; delegation only transfers files up to ${MAX_FILE_BYTES} bytes`);
  const content = await sh(bash, `cat -- ${q(canon)}`, 60_000);
  return { path: abs, resolvedPath: canon, size, truncated: false, content };
}
