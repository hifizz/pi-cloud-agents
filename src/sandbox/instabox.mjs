// InstaBox shell primitive: `bash(command, {timeoutMs}) -> {stdout, stderr, exitCode, timedOut}`.
//
// One long-lived sandbox is shared by every Bot. On first use we find it by metadata {app, name}, connect (which
// resumes a suspended/stopped machine), or create it from the configured template. InstaBox's persistent HOME is
// /data/home and its idle suspension transparently resumes on the next command.
//
// Important SDK behaviour (verified against @insforge/instabox-sdk 0.5.3 and the official SDK reference):
//  - commands.run returns stdout/stderr on exit 0 and throws CommandExitError for non-zero exit, including timeouts.
//  - timeoutMs is rounded up to seconds and must be <= 600,000 ms.
//  - command POSTs are deliberately not retried. We also never retry them here: after a transport error the command
//    may or may not have run, so repeating it could duplicate a side effect.
//  - each output stream is capped at 1 MiB. A truncated non-timeout result is rejected instead of being presented as
//    complete output.
//
// This module does not import config.mjs: production settings come directly from process.env and unit tests can import
// it without loading .env.

import { redactMessage } from "./sprites.mjs";

export { redactMessage };

const APP = "pi-cloud-agents";
const DEFAULT_NAME = "pi-cloud-agents";
const DEFAULT_TEMPLATE = "agent-browser";
const DEFAULT_HOME = "/data/home";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_AUTO_SUSPEND_MS = 600_000;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_EMAIL = "noreply@tarsbot.invalid";
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const MAX_ERROR_CHARS = 400;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const UNUSABLE_STATES = new Set(["deleting", "deleted", "error"]);
const REQUIRED_TOOLS = ["git", "gh", "node", "npm", "python3", "curl", "jq"];
const GIT_CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

function codedError(code, message) {
  // Do not retain the SDK error as `cause`: transport errors may contain the command, URL query or credentials.
  // `message` has already been reduced and redacted by msgOf() where SDK details are useful to the caller.
  const error = new Error(message);
  error.code = code;
  return error;
}

const isNotFound = (error) => error?.code === "not_found" || error?.status === 404;
const isCommandExit = (error, CommandExitError) =>
  (typeof CommandExitError === "function" && error instanceof CommandExitError) ||
  String(error?.name ?? error?.constructor?.name ?? "") === "CommandExitError";

function connectionOptions(apiKey, apiUrl) {
  return apiUrl ? { apiKey, apiUrl } : { apiKey };
}

function validateName(name) {
  if (typeof name !== "string" || !name || name.length > 63 || !NAME_RE.test(name)) {
    throw codedError("INSTABOX_CONFIG", "TARSBOT_INSTABOX_NAME must use 1-63 lowercase letters, digits or hyphens");
  }
}

function validateTimeout(timeoutMs, field = "timeoutMs") {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw codedError("INSTABOX_TIMEOUT_INVALID", `${field} must be greater than 0 and at most ${MAX_COMMAND_TIMEOUT_MS} ms`);
  }
}

function validateAutoSuspend(autoSuspendMs) {
  if (autoSuspendMs === undefined || autoSuspendMs === 0) return;
  if (!Number.isFinite(autoSuspendMs) || autoSuspendMs < 120_000 || autoSuspendMs > 86_400_000) {
    throw codedError("INSTABOX_CONFIG", "TARSBOT_INSTABOX_IDLE_MS must be 0 or between 120000 and 86400000 ms");
  }
}

const shQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function makeBootstrapCommand(home, gitEmail) {
  const workspace = `${home.replace(/\/+$/, "")}/workspace`;
  return `set -eu
mkdir -p -- ${shQuote(workspace)}
missing=""
for tool in ${REQUIRED_TOOLS.join(" ")}; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  printf 'InstaBox template is missing required tools:%s\\n' "$missing" >&2
  exit 127
fi
git config --global user.name TARSBot
git config --global user.email ${shQuote(gitEmail)}
git config --global credential.https://github.com.helper ${shQuote(GIT_CREDENTIAL_HELPER)}`;
}

/**
 * Find the reusable shared sandbox, connect to it (resuming when needed), and return it. Returns null when none exists.
 */
