// Human approval for dangerous tool calls (spec F10, REQ-F10-*).
//
// A `beforeTool` hook on the built-in tool task inspects every call. Safe calls pass through untouched. A dangerous call
// parks in the in-process approval center until a human resolves it (HTTP: POST /api/approvals/:taskId). The verdict is
// written to the task's durable memo "approval" (first write wins), so after a restart an already answered question is
// never asked again, while an unanswered one re-enters the hook and shows up in the list again.
import { EventEmitter } from "node:events";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

/** Longest string value kept in a listed approval's `args` (display only; the hook keeps the real arguments). */
const PREVIEW_CHARS = 2000;

// ---- rules ----------------------------------------------------------------------------------------------------------

// Git / GitHub policy: pushing your own branch and opening a PR is allowed without asking; anything that can destroy an
// existing PR or existing code needs a human. Applies to every sandbox mode (cua and sprites alike).
//
// Known limits (documented on purpose):
//  - A bare `git push` (no refspec) cannot be judged: its upstream may be `dev` or `main`. The test repository has no
//    branch protection, so there is no server-side backstop; we rely on the preamble telling the bot to push only
//    `tarsbot/*` branches.
//  - Rules are regexes over the command text. Quoted separators (`;`, `&`, `|` inside quotes) and indirection
//    (variables, `bash -c`, aliases) are not understood.
//
// Chained commands: every push rule only looks at the push segment, i.e. the text after `git ... push` up to the next
// `;`, `&`, `|` or newline, so `git push origin b && git checkout main` does not trip the baseline-branch rule.

/** `git [-C dir] [-c k=v] ... push` — global options before the subcommand are skipped; `git log --grep push` is not a push. */
const GIT_PUSH = String.raw`\bgit\s+(?:-\S+\s+(?:(?!push\b)[^-\s]\S*\s+)?)*push(?=\s|$)`;
/** Zero or more arguments of the same shell segment, then whitespace, ready for one token to follow. */
const SEG = String.raw`[^\n;|&]*?\s`;
const END = String.raw`(?=\s|$|[;&|])`;
const gitPush = (token, flags) => new RegExp(`${GIT_PUSH}${SEG}${token}${END}`, flags);

/** A refspec token whose destination is main / master / dev (`main`, `HEAD:dev`, `x:refs/heads/master`, quoted). */
const BASELINE = String.raw`['"]?(?:[^\s:'"]*:)?(?:refs/heads/)?(?:main|master|dev)['"]?`;

/** `gh api` arguments in the same segment. */
const GH_API = String.raw`\bgh\s+api\b[^\n;|&]*?`;

