// Read-only git inspection for one session worktree (AMP13-git). Everything runs through the workspace binding's
// `bash(command, {timeoutMs})` primitive against a server-resolved directory; this module never sees a token and
// never emits a mutating git command (no checkout / reset / fetch / push / clean / stash / config writes).
//
// Injection model: every git invocation is `git -C <dir>` with each argument passed through `shellQuote` and a literal
// `--` separating options from pathspecs. A path like `-r` or `--output=…` can therefore never become an option.
// Refs are validated character-by-character (git check-ref-format component rules) before they reach the shell.
//
// Shell is POSIX sh (Sprite dash): no pipefail, no arrays, no `local`. Diffs pass `--exit-code` so the pipeline's
// final `head -c` still surfaces git's real failure (128) instead of masking it as a clean empty diff.
import { posix } from "node:path";
import { shellQuote } from "./env.mjs";

/** Ref names are whitelisted: alnum plus `._/-` and `@` (for `@{n}`-free names like `HEAD`), same idea as the
 * issue-branch rule in routes/workspaces.mjs. Anything with shell metachars or `..`/`@{`/`.lock` is rejected. */
const REF_CHARS = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;
const REF_MAX_LEN = 200;
/** A commit may be given as a 7–40 hex SHA or any valid ref name (e.g. HEAD). */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export class GitViewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GitViewError";
    this.code = code;
  }
}

const invalid = (msg) => new GitViewError("invalid", msg);

/** Validate a user-supplied ref name or SHA; returns the verbatim string for quoting. Throws GitViewError("invalid"). */
export function checkRef(ref, { what = "ref" } = {}) {
  const r = String(ref ?? "").trim();
  if (!r || r.length > REF_MAX_LEN) throw invalid(`${what} is required (max ${REF_MAX_LEN} characters)`);
  if (SHA_RE.test(r)) return r;
  if (!REF_CHARS.test(r)) throw invalid(`${what} is not a valid git ref`);
  if (r.endsWith("/") || r.endsWith(".") || r.endsWith(".lock")) throw invalid(`${what} is not a well-formed git ref`);
  if (r.includes("..") || r.includes("@{") || r.includes("//")) throw invalid(`${what} is not a well-formed git ref`);
  for (const p of r.split("/")) {
    if (!p || p.startsWith(".") || p.endsWith(".lock")) throw invalid(`${what} is not a well-formed git ref`);
  }
  return r;
}

/** Repo-relative pathspec placed after `--`; rejects everything that could escape the worktree or read as an option. */
export function checkPath(path) {
  const p = String(path ?? "");
  if (!p) throw invalid("path is required");
  if (p.length > 2000) throw invalid("path is too long (max 2000 characters)");
  if (p.includes("\0") || /[\r\n]/.test(p)) throw invalid("path contains control characters");
  if (p.startsWith("/") || p === ".." || p.startsWith("../") || p.includes("/../") || p.endsWith("/..")) {
    throw invalid("path must stay inside the repository");
  }
  if (p.startsWith("-")) throw invalid("path must not start with '-'");
  return p;
}

/** Hard cap enforced inside the shell (`head -c`); the response additionally flags `truncated`. */
export const DIFF_LIMIT_BYTES = 300_000;
export const STATUS_FILE_LIMIT = 2_000;
export const LOG_LIMIT = 100;
export const REFS_LIMIT = 500;
const GIT_TIMEOUT_MS = 30_000;

/**
 * Run a fixed read-only git pipeline inside `dir`. Output above `limitBytes` is cut and flagged `truncated`.
 *
 * POSIX sh has no pipefail, so `git … | head` would mask git's own failure (bad ref exits 128 but head exits 0 —
 * the old code showed an empty "successful" diff). Instead git writes to a fresh temp file whose own exit code is
 * what the script reports; `head -c` reads only the capped slice. `args` are git arguments (never shell text),
 * each quoted. `diff` callers pass `--exit-code` so a real diff exits 0 while a bad ref still fails (128).
 */
