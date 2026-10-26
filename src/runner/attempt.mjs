// Shared pieces of the restart-safe "run one command on a Sprite through the runner" flow, used by the workspace service
// (clone, install) and by rebuild (clone on the new Sprite). One copy, because the exactly-once rules live here:
//
//   planned --prepare--> (markSent) --start--> sent --wait--> confirmed | failed | unknown
//
//  - `prepare` never overwrites an existing run directory, and `sent` is recorded BEFORE `start`, so a `planned` intent proves
//    `start` was never issued and may be started after a crash.
//  - A run whose runner state is claimed / lost / missing is "result unconfirmed": it is never started again. A retry opens a
//    new attempt (n + 1) instead.
//  - The log is followed from offset 0 until the command exits; transient read errors are retried a bounded number of times.
import { createHash } from "node:crypto";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** An error whose outcome is certain (nothing happened / it definitely failed). */
export const definite = (message) => Object.assign(new Error(message), { uncertain: false });
/** An error whose outcome is not known (the action may or may not have taken effect). */
export const uncertain = (message) => Object.assign(new Error(message), { uncertain: true });

const NETWORK_CODE_RE = /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR)/;
const NETWORK_MSG_RE = /fetch failed|network|timed? ?out|timeout|socket|ECONN|ETIMEDOUT|aborted|connection (?:ended|closed|reset|lost)|may or may not/i;

/** True when an error leaves the real outcome unknown (5xx, 408, network errors, "may or may not have run"). */
export function isUncertain(e) {
  if (e?.uncertain === true) return true;
  if (e?.uncertain === false) return false;
  const status = e?.statusCode ?? e?.status;
  if (typeof status === "number") return status >= 500 || status === 408;
  if (NETWORK_CODE_RE.test(String(e?.code ?? ""))) return true;
  return NETWORK_MSG_RE.test(String(e?.message ?? ""));
}

/**
 * A text sanitizer for anything stored or returned: strips NULs, the given secret values, credential-looking strings,
 * userinfo and query strings of URLs, and absolute server paths.
 * @param {string[]} [secrets]
 */
