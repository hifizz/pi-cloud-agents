// ExecutionEnv adapter: pi-durable's FileSystem + Shell implemented on top of a remote Linux sandbox.
// Everything goes through one primitive, `bash(command, {timeoutMs}) -> {stdout, stderr, exitCode, timedOut}`
// (non-streaming `/bin/sh -c`), supplied by the caller (src/providers/*, routed per workspace by
// src/workspace-env.mjs). Binary data travels as base64.
// Methods never throw; they return Result values (FileError / ExecutionError).
import { posix } from "node:path";
import { ExecutionError, FileError, LineScanner, err, ok } from "@earendil-works/pi-durable/env";

/** Largest file `openBinaryReader` loads into memory. */
export const MAX_READER_BYTES = 32 * 1024 * 1024;
/**
 * Raw bytes per write command. The tightest limit is Sprites: an exec puts the whole command into a WebSocket URL
 * (limit ~64,000 chars after percent-encoding; base64 `+ / =` grow 3x), so 12 KiB raw (16 KB base64, <= ~49 KB
 * encoded even for adversarial data) is safe on every sandbox.
 */
export const WRITE_CHUNK_BYTES = 12 * 1024;
const DEFAULT_HOME = "/home/sprite";
const DEFAULT_FS_TIMEOUT_MS = 120_000;
const DEFAULT_WATCH_INTERVAL_MS = 500;
const MAX_WATCH_ENTRIES = 20_000;
const STAT_BATCH = 200;
const CWD_MISSING = "tarsbot: working directory does not exist";
const ABORTED = Symbol("aborted");

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

/** Quote one word for POSIX sh (single-quote scheme). */
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/** Quote an argv array into one shell command line. Empty strings become `''`. */
export function shellQuote(argv) {
  return Array.from(argv, q).join(" ");
}

/** Map a tool's stderr text (coreutils messages) to a FileError. */
export function mapFileError(stderr, path) {
  const text = String(stderr ?? "").trim();
  let code = "unknown";
  if (/No such file or directory/i.test(text)) code = "not_found";
  else if (/Permission denied|Operation not permitted/i.test(text)) code = "permission_denied";
  else if (/Not a directory/i.test(text)) code = "not_directory";
  else if (/Is a directory/i.test(text)) code = "is_directory";
  else if (/Invalid argument/i.test(text)) code = "invalid";
  return new FileError(code, text || "command failed", path);
}

/** POSIX path resolution relative to `cwd`; `~` means the sandbox home. */
export function resolvePath(cwd, path, home = DEFAULT_HOME) {
  let p = String(path);
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = posix.join(home, p.slice(2));
  return posix.isAbsolute(p) ? posix.resolve(p) : posix.resolve(cwd, p);
}

const abortedFile = (path) => err(new FileError("aborted", "aborted", path));