export async function findInstaboxSandbox({ Sandbox, apiKey, apiUrl, name = DEFAULT_NAME, autoSuspendMs = DEFAULT_AUTO_SUSPEND_MS } = {}) {
  if (!Sandbox || typeof Sandbox.list !== "function" || typeof Sandbox.connect !== "function") {
    throw new TypeError("findInstaboxSandbox requires a Sandbox class with list() and connect()");
  }
  validateName(name);
  validateAutoSuspend(autoSuspendMs);
  const auth = connectionOptions(apiKey, apiUrl);
  const listed = await Sandbox.list({ ...auth, metadata: { app: APP, name } });
  if (!Array.isArray(listed)) throw codedError("INSTABOX_INVALID_RESPONSE", "InstaBox list returned an invalid response");
  const candidates = listed.filter((item) => item?.sandboxId && !UNUSABLE_STATES.has(item.state));
  if (candidates.length > 1) {
    throw codedError(
      "INSTABOX_SANDBOX_AMBIGUOUS",
      `Found ${candidates.length} usable InstaBox sandboxes with metadata app=${APP}, name=${name}; refusing to choose between persistent disks`,
    );
  }
  if (candidates.length === 0) return null;

  const item = candidates[0];
  // `disableVault()` only guarantees removal on a later boot/resume/push. A machine that is already running may still
  // have old Vault environment variables in live processes, so it is not safe to repair in place before Agent code.
  if (item.vault !== false) {
    throw codedError(
      "INSTABOX_VAULT_UNSAFE",
      `InstaBox sandbox "${name}" has account Vault injection enabled; refusing to reuse it (create a vault:false sandbox)`,
    );
  }
  try {
    // Reconcile lifecycle before executing Agent code. The candidate is already proven to have Vault disabled.
    const target = await Sandbox.connect(item.sandboxId, { ...auth, resume: false });
    if (item.autoSuspendMs !== autoSuspendMs) {
      if (typeof target.setAutoSuspend !== "function") {
        throw codedError("INSTABOX_CONFIG", "The InstaBox SDK cannot apply TARSBOT_INSTABOX_IDLE_MS to the reusable sandbox");
      }
      await target.setAutoSuspend(autoSuspendMs);
    }
    if (typeof target.resume !== "function") throw codedError("INSTABOX_INVALID_RESPONSE", "InstaBox connect returned no resume() method");
    await target.resume();
    return target;
  } catch (error) {
    // It vanished between list and reconciliation. The caller may safely create a replacement.
    if (!isNotFound(error)) throw error;
  }
  return null;
}

/**
 * Build an InstaBox-backed bash primitive. Sandbox and CommandExitError are injectable so all behavior can be tested
 * offline without credentials or network access.
 */