/** Shell patterns that need approval. `pattern` is tested against the whole `command` string. */
export const DEFAULT_BASH_RULES = [
  { pattern: /\brm\s+(?:\S+\s+)*?-[a-zA-Z]*(?:rf|fr|Rf|fR)[a-zA-Z]*(?=\s|$)/, reason: "recursive force delete (rm -rf)" },
  { pattern: /\brm\b[^\n;|&]*\s-[a-zA-Z]*[rR][a-zA-Z]*(?=\s)[^\n;|&]*\s-[a-zA-Z]*f/, reason: "recursive force delete (rm -r -f)" },
  { pattern: /\brm\b[^\n;|&]*\s-[a-zA-Z]*f[a-zA-Z]*(?=\s)[^\n;|&]*\s-[a-zA-Z]*[rR]/, reason: "recursive force delete (rm -f -r)" },
  { pattern: /\brm\b[^\n;|&]*--recursive[^\n;|&]*--force|\brm\b[^\n;|&]*--force[^\n;|&]*--recursive/, reason: "recursive force delete (rm --recursive --force)" },
  // git push: rewrite remote history
  {
    pattern: gitPush(String.raw`(?:--force(?:-with-lease|-if-includes)?(?:=\S*)?|-[a-zA-Z]*f[a-zA-Z]*)`),
    reason: "git push that rewrites remote history (--force / -f / --force-with-lease / --force-if-includes)",
  },
  { pattern: gitPush(String.raw`['"]?\+\S+`), reason: "git push with a +refspec (forced update of a remote ref)" },
  // git push: delete remote refs
  {
    pattern: gitPush(String.raw`(?:--delete|--mirror|--prune|-[a-zA-Z]*d[a-zA-Z]*)`),
    reason: "git push that deletes remote refs (--delete / -d / --mirror / --prune)",
  },
  { pattern: gitPush(String.raw`['"]?:\S+`), reason: "git push of an empty source (:<ref>) deletes a remote ref" },
  // git push: baseline branches
  { pattern: gitPush(BASELINE), reason: "git push directly to a baseline branch (main / master / dev)" },
  // gh: operations on existing PRs / repos / releases
  { pattern: /\bgh\s+pr\s+merge\b/, reason: "gh pr merge (merges code into the base branch)" },
  { pattern: /\bgh\s+pr\s+close\b/, reason: "gh pr close (closes an existing PR)" },
  { pattern: /\bgh\s+repo\s+delete\b/, reason: "gh repo delete (deletes a repository)" },
  { pattern: /\bgh\s+repo\s+edit\b/, reason: "gh repo edit (changes repository settings)" },
  { pattern: /\bgh\s+release\s+delete\b/, reason: "gh release delete (deletes a release)" },
  {
    pattern: new RegExp(String.raw`${GH_API}\s(?:-X|--method)[\s=]*['"]?(?:POST|PUT|PATCH|DELETE)\b`, "i"),
    reason: "gh api write request (-X/--method POST, PUT, PATCH or DELETE)",
  },
  {
    pattern: new RegExp(String.raw`${GH_API}\s(?:-[fF]|(?:--field|--raw-field|--input)(?![a-zA-Z-]))`),
    reason: "gh api with request fields (-f/-F/--field/--raw-field/--input sends a POST by default)",
  },
  {
    pattern:
      /\b(?:curl|wget)\b[^\n;|&]*(?:(?:-X|--request)[\s=]*['"]?(?:POST|PUT|DELETE|PATCH)\b|--method[\s=]+['"]?(?:POST|PUT|DELETE|PATCH)\b|--data\S*|--post-data|--post-file|\s-d\b)/i,
    reason: "outbound HTTP request that changes remote state (curl/wget POST/PUT/DELETE/--data)",
  },
  { pattern: /\bmkfs(?:\.\w+)?\b/, reason: "filesystem creation (mkfs)" },
  { pattern: /\bdd\b[^\n;|&]*\bof=/, reason: "raw write with dd of=" },
  { pattern: /\b(?:shutdown|reboot|poweroff)\b/, reason: "shutdown or reboot" },
  { pattern: />\s*\/dev\/(?:sd|hd|vd|nvme)\w*/, reason: "write to a raw block device" },
];

/** Tool names that need approval regardless of arguments. Strings may contain `*` wildcards. */
export const DEFAULT_TOOL_NAMES = ["send_*", "deploy*", "git_push"];

export const DEFAULT_RULES = { bash: DEFAULT_BASH_RULES, toolNames: DEFAULT_TOOL_NAMES };

function nameMatcher(entry) {
  if (entry instanceof RegExp) return (name) => entry.test(name);
  const re = new RegExp(`^${String(entry).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return (name) => re.test(name);
}

/**
 * Build a danger classifier.
 * @param {{ bash?: Array<{pattern: RegExp, reason: string}>, toolNames?: Array<string|RegExp>, bashTools?: string[] }} [rules]
 *   Omitted keys fall back to the defaults. `bashTools` lists tools whose `command` argument is checked (default ["bash"]).
 * @returns {(call: {name: string, arguments?: any}) => string | undefined} the reason, or undefined for a safe call
 */
export function createClassifier(rules = {}) {
  const bash = rules.bash ?? DEFAULT_BASH_RULES;
  const names = (rules.toolNames ?? DEFAULT_TOOL_NAMES).map((e) => ({ match: nameMatcher(e) }));
  const bashTools = new Set(rules.bashTools ?? ["bash"]);
  return (call) => {
    const name = String(call?.name ?? "");
    if (bashTools.has(name)) {
      const command = call?.arguments?.command;
      if (typeof command === "string") {
        for (const rule of bash) if (rule.pattern.test(command)) return rule.reason;
      }
    }
    for (const n of names) if (n.match(name)) return `tool ${name} has external side effects`;
    return undefined;
  };
}

const defaultClassifier = createClassifier();

/** Reason a tool call needs approval under the default rules, or undefined when it is safe. */
export function isDangerous(call) {
  return defaultClassifier(call);
}

// ---- approval center ------------------------------------------------------------------------------------------------

function preview(value) {
  if (typeof value === "string") return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value;
  if (Array.isArray(value)) return value.map(preview);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, preview(v)]));
  return value;
}

/** In-process queue of calls waiting for a human verdict. Emits "changed" whenever the list changes. */
export class ApprovalCenter extends EventEmitter {
  #pending = new Map();

  /**
   * Park a call until it is resolved. Same `taskId` while pending returns the same promise.
   * `signal` aborts the wait: the item is removed and the promise rejects.
   * @returns {Promise<boolean>}
   */
  request({ taskId, conversationId, toolName, args, reason, signal }) {
    const key = String(taskId);
    const existing = this.#pending.get(key);
    if (existing) return existing.promise;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    let settle;
    let fail;
    const promise = new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const item = {
      taskId: key,
      conversationId: conversationId === undefined ? undefined : String(conversationId),
      toolName,
      args,
      reason,
      requestedAt: new Date().toISOString(),
    };
    const entry = { item, promise, settle, fail, cleanup: () => {} };
    if (signal) {
      const onAbort = () => {
        if (this.#pending.get(key) !== entry) return;
        this.#pending.delete(key);
        fail(abortError(signal));
        this.emit("changed");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.cleanup = () => signal.removeEventListener("abort", onAbort);
    }
    this.#pending.set(key, entry);
    this.emit("changed");
    return promise;
  }

  /** Pending items, oldest first. Long string arguments are shortened for display. */
  list() {
    return [...this.#pending.values()].map(({ item }) => ({ ...item, args: preview(item.args) }));
  }

  /** @returns {boolean} false when no such pending item exists */
  resolve(taskId, approved) {
    const key = String(taskId);
    const entry = this.#pending.get(key);
    if (!entry) return false;
    this.#pending.delete(key);
    entry.cleanup();
    entry.settle(approved === true);
    this.emit("changed");
    return true;
  }
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const e = new Error("approval wait aborted");
  e.name = "AbortError";
  return e;
}

/** Process-wide approval center used by the production extension and the HTTP routes. */
export const approvals = new ApprovalCenter();

// ---- extension ------------------------------------------------------------------------------------------------------

/**
 * @param {{ center?: ApprovalCenter, rules?: Parameters<typeof createClassifier>[0] }} [opts]
 */
export function createApproval({ center = approvals, rules } = {}) {
  const classify = rules ? createClassifier(rules) : isDangerous;
  return defineExtension({
    name: "tarsbot.approval",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const reason = classify(call);
          if (reason === undefined) return undefined;
          // The memo survives restarts: a verdict given before a crash is reused and the human is not asked twice.
          let ok = await api.memo("approval", context);
          if (ok === undefined) {
            // Aborting the wait (conversation abort, harness close) rejects here; the tool task rethrows while it is
            // aborting, so nothing is memoized and the question returns after recovery.
            const verdict = await center.request({
              taskId: api.taskId,
              conversationId: api.conversationId,
              toolName: call.name,
              args: call.arguments,
              reason,
              signal: context?.abortSignal,
            });
            // First write wins (REQ-F10-2): a concurrent earlier verdict is returned instead of ours.
            ok = await api.memo("approval", verdict, context);
          }
          if (ok === false) return { block: `User denied: ${reason}` };
          return undefined;
        },
      }),
    ],
  });
}

export const Approval = createApproval();