function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(ABORTED);
    const onAbort = () => reject(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function kindFromType(text) {
  if (text.startsWith("regular")) return "file";
  if (text === "directory") return "directory";
  if (text === "symbolic link") return "symlink";
  return undefined;
}

const kindFromFindType = (y) => (y === "f" ? "file" : y === "d" ? "directory" : y === "l" ? "symlink" : undefined);

const toMs = (seconds) => Math.round(Number(seconds) * 1000);

/** Parse `%F|%s|%.3Y`. */
function parseStat(path, line) {
  const [type, size, mtime] = line.trim().split("|");
  const kind = kindFromType(type ?? "");
  if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
  return ok({ name: posix.basename(path), path, kind, size: Number(size), mtimeMs: toMs(mtime) });
}

/** Script prologue: fail with a stderr message that `mapFileError` understands unless `dir` is a directory. */
const requireDir = (dir) =>
  `if [ ! -d ${q(dir)} ]; then if [ -e ${q(dir)} ]; then echo 'Not a directory' >&2; else echo 'No such file or directory' >&2; fi; exit 1; fi`;

// ---------------------------------------------------------------------------------------------------------------
// Readers

class MemoryBinaryReader {
  #bytes;
  #info;
  #closed = false;
  constructor(bytes, info) {
    this.#bytes = bytes;
    this.#info = info;
  }
  async info(context) {
    if (context.abortSignal?.aborted) return abortedFile(this.#info.path);
    if (this.#closed) return err(new FileError("invalid", "Binary reader is closed", this.#info.path));
    return ok({ ...this.#info });
  }
  async read(offset, length, context) {
    if (context.abortSignal?.aborted) return abortedFile(this.#info.path);
    if (this.#closed) return err(new FileError("invalid", "Binary reader is closed", this.#info.path));
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.#info.path));
    }
    return ok(this.#bytes.slice(Math.min(offset, this.#bytes.length), Math.min(offset + length, this.#bytes.length)));
  }
  async scanLines(options, context) {
    if (context.abortSignal?.aborted) return abortedFile(this.#info.path);
    if (this.#closed) return err(new FileError("invalid", "Binary reader is closed", this.#info.path));
    let scanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError("invalid", "Invalid line range", this.#info.path));
    }
    scanner.push(this.#bytes);
    return ok(scanner.finish());
  }
  async close() {
    this.#closed = true;
  }
}

class MemoryTextLineReader {
  #text;
  #pos = 0;
  #closed = false;
  #path;
  constructor(text, path) {
    this.#text = text;
    this.#path = path;
  }
  async readLine(context) {
    if (context.abortSignal?.aborted) return abortedFile(this.#path);
    if (this.#closed) return err(new FileError("invalid", "Text line reader is closed", this.#path));
    if (this.#pos >= this.#text.length) return ok(undefined);
    const nl = this.#text.indexOf("\n", this.#pos);
    if (nl === -1) {
      const text = this.#text.slice(this.#pos);
      this.#pos = this.#text.length;
      return ok({ text, terminated: false });
    }
    const text = this.#text.slice(this.#pos, nl);
    this.#pos = nl + 1;
    return ok({ text, terminated: true });
  }
  async close() {
    this.#closed = true;
    this.#text = "";
  }
}

/** Enumerates names at open time, reads metadata lazily per page (entries removed meanwhile are skipped). */
class NamesDirReader {
  #env;
  #dir;
  #names;
  #pos = 0;
  #closed = false;
  constructor(env, dir, names) {
    this.#env = env;
    this.#dir = dir;
    this.#names = names;
  }
  async next(maxEntries, context) {
    if (context.abortSignal?.aborted) return abortedFile(this.#dir);
    if (this.#closed) return err(new FileError("invalid", "Directory reader is closed", this.#dir));
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.#dir));
    }
    const entries = [];
    while (entries.length < maxEntries && this.#pos < this.#names.length) {
      const batch = this.#names.slice(this.#pos, this.#pos + Math.min(maxEntries - entries.length, STAT_BATCH));
      this.#pos += batch.length;
      const script = `cd ${q(this.#dir)} && stat --printf '%F|%s|%.3Y|%n\\0' -- ${shellQuote(batch)} 2>/dev/null; true`;
      const r = await this.#env._sh(script, context, this.#dir);
      if (!r.ok) return r;
      for (const rec of r.value.stdout.split("\0")) {
        if (!rec) continue;
        const i1 = rec.indexOf("|");
        const i2 = rec.indexOf("|", i1 + 1);
        const i3 = rec.indexOf("|", i2 + 1);
        if (i3 < 0) continue;
        const kind = kindFromType(rec.slice(0, i1));
        if (!kind) continue; // unsupported kinds are skipped
        entries.push({
          name: rec.slice(i3 + 1),
          path: posix.join(this.#dir, rec.slice(i3 + 1)),
          kind,
          size: Number(rec.slice(i1 + 1, i2)),
          mtimeMs: toMs(rec.slice(i2 + 1, i3)),
        });
      }
    }
    return ok({ entries, done: this.#pos >= this.#names.length });
  }
  async close() {
    this.#closed = true;
    this.#names = [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Environment

export class SandboxEnv {
  /** Equal ids see the same files: every SandboxEnv talks to the one shared sandbox (`<sandbox>:<name>`). */
  id;
  cwd;
  #bash;
  #shell;
  #home;
  #fsTimeoutMs;
  #watchIntervalMs;
  #watchers = new Set();

  /**
   * @param {object} opts
   * @param {string} opts.cwd
   * @param {(command: string, o: {timeoutMs?: number}) => Promise<{stdout: string, stderr: string, exitCode?: number, timedOut?: boolean}>} [opts.bash]
   * @param {string|null} [opts.shell] program that runs string commands (`-c`); default /bin/bash (LLM commands use bashisms). null = plain sh.
   * @param {string} [opts.home] sandbox home that `~` resolves to (default /home/sprite)
   * @param {string} [opts.id] env id; equal ids see the same files (default "sandbox")
   */
  constructor({ cwd, bash, shell = "/bin/bash", home = DEFAULT_HOME, id, fsTimeoutMs, watchIntervalMs } = {}) {
    if (typeof cwd !== "string" || !cwd) throw new TypeError("SandboxEnv requires a cwd");
    if (typeof bash !== "function") throw new TypeError("SandboxEnv requires a bash primitive");
    this.id = id ?? "sandbox";
    this.cwd = cwd;
    this.#bash = bash;
    this.#shell = shell;
    this.#home = home;
    this.#fsTimeoutMs = fsTimeoutMs ?? DEFAULT_FS_TIMEOUT_MS;
    this.#watchIntervalMs = watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  }

  #p(path) {
    return resolvePath(this.cwd, path, this.#home);
  }

  /** @internal Run a script that must exit 0; failures become FileErrors mapped from stderr. */
  async _sh(script, context, path, { timeoutMs } = {}) {
    const signal = context?.abortSignal;
    if (signal?.aborted) return abortedFile(path);
    let r;
    try {
      r = await raceAbort(this.#bash(script, { timeoutMs: timeoutMs ?? this.#fsTimeoutMs }), signal);
    } catch (e) {
      if (e === ABORTED) return abortedFile(path);
      const cause = e instanceof Error ? e : new Error(String(e));
      return err(new FileError("unknown", cause.message, path, cause));
    }
    if (signal?.aborted) return abortedFile(path);
    if (r.timedOut) return err(new FileError("unknown", "Sandbox command timed out", path));
    if (r.exitCode !== 0) return err(mapFileError(r.stderr || `exit ${r.exitCode ?? "signal"}`, path));
    return ok({ stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  }

  // ---- paths ----------------------------------------------------------------------------------------------

  async absolutePath(path) {
    return ok(this.#p(path));
  }

  async joinPath(parts) {
    return ok(posix.join(...parts));
  }

  // ---- Shell ----------------------------------------------------------------------------------------------

  async exec(command, options, context) {
    const signal = context?.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));

    let timeoutMs;
    if (options?.timeout !== undefined) {
      if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
        return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
      }
      timeoutMs = Math.ceil(options.timeout * 1000);
    }
    const isArgv = typeof command !== "string";
    if (isArgv && command.length === 0) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));

    const cwd = options?.cwd ? this.#p(options.cwd) : this.cwd;
    const lines = [];
    for (const [k, v] of Object.entries(options?.env ?? {})) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) lines.push(`export ${k}=${q(v)}`);
    }
    lines.push(`cd ${q(cwd)} 2>/dev/null || { echo ${q(CWD_MISSING)} >&2; exit 125; }`);
    if (isArgv) lines.push(`exec ${shellQuote(command)}`);
    else lines.push(this.#shell ? `exec ${q(this.#shell)} -c ${q(command)}` : command);
    const script = lines.join("\n");

    const emit = (text, stream) => {
      if (!text || !options?.onOutput) return undefined;
      try {
        options.onOutput(text, context, { stream });
      } catch (e) {
        const cause = e instanceof Error ? e : new Error(String(e));
        return new ExecutionError("callback_error", cause.message, cause);
      }
      return undefined;
    };

    let r;
    try {
      r = await raceAbort(this.#bash(script, { timeoutMs }), signal);
    } catch (e) {
      if (e === ABORTED) return err(new ExecutionError("aborted", "aborted"));
      const cause = e instanceof Error ? e : new Error(String(e));
      return err(new ExecutionError("spawn_error", cause.message, cause));
    }
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";

    if (r.timedOut) {
      emit(stdout, "stdout");
      emit(stderr, "stderr");
      return err(new ExecutionError("timeout", `Command timed out after ${options?.timeout} seconds`));
    }
    if (r.exitCode === 125 && stderr.includes(CWD_MISSING)) {
      return err(new ExecutionError("spawn_error", `Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
    }
    if (isArgv && ((r.exitCode === 127 && /not found|No such file/i.test(stderr)) || (r.exitCode === 126 && /Permission denied|cannot execute|not executable/i.test(stderr)))) {
      return err(new ExecutionError("spawn_error", stderr.trim() || `Cannot run ${command[0]}`));
    }
    const cbError = emit(stdout, "stdout") ?? emit(stderr, "stderr");
    if (cbError) return err(cbError);
    // No exit code means the process was killed by a signal; report the conventional 128+SIGKILL.
    return ok({ exitCode: r.exitCode ?? 137 });
  }

  // ---- reading --------------------------------------------------------------------------------------------

  async readBinaryFile(path, context) {
    const abs = this.#p(path);
    const r = await this._sh(`base64 -w0 -- ${q(abs)}`, context, abs);
    if (!r.ok) return r;
    return ok(new Uint8Array(Buffer.from(r.value.stdout, "base64")));
  }

  async readTextFile(path, context) {
    const r = await this.readBinaryFile(path, context);
    if (!r.ok) return r;
    return ok(Buffer.from(r.value).toString("utf8"));
  }

  async openTextLineReader(path, context) {
    const abs = this.#p(path);
    const r = await this.readBinaryFile(abs, context);
    if (!r.ok) return r;
    return ok(new MemoryTextLineReader(new TextDecoder().decode(r.value), abs));
  }

  async readTextLines(path, options, context) {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const lines = [];
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return ok(lines);
    } finally {
      await opened.value.close(context);
    }
  }

  async openBinaryReader(path, options, context) {
    const abs = this.#p(path);
    if (options?.noFollow) {
      const l = await this._sh(`stat -c '%F' -- ${q(abs)}`, context, abs);
      if (!l.ok) return l;
      if (l.value.stdout.trim() === "symbolic link") {
        return err(new FileError("invalid", "Refusing to follow a symbolic link", abs));
      }
    }
    const s = await this._sh(`stat -L -c '%F|%s|%.3Y' -- ${q(abs)}`, context, abs);
    if (!s.ok) return s;
    if (s.value.stdout.trim().startsWith("directory")) return err(new FileError("is_directory", "Is a directory", abs));
    const info = parseStat(abs, s.value.stdout);
    if (!info.ok) return info;
    if (info.value.kind !== "file") return err(new FileError("invalid", "Not a regular file", abs));
    if (info.value.size > MAX_READER_BYTES) {
      return err(new FileError("invalid", `File is larger than ${MAX_READER_BYTES} bytes`, abs));
    }
    let bytes = new Uint8Array(0);
    if (info.value.size > 0) {
      const b = await this._sh(`base64 -w0 -- ${q(abs)}`, context, abs);
      if (!b.ok) return b;
      bytes = new Uint8Array(Buffer.from(b.value.stdout, "base64"));
    }
    return ok(new MemoryBinaryReader(bytes, { ...info.value, size: bytes.length }));
  }

  // ---- writing --------------------------------------------------------------------------------------------

  async #writeChunks(abs, content, append, context) {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const prefix = `mkdir -p -- ${q(posix.dirname(abs))} && `;
    if (bytes.length === 0) {
      const r = await this._sh(`${prefix}: ${append ? ">>" : ">"} ${q(abs)}`, context, abs);
      return r.ok ? ok(undefined) : r;
    }
    for (let off = 0; off < bytes.length; off += WRITE_CHUNK_BYTES) {
      const b64 = bytes.subarray(off, off + WRITE_CHUNK_BYTES).toString("base64");
      const op = off === 0 && !append ? ">" : ">>";
      const r = await this._sh(`${off === 0 ? prefix : ""}printf %s ${q(b64)} | base64 -d ${op} ${q(abs)}`, context, abs);
      if (!r.ok) return r;
    }
    return ok(undefined);
  }

  async writeFile(path, content, context) {
    return this.#writeChunks(this.#p(path), content, false, context);
  }

  async appendFile(path, content, context) {
    return this.#writeChunks(this.#p(path), content, true, context);
  }

  async truncateFile(path, size, context) {
    const abs = this.#p(path);
    if (!Number.isSafeInteger(size) || size < 0) {
      return err(new FileError("invalid", "File size must be a non-negative safe integer", abs));
    }
    const script = `if [ ! -e ${q(abs)} ]; then echo 'No such file or directory' >&2; exit 1; fi; truncate -c -s ${size} -- ${q(abs)}`;
    const r = await this._sh(script, context, abs);
    return r.ok ? ok(undefined) : r;
  }

  async flushFile(path, context) {
    const abs = this.#p(path);
    const script = `if [ -d ${q(abs)} ]; then echo 'Is a directory' >&2; exit 1; fi; sync -- ${q(abs)}`;
    const r = await this._sh(script, context, abs);
    return r.ok ? ok(undefined) : r;
  }

  async renameFile(sourcePath, destinationPath, context) {
    const src = this.#p(sourcePath);
    const r = await this._sh(`mv -T -- ${q(src)} ${q(this.#p(destinationPath))}`, context, src);
    return r.ok ? ok(undefined) : r;
  }

  async createDir(path, options, context) {
    const abs = this.#p(path);
    const r = await this._sh(`mkdir ${options?.recursive === false ? "" : "-p "}-- ${q(abs)}`, context, abs);
    return r.ok ? ok(undefined) : r;
  }

  async remove(path, options, context) {
    const abs = this.#p(path);
    const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;
    const r = await this._sh(`rm ${flags ? `-${flags} ` : ""}-- ${q(abs)}`, context, abs);
    return r.ok ? ok(undefined) : r;
  }

  async createTempDir(prefix, context) {
    const r = await this._sh(`mktemp -d -- ${q(`/tmp/${prefix ?? "tmp-"}XXXXXX`)}`, context);
    return r.ok ? ok(r.value.stdout.trim()) : r;
  }

  async createTempFile(options, context) {
    const suffix = options?.suffix ? `${q(`--suffix=${options.suffix}`)} ` : "";
    const r = await this._sh(`mktemp ${suffix}-- ${q(`/tmp/${options?.prefix ?? ""}XXXXXX`)}`, context);
    return r.ok ? ok(r.value.stdout.trim()) : r;
  }

  // ---- metadata -------------------------------------------------------------------------------------------

  async fileInfo(path, context) {
    const abs = this.#p(path);
    const r = await this._sh(`stat -c '%F|%s|%.3Y' -- ${q(abs)}`, context, abs); // lstat semantics (no -L)
    return r.ok ? parseStat(abs, r.value.stdout) : r;
  }

  async exists(path, context) {
    const r = await this.fileInfo(path, context);
    if (r.ok) return ok(true);
    if (r.error.code === "not_found") return ok(false);
    return r.error.code === "invalid" ? ok(true) : err(r.error); // exists, but an unsupported kind
  }

  async canonicalPath(path, context) {
    const abs = this.#p(path);
    const r = await this._sh(`realpath -e -- ${q(abs)}`, context, abs);
    return r.ok ? ok(r.value.stdout.replace(/\n$/, "")) : r;
  }

  async listDir(path, context) {
    const abs = this.#p(path);
    const script = `${requireDir(abs)}\nfind -H ${q(abs)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'`;
    const r = await this._sh(script, context, abs);
    if (!r.ok) return r;
    const infos = [];
    for (const rec of r.value.stdout.split("\0")) {
      if (!rec) continue;
      const [y, size, mtime] = rec.split("\t", 3);
      const name = rec.split("\t").slice(3).join("\t");
      const kind = kindFromFindType(y);
      if (!kind) continue;
      infos.push({ name, path: posix.join(abs, name), kind, size: Number(size), mtimeMs: toMs(mtime) });
    }
    return ok(infos);
  }

  async openDirReader(path, context) {
    const abs = this.#p(path);
    const script = `${requireDir(abs)}\nfind -H ${q(abs)} -mindepth 1 -maxdepth 1 -printf '%f\\0'`;
    const r = await this._sh(script, context, abs);
    if (!r.ok) return r;
    return ok(new NamesDirReader(this, abs, r.value.stdout.split("\0").filter(Boolean)));
  }

  // ---- watch (polling) ------------------------------------------------------------------------------------

  async watch(targets, onChange, context) {
    const list = targets.map((t) => ({
      path: this.#p(t.path),
      recursive: Boolean(t.recursive),
      hidden: Boolean(t.exclude?.hidden),
      names: [...(t.exclude?.names ?? [])],
    }));
    const fmt = `'%p\\t%y\\t%s\\t%T@\\t%i\\0'`;
    const script =
      list
        .map((t) => {
          const excl = [];
          if (t.hidden) excl.push("-name '.*'");
          for (const n of t.names) excl.push(`-name ${q(n)}`);
          const prune = excl.length ? `\\( ${excl.join(" -o ")} \\) -prune -o ` : "";
          const depth = t.recursive ? "" : "-maxdepth 1 ";
          return (
            `find -H ${q(t.path)} -maxdepth 0 -printf ${fmt} 2>/dev/null; ` +
            `find -H ${q(t.path)} -mindepth 1 ${depth}${prune}-printf ${fmt} 2>/dev/null`
          );
        })
        .join("\n") + "\ntrue";

    const snapshot = async (ctx) => {
      const r = await this._sh(script, ctx, list[0]?.path);
      if (!r.ok) return r;
      const map = new Map();
      for (const rec of r.value.stdout.split("\0")) {
        if (!rec) continue;
        const [p, y, size, mtime, inode] = rec.split("\t");
        // Directory size/mtime change with their children; the children are reported themselves.
        map.set(p, y === "d" ? `d|${inode}` : `${y}|${size}|${mtime}|${inode}`);
      }
      return ok(map);
    };

    const first = await snapshot(context);
    if (!first.ok) return first;
    let prev = first.value;
    let closed = false;
    let uncertain = false;
    let timer;
    let wake;
    const sleep = (ms) =>
      new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      });
    const notify = (change) => {
      if (closed) return;
      try {
        onChange(change);
      } catch {
        // a failing listener must not stop the watcher
      }
    };
    const poll = async () => {
      let snap;
      try {
        // Not tied to the caller's context: the watcher outlives the call that created it.
        snap = await snapshot();
      } catch {
        snap = err(new FileError("unknown", "snapshot failed"));
      }
      if (closed) return;
      if (!snap.ok) {
        uncertain = true;
        return;
      }
      const next = snap.value;
      if (next.size > MAX_WATCH_ENTRIES) {
        notify({ error: new FileError("invalid", `Watched tree exceeds ${MAX_WATCH_ENTRIES} entries`) });
        closed = true;
        return;
      }
      const changed = [];
      for (const [p, sig] of next) if (prev.get(p) !== sig) changed.push(p);
      for (const p of prev.keys()) if (!next.has(p)) changed.push(p);
      prev = next;
      if (uncertain) {
        uncertain = false;
        notify({ overflow: true });
      }
      if (changed.length) notify({ paths: changed });
    };
    const loop = (async () => {
      while (!closed) {
        await sleep(this.#watchIntervalMs);
        if (closed) break;
        await poll();
      }
    })();

    const watcher = {
      mode: "polling",
      close: async () => {
        closed = true;
        clearTimeout(timer);
        wake?.();
        this.#watchers.delete(watcher);
        await loop;
      },
    };
    this.#watchers.add(watcher);
    return ok(watcher);
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------

  async cleanup(context) {
    await Promise.all([...this.#watchers].map((w) => w.close(context)));
  }
}
