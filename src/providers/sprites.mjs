// Sprites provider: one Sprite per workspace (docs/M1-PLAN.md §4.3). Takes an injected `client` (SpritesClient or a
// same-shaped fake). Safety rules (AGENTS.md "安全红线"):
//  - Only Sprites named `pca-…` that carry the label `app:pi-cloud-agents` are managed. `release` (the only delete
//    path) checks `isManaged` first; the legacy shared Sprite `pi-cloud-agents` is never managed.
//  - `ensure` creates only after a definite 404 from getSprite; any other error is rethrown (never create on doubt).
//  - Errors are redacted; logs carry only op / duration / outcome, never commands or tokens.
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { createSpritesBash, redactMessage } from "../sandbox/sprites.mjs";
import { initSprite } from "./sprites-init.mjs";

export const APP_LABEL = "app:pi-cloud-agents";
export const NAME_PREFIX = "pca-";
/** Never managed, regardless of any other rule. */
export const LEGACY_SPRITE_NAME = "pi-cloud-agents";

const status = (e) => e?.statusCode;

export function createSpritesProvider({
  client,
  ghToken,
  gitEmail,
  log = () => {},
  cpus = 4,
  ramMB = 4096,
  legacyNames = [process.env.TARSBOT_SPRITE_NAME],
} = {}) {
  if (!client || typeof client.getSprite !== "function") throw new TypeError("createSpritesProvider requires a Sprites client");
  const secrets = [ghToken].filter((s) => typeof s === "string" && s);
  const redact = (m) => redactMessage(m, secrets);
  const denied = new Set([LEGACY_SPRITE_NAME, ...legacyNames.filter(Boolean)]);

  /** Redacted copy of an error that keeps statusCode / errorCode / code. */
  const clean = (e) => {
    const out = new Error(redact(e?.message ?? e));
    if (e?.statusCode !== undefined) out.statusCode = e.statusCode;
    if (e?.errorCode !== undefined) out.errorCode = redact(e.errorCode);
    if (e?.code !== undefined) out.code = e.code;
    return out;
  };
  const note = (entry) => {
    try {
      log(entry);
    } catch {
      // logging never breaks a call
    }
  };
  const timed = async (op, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      note({ op, ms: Date.now() - t0, outcome: "ok" });
      return r;
    } catch (e) {
      note({ op, ms: Date.now() - t0, outcome: "error", statusCode: status(e) });
      throw clean(e);
    }
  };

  const runtimeName = (requestId) => {
    if (typeof requestId !== "string" || !requestId) throw new TypeError("requestId must be a non-empty string");
    return NAME_PREFIX + createHash("sha256").update(requestId).digest("hex").slice(0, 10);
  };

  /** `labels` undefined = not known (name-only check); otherwise the label must be present. */
  const isManaged = (name, labels) => {
    if (typeof name !== "string" || !name.startsWith(NAME_PREFIX) || denied.has(name)) return false;
    if (labels === undefined || labels === null) return true;
    return Array.isArray(labels) && labels.includes(APP_LABEL);
  };

  const assertOwned = (name, sprite) => {
    if (!isManaged(name, sprite?.labels ?? [])) {
      throw new Error(`Sprite ${name} exists but is not labelled ${APP_LABEL}; refusing to use it`);
    }
  };

  async function ensure({ requestId, workspaceId }) {
    const name = runtimeName(requestId);
    return timed("ensure", async () => {
      try {
        const s = await client.getSprite(name);
        assertOwned(name, s);
        return { runtimeId: name, created: false };
      } catch (e) {
        if (status(e) !== 404) throw e; // includes the label-mismatch error (no statusCode) and all network/5xx errors
      }
      let created = true;
      try {
        await client.createSprite(name, {
          config: { cpus, ramMB },
          labels: [APP_LABEL, `ws:${workspaceId}`],
          waitForCapacity: true,
        });
      } catch (e) {
        if (status(e) !== 409) throw e;
        created = false; // concurrent create / lost response: already exists
      }
      const s = await client.getSprite(name);
      assertOwned(name, s);
      return { runtimeId: name, created };
    });
  }

  const bashCache = new Map();
  function bash(runtimeId, opts) {
    if (typeof runtimeId !== "string" || !runtimeId) throw new TypeError("runtimeId required");
    let b = bashCache.get(runtimeId);
    if (!b) {
      b = createSpritesBash({
        client,
        name: runtimeId,
        env: ghToken ? { GH_TOKEN: ghToken } : {},
        secrets,
        log: (e) => note({ op: "bash", ...e }),
      });
      bashCache.set(runtimeId, b);
    }
    // Per-call env overlay (Issue14 Phase2): e.g. {GH_TOKEN: ""} strips the injected token for loop sessions.
    // The wrapper stays env-capable and merges the caller's own env over the overlay (overlay wins on conflict
    // only when the caller left the key unset — an explicit caller env value always passes through).
    const overlay = opts?.env;
    if (overlay && typeof overlay === "object" && Object.keys(overlay).length) {
      const wrapped = (command, o) =>
        b(command, { ...(o ?? {}), env: { ...overlay, ...(o?.env ?? {}) } });
      wrapped.supportsEnv = b.supportsEnv === true;
      return wrapped;
    }
    return b;
  }

  // SDK env is URL-encoded: application values travel only over stdin, after echo is disabled.
  const PTY_ENV_ALLOW = new Set(["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE"]);
  const PTY_MAX_COLS = 1000;
  const PTY_MAX_ROWS = 500;
  // Two 32 KiB scopes, worst-case shell quoting (4x), base64 (4/3x), and per-entry checks.
  const PTY_ENV_MAX_BYTES = 512 * 1024;
  const clampDim = (v, dflt, max) => (Number.isInteger(v) && v >= 2 ? Math.min(v, max) : dflt);
  const spriteCache = new Map();
  const spriteOf = (id) => {
    if (!spriteCache.has(id)) spriteCache.set(id, client.sprite(id));
    return spriteCache.get(id);
  };

  function ptyBootstrapPayload(env, unset) {
    const parts = [];
    for (const [k, v] of Object.entries(env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string" || v.includes("\0")) throw new TypeError("invalid session env entry");
      parts.push(`export ${k}='${v.replaceAll("'", "'\\''")}' || exit 125`);
    }
    for (const k of unset ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new TypeError("invalid session env name");
      parts.push(`unset ${k} || exit 125`);
    }
    if (!parts.length) return undefined;
    const payload = Buffer.from(parts.join("\n")).toString("base64") + "\n";
    if (payload.length > PTY_ENV_MAX_BYTES) throw new RangeError("session env payload exceeds the PTY bootstrap limit");
    return payload;
  }

  const HANDSHAKE_SH = `stty -echo -icanon min 1 time 0 < /dev/tty 2>/dev/null || exit 125
trap 'stty echo icanon < /dev/tty 2>/dev/null' EXIT
IFS= read -r -t 30 _pca_probe < /dev/tty || exit 124
[ "$_pca_probe" = PCA_ENV_1 ] || exit 125
printf PCA_READY_1
IFS= read -r -t 60 _pca_env_b64 < /dev/tty || exit 124
case "$_pca_env_b64" in *[!A-Za-z0-9+/=]* | "") exit 125;; esac
printf %s "$_pca_env_b64" | grep -Eq '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' || exit 125
_pca_env_script=$(printf %s "$_pca_env_b64" | base64 -d 2>/dev/null) || exit 125
eval "$_pca_env_script" 2>/dev/null || exit 125
unset _pca_probe _pca_env_b64 _pca_env_script
stty echo icanon < /dev/tty 2>/dev/null || exit 125
trap - EXIT
printf PCA_APPLIED_1
exec "\${SHELL:-/bin/bash}" -i`;

  async function spawnPty(sprite, { cwd, cols, rows, env, sessionEnv, sessionUnset }) {
    const redactCall = (m) => redactMessage(m, [...secrets, ...Object.values(sessionEnv ?? {})]);
    const payload = ptyBootstrapPayload(sessionEnv, sessionUnset);
    let cmd;
    try {
      cmd = sprite.spawn("/bin/bash", ["-c", payload ? HANDSHAKE_SH : 'exec "${SHELL:-/bin/bash}" -il'], {
        tty: true, cwd, cols, rows, ...(Object.keys(env).length ? { env } : {}),
      });
    } catch (e) {
      throw new Error(redactCall(e?.message ?? e));
    }
    const stdout = new PassThrough();
    const kill = () => {
      try { cmd.kill("SIGKILL"); } catch { /* already dead */ }
      try { cmd.close(); } catch { /* already closed */ }
    };
    let resolveExit;
    const exit = new Promise((resolve) => { resolveExit = resolve; });
    cmd.on("exit", (code) => resolveExit({ state: "exited", exit: Number.isInteger(code) && code >= 0 ? code : null }));
    cmd.on("error", (e) => resolveExit({ state: "error", exit: null, message: redactCall(e?.message ?? e) }));
    cmd.stdout.on("end", () => stdout.end());
    await new Promise((resolve, reject) => {
      let marker = payload ? "PCA_READY_1" : "";
      let pending = "";
      let complete = false;
      const timer = setTimeout(() => fail(new Error("PTY bootstrap timed out")), 90_000);
      const cleanup = () => {
        clearTimeout(timer);
        cmd.off("spawn", onSpawn);
        cmd.off("exit", onExit);
        cmd.off("error", fail);
      };
      const fail = (e) => {
        if (complete) return;
        complete = true;
        cleanup();
        cmd.stdout.off("data", onData);
        kill();
        stdout.destroy();
        reject(new Error(redactCall(e?.message ?? e)));
      };
      const finish = () => {
        complete = true;
        cleanup();
        resolve();
      };
      const sendPayload = () => {
        let offset = 0;
        const write = () => {
          if (complete) return;
          try {
            while (offset < payload.length) {
              const chunk = payload.slice(offset, offset + 16 * 1024);
              offset += chunk.length;
              if (!cmd.stdin.write(chunk)) { cmd.stdin.once("drain", write); return; }
            }
          } catch (e) { fail(e); }
        };
        write();
      };
      const onData = (b) => {
        if (!marker) {
          if (!stdout.write(b)) cmd.stdout.pause();
          return;
        }
        pending += b.toString("utf8");
        const at = pending.indexOf(marker);
        if (at < 0) {
          // Only a suffix can be part of the next marker; discard probe echo / bootstrap chatter.
          pending = pending.slice(-(marker.length - 1));
          return;
        }
        pending = pending.slice(at + marker.length);
        if (marker === "PCA_READY_1") {
          marker = "PCA_APPLIED_1";
          sendPayload();
        } else {
          marker = "";
          if (pending) stdout.write(pending);
          pending = "";
          finish();
        }
      };
      const onSpawn = () => {
        if (!payload) return finish();
        try { cmd.stdin.write("PCA_ENV_1\n"); } catch (e) { fail(e); }
      };
      const onExit = () => fail(new Error("PTY bootstrap exited before environment was applied"));
      stdout.on("drain", () => cmd.stdout.resume());
      // Install ALL listeners before the first write (including synchronous test/SDK responses).
      cmd.stdout.on("data", onData);
      cmd.once("spawn", onSpawn);
      cmd.once("exit", onExit);
      cmd.on("error", fail);
    });
    return {
      stdout,
      write(data) { cmd.stdin.write(data); },
      eof() { cmd.stdin.end(); },
      resize(c, r) { cmd.resize(clampDim(c, cols, PTY_MAX_COLS), clampDim(r, rows, PTY_MAX_ROWS)); },
      signal(sig) { cmd.signal(String(sig).slice(0, 16)); },
      kill,
      exit,
    };
  }

  function pty(runtimeId) {
    // Interactive access is a delete-class capability: name-rule check before any SDK call, same as release.
    if (!isManaged(runtimeId)) throw new Error(`refusing interactive session on unmanaged Sprite ${String(runtimeId)}`);
    const sprite = spriteOf(runtimeId);
    return async ({ cwd, cols, rows, env, sessionEnv, sessionUnset } = {}) => {
      if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new TypeError("pty requires an absolute cwd");
      const safeEnv = {};
      for (const [k, v] of Object.entries(env ?? {})) {
        if (PTY_ENV_ALLOW.has(k) && typeof v === "string") safeEnv[k] = v.slice(0, 200);
      }
      return timed("pty", () =>
        spawnPty(sprite, { cwd, cols: clampDim(cols, 80, PTY_MAX_COLS), rows: clampDim(rows, 24, PTY_MAX_ROWS), env: safeEnv, sessionEnv, sessionUnset }),
      );
    };
  }

  async function init(runtimeId) {
    return timed("init", () =>
      initSprite({
        bash: bash(runtimeId),
        sprite: client.sprite(runtimeId),
        gitEmail,
        credentialHelper: Boolean(ghToken),
        redact,
      }),
    );
  }

  async function statusOf(runtimeId) {
    try {
      const raw = await client.getSprite(runtimeId);
      return { state: "available", raw: raw?.status };
    } catch (e) {
      if (status(e) === 404) return { state: "missing" };
      return { state: "unknown", raw: redact(e?.message ?? e) };
    }
  }

  async function list() {
    return timed("list", async () => {
      const out = [];
      let token;
      do {
        const page = await client.listSprites({ prefix: NAME_PREFIX, ...(token ? { continuationToken: token } : {}) });
        for (const s of page?.sprites ?? []) {
          if (isManaged(s.name, s.labels ?? [])) out.push({ runtimeId: s.name, labels: [...s.labels] });
        }
        token = page?.hasMore ? page.nextContinuationToken : undefined;
      } while (token);
      return out;
    });
  }

  async function release(runtimeId) {
    // Hard check before any network call: name rule.
    if (!isManaged(runtimeId)) throw new Error(`refusing to release ${String(runtimeId)}: not a managed Sprite`);
    return timed("release", async () => {
      let s;
      try {
        s = await client.getSprite(runtimeId);
      } catch (e) {
        if (status(e) === 404) return { released: false };
        throw e;
      }
      // Second check with the labels actually read from the platform.
      if (!isManaged(runtimeId, s?.labels ?? [])) throw new Error(`refusing to release ${runtimeId}: missing label ${APP_LABEL}`);
      try {
        await client.deleteSprite(runtimeId);
      } catch (e) {
        if (status(e) === 404) return { released: false };
        throw e;
      }
      bashCache.delete(runtimeId);
      spriteCache.delete(runtimeId);
      return { released: true };
    });
  }

  return { kind: "sprites", runtimeName, isManaged, ensure, init, status: statusOf, bash, pty, list, release };
}