export function makeSanitizer(secrets = []) {
  const secretValues = secrets.filter((s) => typeof s === "string" && s.length >= 4);
  return function sanitize(text, max = 600) {
    let t = String(text ?? "").replace(/\u0000/g, "");
    for (const s of secretValues) t = t.split(s).join("***");
    t = t
      .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "***")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "***")
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "***")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
      .replace(/(\bhttps?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1***@")
      .replace(/(\b(?:https?|wss?):\/\/[^\s)?]*)\?[^\s)]*/gi, "$1")
      .replace(/(?:\/Users|\/private\/var|\/var\/folders)\/[^\s'"):]+/g, "<path>");
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
}

/** Shell script for the `code` step: clone (if absent) and check out the work branch at `commit`. Idempotent: never re-clones an existing repository, never resets a branch. */
export function codeScript({ url, dir, branch, commit }) {
  return [
    "set -eu",
    `REPO_URL=${sq(url)}`,
    `DIR=${sq(dir)}`,
    `BRANCH=${sq(branch)}`,
    `COMMIT=${sq(commit)}`,
    'mkdir -p "$(dirname "$DIR")"',
    'if [ -d "$DIR/.git" ]; then',
    '  echo "repository already present, not cloning again"',
    'elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then',
    '  echo "$DIR exists and is not a git repository; refusing to touch it" >&2',
    "  exit 3",
    "else",
    '  git clone "$REPO_URL" "$DIR"',
    "fi",
    'cd "$DIR"',
    "git fetch origin",
    'git cat-file -e "$COMMIT^{commit}" 2>/dev/null || git fetch origin "$COMMIT"',
    "CUR=$(git symbolic-ref --short -q HEAD || true)",
    'if [ "$CUR" = "$BRANCH" ]; then',
    '  echo "already on $BRANCH, leaving it as is"',
    'elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then',
    '  git checkout "$BRANCH"',
    "else",
    '  git checkout -B "$BRANCH" "$COMMIT"',
    "fi",
    "git rev-parse HEAD",
  ].join("\n");
}

/**
 * One runner client per runtime. `runnerFor` (injected) wins; otherwise a client is built over `provider.bash(runtimeId)`
 * (loaded lazily) and cached. `forget(runtimeId)` drops a client whose runtime is no longer bound, so the process does not
 * keep a bash closure and decoder state for every Sprite it has ever seen.
 * @param {{ runnerFor?: (runtimeId: string) => any, createClient?: (o: {bash: Function}) => any }} [opts]
 */
export function createRunnerCache({ runnerFor, createClient } = {}) {
  const cache = new Map();
  return {
    /** Synchronous: callers that cannot await (the Exec resolver) use this one. Needs `createClient` or `runnerFor`. */
    getSync(runtimeId, provider) {
      if (runnerFor) return runnerFor(runtimeId);
      let r = cache.get(runtimeId);
      if (!r) {
        if (!createClient) throw new Error("createRunnerCache: no createClient; use get()");
        r = createClient({ bash: provider.bash(runtimeId) });
        cache.set(runtimeId, r);
      }
      return r;
    },
    async get(runtimeId, provider) {
      if (runnerFor || createClient) return this.getSync(runtimeId, provider);
      let r = cache.get(runtimeId);
      if (!r) {
        const { createRunnerClient } = await import("./client.mjs");
        r = createRunnerClient({ bash: provider.bash(runtimeId) });
        cache.set(runtimeId, r);
      }
      return r;
    },
    forget: (runtimeId) => cache.delete(runtimeId),
    get size() {
      return cache.size;
    },
  };
}

/**
 * Run `command` as a restart-safe attempt. Resolves on exit code 0 (`{reused, tail}`); throws definite(...) for a non-zero
 * exit and uncertain(...) when the outcome cannot be confirmed.
 *
 * @param {object} deps
 * @param {any} deps.store control store (intents)
 * @param {any} deps.runner runner client (prepare / start / status / wait)
 * @param {(text: string, max?: number) => string} deps.sanitize
 * @param {() => number} deps.now
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {number} deps.stepTimeoutMs
 * @param {number} deps.waitSeconds
 * @param {number} deps.waitRetries
 * @param {number} deps.retryDelayMs
 * @param {object} args
 * @param {string} args.workspaceId
 * @param {string} args.keyPrefix attempt request ids are `${keyPrefix}:${hash}:${n}`
 * @param {string} args.kind intent kind
 * @param {string} args.cwd
 * @param {string} args.command
 */
export async function runAttempt(deps, { workspaceId, keyPrefix, kind, cwd, command }) {
  const { store, runner, sanitize, now, sleep, stepTimeoutMs, waitSeconds, waitRetries, retryDelayMs } = deps;
  const hash = sha256(`${cwd}\n${command}`).slice(0, 10);

  // pick the attempt: skip settled failures, return early on a confirmed one
  let n = 0;
  let rid;
  let intent;
  for (;; n++) {
    rid = `${keyPrefix}:${hash}:${n}`;
    intent = store.intents.begin({ requestId: rid, kind, target: `wsr-${sha256(rid).slice(0, 24)}`, workspaceId }).intent;
    if (intent.state === "confirmed") return { reused: true };
    if (intent.state === "failed" || intent.state === "unknown") continue;
    break; // planned or sent: this is the live attempt
  }
  const id = intent.target;

  const settleUnknown = (msg) => {
    store.intents.settle(rid, { state: "unknown", evidence: { reason: sanitize(msg, 300) } });
    return uncertain(msg);
  };

  if (intent.state === "planned") {
    // prepare is idempotent (never overwrites an existing run directory); `sent` is recorded BEFORE start, so a
    // `planned` intent proves start was never issued.
    await runner.prepare({ id, cwd, command });
    store.intents.markSent(rid);
    try {
      await runner.start(id);
    } catch (e) {
      let st;
      try {
        st = (await runner.status(id))?.state;
      } catch {
        // cannot even ask: leave the intent `sent`; a retry reattaches or reports it
        throw e;
      }
      if (st === "running" || st === "exited") {
        // the start did take effect despite the error
      } else if (st === "claimed" || st === "lost" || st === "missing") {
        throw settleUnknown(`命令是否已启动无法确认（runner 状态 ${st}）：${e?.message ?? e}`);
      } else {
        throw e;
      }
    }
  } else {
    const st = (await runner.status(id))?.state;
    if (st !== "running" && st !== "exited") {
      throw settleUnknown(`上次启动的命令状态为 ${st ?? "未知"}，无法确认是否已执行，请重试`);
    }
  }

  // follow the log from offset 0 until the command exits
  let from = 0;
  let tail = "";
  let failures = 0;
  const deadline = now() + stepTimeoutMs;
  let exit;
  for (;;) {
    let r;
    try {
      r = await runner.wait({ id, from, maxSeconds: waitSeconds });
      failures = 0;
    } catch (e) {
      if (!isUncertain(e) || ++failures > waitRetries) throw e;
      await sleep(retryDelayMs * failures);
      continue;
    }
    const raw = r?.text ?? r?.data ?? r?.output;
    const data = raw === undefined || raw === null ? "" : String(raw);
    if (data) tail = (tail + data).slice(-4000);
    from = typeof r?.offset === "number" ? r.offset : from + Buffer.byteLength(data);
    if (r?.state === "exited") {
      exit = r.exit ?? r.exitCode;
      break;
    }
    if (r?.state === "running") {
      if (now() > deadline) {
        // leave the intent `sent`: a retry reattaches to the same run instead of starting a second one
        throw uncertain(`命令仍在运行，已等待 ${Math.round(stepTimeoutMs / 1000)} 秒`);
      }
      continue;
    }
    throw settleUnknown(`命令状态为 ${r?.state ?? "未知"}，无法确认是否已执行，请重试`);
  }
  if (exit === 0) {
    store.intents.settle(rid, { state: "confirmed", evidence: { exit: 0 } });
    return { reused: false, tail };
  }
  store.intents.settle(rid, { state: "failed", evidence: { exit: exit ?? null } });
  throw definite(`命令退出码 ${exit ?? "未知"}：${sanitize(tail.trim().slice(-500))}`);
}
