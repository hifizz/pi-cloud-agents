// User-defined environment variables (ENV-DEMO): workspace defaults + per-session overrides, encrypted at rest
// in the control db, injected consistently into the Agent bash tool, the command console and the interactive PTY.
//
// What this module owns:
//  - Master key: TARSBOT_ENV_KEY (env / Fly secret only, like every other secret). Derivation is
//    scrypt(key, "pi-cloud-agents env-vars v1", 32); storage is AES-256-GCM, versioned ciphertext `v1:<iv>:<tag>:<ct>`.
//    A MISSING key does NOT fall back to plaintext: the service reports enabled=false, writes are rejected with a
//    clear config error, and effectiveEnv() throws 'disabled' WHEN any vars/overrides are already stored — a
//    session with stored config must never run commands silently unconfigured. With NO stored config it still
//    returns an empty effective env so nothing regresses on a keyless server.
//  - Reserved-name policy (assertEnvName): variables that steer the control server, the runner protocol, dynamic
//    loaders or that hold system credentials are refused with a 400-style error. The user-visible message names the
//    variable and the rule; it never echoes a value.
//  - Effective env resolution (effectiveEnv): workspace defaults, then the session's own overrides —
//    mode "set" replaces (an EMPTY STRING is a real value), mode "disabled" unsets (it is NOT the empty string).
//    The result is {set, unset}: `unset` names must be removed from the child env, so a disabled variable never
//    leaks a value it would otherwise inherit from the sprite/process environment.
//    A session override exists only for its own conversation id: read-only forks and delegation children are new
//    conversation ids and never copy a parent's overrides (they inherit the workspace defaults themselves).
//    Restricted sessions (loop runs, readOnly) get NO user variables at all — callers check isRestricted() and pass
//    their own capability env instead.
//
// Nothing here logs or returns a plaintext value: list APIs expose name / mode / masked only.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const KEY_INFO = "pi-cloud-agents env-vars v1";
const CT_VERSION = "v1";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAME_CHARS = 128;
const MAX_VALUE_BYTES = 8 * 1024;
const MAX_VARS_PER_SCOPE = 100;
const MAX_SCOPE_BYTES = 32 * 1024; // two scopes merge to at most 64 KiB before shell quoting

/**
 * Reserved names: control server / runner protocol / credential carriers / loader hooks. Prefix rules cover whole
 * families (TARSBOT_*, PCA_*, LD_*, DYLD_*); exact names cover the usual credential and shell knobs. An explicit
 * session value CAN still strip GH_TOKEN for loop sessions — that path bypasses this list because it is a
 * capability rule, not a user variable.
 */
const RESERVED_EXACT = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "BASH_ENV",
  "ENV",
  "ENVIRONMENT",
  "CDPATH",
  "GLOBIGNORE",
  "UID",
  "EUID",
  "PPID",
  "SHELLOPTS",
  "BASHOPTS",
  "PROMPT_COMMAND",
  "PS0",
  "PS1",
  "PS2",
  "PS4",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONINSPECT",
  "PERL5OPT",
  "RUBYOPT",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_EXEC_PATH",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "SPRITES_TOKEN",
  "FLY_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
]);
// Prefix families are refused whole; dangerous NODE_* knobs are refused by exact name (NODE_ENV etc. stay usable).
const RESERVED_PREFIX = ["TARSBOT_", "PCA_", "LD_", "DYLD_", "TOKEN_ROUTER_", "EXA_", "GOOGLE_", "SPRITES_", "FLY_", "BASH_FUNC_", "GIT_"];

export class EnvConfigError extends Error {
  /** @param {"invalid"|"not_found"|"disabled"|"conflict"} code */
  constructor(code, message) {
    super(message);
    this.name = "EnvConfigError";
    this.code = code;
  }
}

const fail = (code, message) => new EnvConfigError(code, message);

/** Validate a user variable name; throws EnvConfigError("invalid"). Returns the name unchanged. */
export function assertEnvName(name) {
  if (typeof name !== "string" || !ENV_NAME_RE.test(name) || name.length > MAX_NAME_CHARS) {
    throw fail("invalid", `环境变量名不合法：${String(name).slice(0, 64)}（须为 [A-Za-z_][A-Za-z0-9_]*，<= ${MAX_NAME_CHARS} 字符）`);
  }
  if (RESERVED_EXACT.has(name)) {
    throw fail("invalid", `变量 ${name} 是保留名（控制环境/凭据/加载器钩子），不可由用户配置`);
  }
  for (const p of RESERVED_PREFIX) {
    if (name.startsWith(p)) throw fail("invalid", `变量 ${name} 命中保留前缀 ${p}*，不可由用户配置`);
  }
  return name;
}

function assertValue(value) {
  if (typeof value !== "string") throw fail("invalid", "value 必须是字符串（空字符串是有效值；禁用请用 mode=disabled）");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw fail("invalid", `value 过大（最大 ${MAX_VALUE_BYTES} 字节）`);
  if (value.includes("\0")) throw fail("invalid", "value 不能包含 NUL 字符");
  return value;
}