async function runGit(bash, dir, args, { limitBytes } = {}) {
  const cmd = `git -C ${shellQuote([dir])} ${shellQuote(args)}`;
  const script = limitBytes
    ? `tmpf=$(mktemp "\${TMPDIR:-/tmp}/gv-git-XXXXXX") || exit 1; trap 'rm -f "$tmpf"' EXIT HUP INT TERM; ` +
      `${cmd} > "$tmpf"; code=$?; head -c ${limitBytes + 1} < "$tmpf"; exit $code`
    : cmd;
  let r;
  try {
    r = await bash(script, { timeoutMs: GIT_TIMEOUT_MS });
  } catch (e) {
    throw new GitViewError("git", `git exec failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (r?.timedOut) throw new GitViewError("git", "git command timed out");
  if (r?.exitCode !== 0) {
    const stderr = String(r?.stderr ?? r?.stdout ?? "").trim();
    const notRepo = /not a git repository|cannot change to|No such file or directory/i.test(stderr);
    throw new GitViewError("git", notRepo ? `not a git worktree: ${dir}` : `git failed (${r?.exitCode}): ${stderr.slice(0, 400) || "unknown error"}`);
  }
  const out = String(r?.stdout ?? "");
  const truncated = limitBytes ? Buffer.byteLength(out, "utf8") > limitBytes : false;
  return { stdout: truncated ? out.slice(0, limitBytes) : out, truncated };
}

const PORCELAIN_RE = /^([ MADRCU?!]{2}) (.*)$/;

function classifyStatus(code) {
  const [x, y] = code;
  const staged = x !== " " && x !== "?";
  const unstaged = y !== " ";
  const kind = code === "??" ? "untracked" : staged && unstaged ? "both" : staged ? "staged" : "unstaged";
  return { staged, unstaged, kind };
}

/** `-z` porcelain v1: rename/copy records carry `XY new\0old`; we surface the new path only. */
function parsePorcelain(text) {
  const records = text.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const m = PORCELAIN_RE.exec(records[i]);
    if (!m) continue;
    if (/^[RC]/.test(m[1]) && i + 1 < records.length) i++;
    files.push({ path: m[2], status: m[1], ...classifyStatus(m[1]) });
  }
  return files;
}

/** `git status` summary of one worktree: pinned head, branch (null = detached) and classified files. */
export async function gitStatus(bash, dir) {
  const [head, branch, porcelain] = await Promise.all([
    runGit(bash, dir, ["rev-parse", "HEAD"]),
    runGit(bash, dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({ stdout: "" })),
    runGit(bash, dir, ["status", "--porcelain=v1", "-z", "--", "."]),
  ]);
  let files = parsePorcelain(porcelain.stdout);
  const filesTruncated = files.length > STATUS_FILE_LIMIT;
  if (filesTruncated) files = files.slice(0, STATUS_FILE_LIMIT);
  return {
    dir,
    head: head.stdout.trim(),
    branch: branch.stdout.trim() === "HEAD" ? null : branch.stdout.trim() || null,
    files,
    filesTruncated,
  };
}

const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=40%"];

/**
 * Read-only `git diff` inside `dir`. `refs` are validated, `paths` go after a literal `--`, output is capped at
 * DIFF_LIMIT_BYTES and flagged `truncated`. `--exit-code` normalizes "has diff" to 0 while keeping real failures
 * (bad ref, not a repo) as non-zero through the `head -c` pipe.
 */
export async function gitDiff(bash, dir, { refs = [], args = [], paths = [] } = {}) {
  const argv = [...DIFF_FLAGS, ...args];
  for (const ref of refs) argv.push(checkRef(ref));
  argv.push("--");
  for (const p of paths) argv.push(checkPath(p));
  const { stdout, truncated } = await runGit(bash, dir, argv, { limitBytes: DIFF_LIMIT_BYTES });
  return { diff: stdout, truncated };
}

/** Unstaged or staged worktree diff, optionally narrowed to one path. */
export function workingTreeDiff(bash, dir, { staged = false, path } = {}) {
  return gitDiff(bash, dir, { args: staged ? ["--cached"] : [], paths: path === undefined ? [] : [path] });
}

/** Segments that must never be read directly even when they stay inside the worktree root. */
const PROTECTED_SEGMENTS = new Set([".git", ".env", ".envrc", ".netrc", ".ssh", ".gnupg", ".aws", ".docker"]);
const PROTECTED_BASENAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "config"]);

/**
 * Patch for one untracked file. The path is confined to the canonical worktree root (any symlink component that
 * escapes is refused), and protected secret segments are refused outright before any read. The file is copied to a
 * fresh temp file (realpath-clean target, no symlink follow) and diffed with `git diff -- /dev/null`, which prints
 * the file's real repo path in the header. Empty files produce an all-additions diff via the same code path; a
 * directory yields a "not a regular file" error.
 */
export async function untrackedFileDiff(bash, dir, path) {
  const p = checkPath(path);
  // Reject protected segments in JS first — a `.git` dir or `.env` under the root must never be copied out.
  const segments = p.split("/").filter(Boolean);
  for (const seg of segments) {
    if (PROTECTED_SEGMENTS.has(seg) || PROTECTED_BASENAMES.has(seg) || seg.startsWith(".env.")) {
      throw invalid("path is protected and cannot be read");
    }
  }

  // POSIX-sh script: canonicalize the worktree root, refuse any symlink component (final or intermediate), refuse
  // directories, then copy the file to a fresh realpath-clean temp and diff it. `cd -P` resolves `..` and symlinks.
  // `mktemp` creates a real file; `cp` follows the (already verified non-symlink) source so the temp copy is a
  // regular file — `git diff` sees the file content, never a symlink. Git writes to a temp output file (no pipefail
  // in POSIX sh, so `| head` would mask git's exit); `--exit-code` keeps a real failure non-zero, `head -c` caps the
  // returned bytes.
  const script = [
    `cd -P ${shellQuote([dir])} || exit 1`,
    `root=$(pwd -P)`,
    `p=${shellQuote([p])}`,
    // Refuse any symlink component: check every ancestor plus the leaf. `test -L` covers the leaf; the loop checks
    // each ancestor so `a/../../etc/passwd` (where `a` is a symlink) is refused even though `-L` on the leaf alone
    // would pass.
    `rest="$p"; t=""`,
    `while [ -n "$rest" ]; do seg="\${rest%%/*}"; [ -n "$t" ] && t="$t/$seg" || t="$seg"; [ -L "$t" ] && exit 3; case "$rest" in */*) rest="\${rest#*/}";; *) break;; esac; done`,
    // Canonicalize the final path and confine it to the worktree root.
    `abs=$(cd -P -- "$(dirname -- "$t")" && pwd -P)/$(basename -- "$t")`,
    `case "$abs" in "$root"/*) ;; *) exit 3;; esac`,
    `[ -d "$t" ] && exit 4`,
    `outf=$(mktemp "\${TMPDIR:-/tmp}/gv-out-XXXXXX") || exit 1`,
    `trap 'rm -f "$outf"' EXIT HUP INT TERM`,
    `git diff --no-color --no-ext-diff --no-textconv --no-index -- /dev/null "$p" > "$outf"`,
    // `git diff -- /dev/null <file>` exits 1 when the file has content (the normal untracked-file case); `--exit-code`
    // makes that explicit. Map it to 0 for the response while a real failure (>=2: not a repo, unreadable, …) stays an
    // error — head's exit never masks it.
    `code=$?; [ "$code" -eq 1 ] && code=0`,
    `head -c ${DIFF_LIMIT_BYTES + 1} < "$outf"`,
    `exit $code`,
  ].join("; ");

  let r;
  try {
    r = await bash(script, { timeoutMs: GIT_TIMEOUT_MS });
  } catch (e) {
    throw new GitViewError("git", `git exec failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (r?.timedOut) throw new GitViewError("git", "git command timed out");
  if (r?.exitCode === 3) return { diff: "", symlink: true, truncated: false };
  if (r?.exitCode === 4) return { diff: "", directory: true, truncated: false };
  if (r?.exitCode !== 0) {
    const stderr = String(r?.stderr ?? "").trim();
    throw new GitViewError("git", `git failed (${r?.exitCode}): ${stderr.slice(0, 400) || "unknown error"}`);
  }
  const out = String(r?.stdout ?? "");
  const truncated = Buffer.byteLength(out, "utf8") > DIFF_LIMIT_BYTES;
  return { diff: truncated ? out.slice(0, DIFF_LIMIT_BYTES) : out, symlink: false, truncated };
}

/** Recent commits (git's default newest-first order). */
export async function gitLog(bash, dir, { limit = 50 } = {}) {
  const n = Math.min(Math.max(1, Math.floor(limit) || 50), LOG_LIMIT);
  const fmt = "%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%P";
  const { stdout } = await runGit(bash, dir, ["log", `-${n}`, `--format=${fmt}`, "--", "."]);
  const commits = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [sha, short, author, email, at, subject, parents] = line.split("\0");
    commits.push({ sha, short, author, email, at, subject, parents: parents ? parents.split(" ") : [] });
  }
  return { commits };
}

/**
 * Diff of one commit. `git show --format=` prints the patch without the commit header and handles both normal and
 * root commits correctly — unlike `sha^!`, which silently emits an empty diff on a root commit.
 */
export async function gitCommitDiff(bash, dir, sha) {
  const s = checkRef(sha, { what: "commit" });
  const { stdout, truncated } = await runGit(bash, dir, ["show", "--format=", "--no-color", "--no-ext-diff", "--no-textconv", s, "--"], {
    limitBytes: DIFF_LIMIT_BYTES,
  });
  return { diff: stdout, truncated };
}

/** Refs the user may pick as a comparison base: local + remote branches and tags, no symbolic HEAD aliases. */
export async function gitRefs(bash, dir) {
  const fmt = "%(refname)%00%(objectname)%00%(objecttype)";
  const { stdout } = await runGit(bash, dir, [
    "for-each-ref",
    `--format=${fmt}`,
    `--count=${REFS_LIMIT}`,
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const refs = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [refname, sha, type] = line.split("\0");
    if (!refname) continue;
    let kind;
    let name;
    if (refname.startsWith("refs/heads/")) {
      kind = "branch";
      name = refname.slice("refs/heads/".length);
    } else if (refname.startsWith("refs/remotes/")) {
      kind = "remote";
      name = refname.slice("refs/remotes/".length);
    } else if (refname.startsWith("refs/tags/")) {
      kind = "tag";
      name = refname.slice("refs/tags/".length);
    } else {
      continue;
    }
    // Never expose a symbolic HEAD alias (`refs/remotes/origin/HEAD` etc.) — it is not a usable compare base.
    if (name === "HEAD" || name.endsWith("/HEAD")) continue;
    refs.push({ name, sha, kind });
  }
  return { refs, truncated: refs.length >= REFS_LIMIT };
}

/** Compare `base...HEAD` (merge-base), per file or whole diff. `nameStatus` gives the file list for the picker. */
export async function gitCompare(bash, dir, base, { path, nameStatus = false } = {}) {
  const b = checkRef(base, { what: "base" });
  if (nameStatus) {
    const { stdout } = await runGit(bash, dir, ["diff", "--no-color", "--no-textconv", "--name-status", `${b}...HEAD`, "--"]);
    const files = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      files.push({ status: parts[0].trim(), path: parts[parts.length - 1] ?? "" });
    }
    const truncated = files.length > STATUS_FILE_LIMIT;
    return { files: truncated ? files.slice(0, STATUS_FILE_LIMIT) : files, truncated };
  }
  // `b` is already a validated ref; the literal `...HEAD` suffix is assembled here and the whole word is quoted.
  const argv = [...DIFF_FLAGS, `${b}...HEAD`, "--"];
  if (path !== undefined) argv.push(checkPath(path));
  const { stdout, truncated } = await runGit(bash, dir, argv, { limitBytes: DIFF_LIMIT_BYTES });
  return { diff: stdout, truncated };
}