export function createInstaboxBash({
  Sandbox,
  CommandExitError,
  apiKey,
  apiUrl,
  name = DEFAULT_NAME,
  template = DEFAULT_TEMPLATE,
  home = DEFAULT_HOME,
  autoSuspendMs = DEFAULT_AUTO_SUSPEND_MS,
  env = {},
  secrets = [],
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  bootstrap = true,
  bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  gitEmail = DEFAULT_GIT_EMAIL,
  log = () => {},
} = {}) {
  if (!Sandbox || typeof Sandbox.list !== "function" || typeof Sandbox.connect !== "function" || typeof Sandbox.create !== "function") {
    throw new TypeError("createInstaboxBash requires a Sandbox class with list(), connect() and create()");
  }
  if (typeof apiKey !== "string" || !apiKey) throw codedError("INSTABOX_CONFIG", "INSTABOX_API_KEY is not set (put it in .env)");
  if (typeof template !== "string" || !template) throw codedError("INSTABOX_CONFIG", "TARSBOT_INSTABOX_TEMPLATE must not be empty");
  if (typeof home !== "string" || !home.startsWith("/")) throw codedError("INSTABOX_CONFIG", "home must be an absolute path");
  if (typeof bootstrap !== "boolean") throw codedError("INSTABOX_CONFIG", "bootstrap must be a boolean");
  if (typeof gitEmail !== "string" || !gitEmail.trim()) throw codedError("INSTABOX_CONFIG", "TARSBOT_GIT_EMAIL must not be empty");
  validateName(name);
  validateTimeout(defaultTimeoutMs, "defaultTimeoutMs");
  validateTimeout(bootstrapTimeoutMs, "bootstrapTimeoutMs");
  validateAutoSuspend(autoSuspendMs);

  const auth = connectionOptions(apiKey, apiUrl);
  const envs = Object.keys(env).length ? { ...env } : undefined;
  const redactList = [apiKey, ...Object.values(env), ...secrets].filter((value) => typeof value === "string");
  const redact = (message) => redactMessage(message, redactList);
  const bootstrapCommand = makeBootstrapCommand(home, gitEmail);
  const msgOf = (error, command) => {
    let text = String(error?.message ?? error);
    if (typeof command === "string" && command.length >= 4) text = text.split(command).join("<command>");
    text = redact(text).replace(/\s+/g, " ").trim();
    const code = typeof error?.code === "string" && !text.includes(error.code) ? `${error.code}: ` : "";
    return `${code}${text}`.slice(0, MAX_ERROR_CHARS) || "unknown error";
  };

  let sandbox;
  let ensuring;
  let bootstrapped;
  let bootstrapping;
  let bootstrappingTarget;

  async function ensure() {
    if (sandbox) return sandbox;
    ensuring ??= (async () => {
      const found = await findInstaboxSandbox({ Sandbox, apiKey, apiUrl, name, autoSuspendMs });
      if (found) return found;
      const createOptions = {
        ...auth,
        name,
        metadata: { app: APP, name },
        autoSuspendMs,
        // The Agent can execute arbitrary code. Do not inject unrelated account Vault secrets into its machine.
        vault: false,
      };
      return Sandbox.create(template, createOptions);
    })();
    const pending = ensuring;
    try {
      const ready = await pending;
      sandbox ??= ready;
      return sandbox;
    } catch (error) {
      if (String(error?.code ?? "").startsWith("INSTABOX_")) throw error;
      throw codedError("INSTABOX_CONNECT_FAILED", `InstaBox sandbox could not be connected or created: ${msgOf(error)}`);
    } finally {
      if (ensuring === pending) ensuring = undefined;
    }
  }

  const note = (entry) => {
    try {
      log(entry);
    } catch {
      // logging must never break a command
    }
  };

  async function ensureBootstrap(target) {
    if (!bootstrap || bootstrapped === target) return;
    if (!bootstrapping || bootstrappingTarget !== target) {
      bootstrappingTarget = target;
      bootstrapping = (async () => {
        let result;
        try {
          result = await target.commands.run(bootstrapCommand, { cwd: home, envs, timeoutMs: bootstrapTimeoutMs });
        } catch (error) {
          if (isCommandExit(error, CommandExitError)) {
            result = error;
          } else {
            if (isNotFound(error) && sandbox === target) sandbox = undefined;
            throw codedError(
              "INSTABOX_BOOTSTRAP_FAILED",
              `InstaBox bootstrap connection failed; no user command was submitted: ${msgOf(error, bootstrapCommand)}`,
            );
          }
        }
        if (typeof result?.stdout !== "string" || typeof result?.stderr !== "string" || !Number.isInteger(result?.exitCode)) {
          throw codedError("INSTABOX_BOOTSTRAP_FAILED", "InstaBox bootstrap returned an invalid response; no user command was submitted");
        }
        if (result.timedOut) {
          throw codedError("INSTABOX_BOOTSTRAP_FAILED", `InstaBox bootstrap timed out after ${bootstrapTimeoutMs} ms; no user command was submitted`);
        }
        if (result.truncated) {
          throw codedError("INSTABOX_BOOTSTRAP_FAILED", "InstaBox bootstrap output was truncated; no user command was submitted");
        }
        if (result.exitCode !== 0) {
          const detail = result.stderr || result.stdout || result.error || `exit ${result.exitCode}`;
          throw codedError(
            "INSTABOX_BOOTSTRAP_FAILED",
            `InstaBox bootstrap failed (exit ${result.exitCode}); no user command was submitted: ${msgOf({ message: detail }, bootstrapCommand)}`,
          );
        }
      })();
    }
    const pending = bootstrapping;
    try {
      await pending;
      bootstrapped = target;
    } finally {
      if (bootstrapping === pending) {
        bootstrapping = undefined;
        bootstrappingTarget = undefined;
      }
    }
  }

  return async function instaboxBashRun(command, { timeoutMs } = {}) {
    if (typeof command !== "string") throw new TypeError("command must be a string");
    const budget = timeoutMs ?? defaultTimeoutMs;
    validateTimeout(budget);
    const began = Date.now();
    let target;
    try {
      target = await ensure();
      await ensureBootstrap(target);
    } catch (error) {
      note({ commandLength: command.length, ms: Date.now() - began, outcome: "error" });
      throw error;
    }

    let result;
    try {
      result = await target.commands.run(command, { cwd: home, envs, timeoutMs: budget });
    } catch (error) {
      if (isCommandExit(error, CommandExitError)) {
        result = error;
      } else {
        if (isNotFound(error) && sandbox === target) sandbox = undefined;
        note({ commandLength: command.length, ms: Date.now() - began, outcome: "error" });
        throw codedError(
          "INSTABOX_COMMAND_FAILED",
          `InstaBox command connection failed after submission; command may or may not have run: ${msgOf(error, command)}`,
        );
      }
    }

    if (typeof result?.stdout !== "string" || typeof result?.stderr !== "string" || !Number.isInteger(result?.exitCode)) {
      note({ commandLength: command.length, ms: Date.now() - began, outcome: "error" });
      throw codedError("INSTABOX_INVALID_RESPONSE", "InstaBox command returned an invalid response");
    }
    if (result.timedOut) {
      note({ commandLength: command.length, ms: Date.now() - began, outcome: "timeout" });
      return { stdout: result.stdout, stderr: result.stderr, timedOut: true };
    }
    if (result.truncated) {
      note({ commandLength: command.length, ms: Date.now() - began, exitCode: result.exitCode, outcome: "truncated" });
      throw codedError(
        "INSTABOX_OUTPUT_TRUNCATED",
        "InstaBox truncated command output at its 1 MiB per-stream limit; command ran but output is incomplete",
      );
    }

    note({ commandLength: command.length, ms: Date.now() - began, exitCode: result.exitCode, outcome: "ok" });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: false };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Production instance (lazy, one per process)

let prod;
let prodLoading;

async function getProd() {
  if (prod) return prod;
  prodLoading ??= (async () => {
    const apiKey = process.env.INSTABOX_API_KEY;
    if (!apiKey) throw codedError("INSTABOX_CONFIG", "INSTABOX_API_KEY is not set (put it in .env)");
    const { Sandbox, CommandExitError } = await import("@insforge/instabox-sdk");
    const gh = process.env.GITHUB_TOKEN;
    const idleRaw = process.env.TARSBOT_INSTABOX_IDLE_MS;
    const idle = idleRaw === undefined || idleRaw === "" ? DEFAULT_AUTO_SUSPEND_MS : Number(idleRaw);
    return createInstaboxBash({
      Sandbox,
      CommandExitError,
      apiKey,
      apiUrl: process.env.INSTABOX_API_URL || undefined,
      name: process.env.TARSBOT_INSTABOX_NAME || DEFAULT_NAME,
      template: process.env.TARSBOT_INSTABOX_TEMPLATE || DEFAULT_TEMPLATE,
      autoSuspendMs: idle,
      env: gh ? { GH_TOKEN: gh } : {},
      gitEmail: process.env.TARSBOT_GIT_EMAIL || DEFAULT_GIT_EMAIL,
      log: process.env.TARSBOT_INSTABOX_LOG ? (entry) => console.error(`[instabox] ${JSON.stringify(entry)}`) : undefined,
    });
  })();
  const pending = prodLoading;
  try {
    prod = await pending;
    return prod;
  } finally {
    if (prodLoading === pending) prodLoading = undefined;
  }
}

/** Run a shell command in the shared InstaBox sandbox. */
export async function instaboxBash(command, { timeoutMs } = {}) {
  return (await getProd())(command, { timeoutMs });
}

/** For /api/space: synchronous and never contains or requires an API key. */
export function getInstaboxInfo() {
  return { sandbox: "instabox", name: process.env.TARSBOT_INSTABOX_NAME || DEFAULT_NAME };
}

/** Provider interface from docs/CONTRACTS.md. */
export { instaboxBash as bash, getInstaboxInfo as info };