/**
 * @param {object} deps
 * @param {any} deps.store control store (envVars / sessionEnv / links / workspaces)
 * @param {string|undefined} [deps.masterKey] TARSBOT_ENV_KEY; undefined/empty = feature disabled (no plaintext fallback)
 * @param {Record<string,string|undefined>} [deps.env] read TARSBOT_ENV_KEY from here instead (tests)
 */
export function createEnvConfigService({ store, masterKey, env } = {}) {
  if (!store) throw new TypeError("createEnvConfigService requires a store");
  const raw = masterKey !== undefined ? masterKey : env?.TARSBOT_ENV_KEY ?? process.env.TARSBOT_ENV_KEY;
  const enabled = typeof raw === "string" && raw.length >= 16;
  const key = enabled ? scryptSync(raw, KEY_INFO, 32) : undefined;

  function encrypt(plain) {
    if (!key) throw fail("disabled", "用户环境变量功能未启用：缺少 TARSBOT_ENV_KEY（>=16 字符），拒绝以明文保存");
    const iv = randomBytes(12);
    const ct = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([ct.update(plain, "utf8"), ct.final()]);
    return `${CT_VERSION}:${iv.toString("base64url")}:${ct.getAuthTag().toString("base64url")}:${data.toString("base64url")}`;
  }

  function decrypt(blob) {
    if (!key) throw fail("disabled", "用户环境变量功能未启用：缺少 TARSBOT_ENV_KEY");
    // Ciphertext layout `v1:<iv>:<tag>:<data>`; each part is base64url, which has no ':' so exactly 4 parts.
    const parts = String(blob).split(":");
    if (parts.length !== 4) throw fail("invalid", "存储的环境变量值格式无法识别");
    const [v, ivB, tagB, dataB] = parts;
    if (v !== CT_VERSION || !ivB || !tagB || dataB === undefined) throw fail("invalid", "存储的环境变量值格式无法识别");
    const dc = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
    dc.setAuthTag(Buffer.from(tagB, "base64url"));
    try {
      return Buffer.concat([dc.update(Buffer.from(dataB, "base64url")), dc.final()]).toString("utf8");
    } catch {
      throw fail("invalid", "环境变量值解密失败（主密钥不匹配或数据损坏）");
    }
  }

  const assertEnabled = () => {
    if (!enabled) throw fail("disabled", "用户环境变量功能未启用：缺少 TARSBOT_ENV_KEY（>=16 字符），不会以明文保存");
  };

  const workspaceOr404 = (workspaceId) => {
    const ws = store.workspaces.get(workspaceId);
    if (!ws) throw fail("not_found", `工作区不存在：${workspaceId}`);
    return ws;
  };

  /** The bot's linked workspace id (session-scoped writes go through here; a cross-workspace botId is a 409). */
  function sessionWorkspace({ workspaceId, bot }) {
    const link = store.links.workspaceOf(String(bot.conversationId));
    if (!link) throw fail("conflict", `会话 ${bot.id} 没有关联工作区`);
    if (link.id !== workspaceId) throw fail("conflict", `会话 ${bot.id} 不属于工作区 ${workspaceId}`);
    return link;
  }

  /** Read-only forks and loop-run sessions never carry user variables (capability boundary). */
  const isRestricted = (bot) => Boolean(bot?.readOnly || bot?.loopRun?.runId);

  // ---- workspace defaults ----------------------------------------------------------------------------------------------

  function listWorkspace(workspaceId) {
    workspaceOr404(workspaceId);
    return {
      enabled,
      vars: store.envVars.list(workspaceId).map((r) => ({ name: r.name, masked: true, updatedAt: r.updatedAt })),
    };
  }

  function setWorkspaceVar(workspaceId, name, value) {
    assertEnabled();
    assertEnvName(name);
    assertValue(value);
    if (!store.envVars.get(workspaceId, name) && store.envVars.list(workspaceId).length >= MAX_VARS_PER_SCOPE) {
      throw fail("invalid", `每个工作区最多 ${MAX_VARS_PER_SCOPE} 个变量`);
    }
    assertScopeBudget(store.envVars.list(workspaceId), name, value);
    return store.envVars.set(workspaceId, name, encrypt(value));
  }

  function removeWorkspaceVar(workspaceId, name) {
    assertEnvName(name);
    if (!store.envVars.remove(workspaceId, name)) throw fail("not_found", `变量不存在：${name}`);
  }

  // ---- session overrides ----------------------------------------------------------------------------------------------

  function listSession({ workspaceId, bot }) {
    workspaceOr404(workspaceId);
    sessionWorkspace({ workspaceId, bot });
    const conversationId = String(bot.conversationId);
    const defaults = new Set(store.envVars.list(workspaceId).map((r) => r.name));
    const overrides = store.sessionEnv.list(conversationId).map((r) => ({
      name: r.name,
      mode: r.mode,
      masked: r.mode === "set",
      inherits: false,
      updatedAt: r.updatedAt,
    }));
    const overridden = new Set(overrides.map((o) => o.name));
    const inherited = [...defaults].filter((n) => !overridden.has(n)).map((n) => ({ name: n, mode: "inherit", masked: true, inherits: true }));
    return {
      enabled,
      restricted: isRestricted(bot),
      entries: [...overrides, ...inherited].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /**
   * One session override. mode "set" needs a value string ("" is a real value); mode "disabled" unsets the
   * inherited name for this session only; mode "inherit" removes the override row (back to the workspace default).
   */
  function setSessionVar({ workspaceId, bot, name, mode, value }) {
    assertEnabled();
    assertEnvName(name);
    if (isRestricted(bot)) throw fail("conflict", "受限 Session（loop run / 只读 fork）不能配置环境变量");
    sessionWorkspace({ workspaceId, bot });
    const conversationId = String(bot.conversationId);
    if (mode === "inherit") {
      store.sessionEnv.remove(conversationId, name);
      return { name, mode: "inherit" };
    }
    if (mode === "disabled") {
      assertSessionCap(conversationId, name);
      assertScopeBudget(store.sessionEnv.list(conversationId), name, "");
      return { name, ...store.sessionEnv.set(conversationId, name, { mode: "disabled" }), masked: false };
    }
    if (mode !== "set") throw fail("invalid", "mode 必须是 set | disabled | inherit");
    assertValue(value);
    assertSessionCap(conversationId, name);
    assertScopeBudget(store.sessionEnv.list(conversationId), name, value);
    const row = store.sessionEnv.set(conversationId, name, { mode: "set", value: encrypt(value) });
    return { name, ...row, masked: true };
  }

  function assertScopeBudget(rows, name, value) {
    let bytes = Buffer.byteLength(name) + Buffer.byteLength(value) + 2;
    for (const r of rows) {
      if (r.name !== name) bytes += Buffer.byteLength(r.name) + Buffer.byteLength(r.mode === "disabled" ? "" : decrypt(r.value)) + 2;
    }
    if (bytes > MAX_SCOPE_BYTES) throw fail("invalid", "每个工作区 / Session 的变量名和值合计最多 32 KiB（合并最多 64 KiB）");
  }

  /** Count rows once: every override (set or disabled) counts against the per-session cap. */
  const assertSessionCap = (conversationId, name) => {
    const rows = store.sessionEnv.list(conversationId);
    if (!rows.some((r) => r.name === name) && rows.length >= MAX_VARS_PER_SCOPE) {
      throw fail("invalid", `每个 Session 最多 ${MAX_VARS_PER_SCOPE} 个覆盖`);
    }
  };

  /** True when the workspace/session stores any rows (used so a missing key with existing config fails loudly). */
  const hasConfig = (workspaceId, conversationId) =>
    store.envVars.list(workspaceId).length > 0 ||
    (conversationId !== undefined && conversationId !== null && store.sessionEnv.list(String(conversationId)).length > 0);

  /**
   * The effective env for one execution context.
   * @param {{workspaceId: string, conversationId?: string}} target
   * @returns {{set: Record<string,string>, unset: string[]}}
   *   `set` = plaintext name -> value (injected as real variables); `unset` = names that must NOT exist in the
   *   child process even when its parent environment carries them (a disabled override is a true unset, not
   *   an empty string). Plaintext never leaves this process — callers pass it to the runner start env or the
   *   PTY stdin bootstrap, never to logs, files, argv or the wire protocol.
   *   Throws when config exists but cannot be decrypted (missing/mismatched TARSBOT_ENV_KEY) — a command that
   *   depends on user config must fail loudly instead of silently running unconfigured. With no stored config
   *   the disabled service returns {set:{},unset:[]} so deployments without the feature keep working.
   */
  function effectiveEnv({ workspaceId, conversationId } = {}) {
    const empty = { set: {}, unset: [] };
    if (!enabled) {
      if (hasConfig(workspaceId, conversationId)) {
        throw fail("disabled", "控制库中已有加密的环境变量，但缺少可用的 TARSBOT_ENV_KEY：拒绝静默以未配置状态执行命令");
      }
      return empty;
    }
    const set = {};
    for (const r of store.envVars.list(workspaceId)) {
      set[r.name] = decrypt(r.value);
    }
    const unset = [];
    if (conversationId !== undefined && conversationId !== null) {
      for (const r of store.sessionEnv.list(String(conversationId))) {
        if (r.mode === "disabled") {
          delete set[r.name];
          unset.push(r.name);
        } else {
          set[r.name] = decrypt(r.value);
        }
      }
    }
    return { set, unset };
  }

  return {
    enabled,
    isRestricted,
    assertEnvName,
    listWorkspace,
    setWorkspaceVar,
    removeWorkspaceVar,
    listSession,
    setSessionVar,
    effectiveEnv,
  };
}
