// Sprites provider: one Sprite per workspace (docs/M1-PLAN.md §4.3). Takes an injected `client` (SpritesClient or a
// same-shaped fake). Safety rules (AGENTS.md "安全红线"):
//  - Only Sprites named `pca-…` that carry the label `app:pi-cloud-agents` are managed. `release` (the only delete
//    path) checks `isManaged` first; the legacy shared Sprite `pi-cloud-agents` is never managed.
//  - `ensure` creates only after a definite 404 from getSprite; any other error is rethrown (never create on doubt).
//  - Errors are redacted; logs carry only op / duration / outcome, never commands or tokens.
import { createHash } from "node:crypto";
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
  function bash(runtimeId) {
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
    return b;
  }

  // ---- Interactive PTY (AMP13-PTY) --------------------------------------------------------------------------
  // `pty(runtimeId)` returns a per-workspace factory: `await factory({cwd, cols, rows, env})` opens ONE live
  // interactive shell (sprite.spawn with tty:true) and resolves to a handle:
  //   handle.stdout            Readable — the merged PTY byte stream (tty mode has no separate stderr)
  //   handle.write(string|Buf) user keystrokes/pasted text to the shell's stdin
  //   handle.eof()             stdin EOF (Ctrl-D)
  //   handle.resize(cols,rows) TTY resize control frame (clamped)
  //   handle.signal(sig)       JSON control signal (e.g. "SIGINT")
  //   handle.kill()            SIGKILL + socket close; idempotent, safe on an already-dead shell
  //   handle.exit              Promise<{state:"exited"|"error", exit:number|null, message?}> — resolves once
  //
  // Deliberately NOT injected: GH_TOKEN (bash() injects it per exec because those commands are Bot-driven; an
  // interactive shell where the user can run `env` must not carry it). `env` is filtered to a terminal-display
  // allowlist — its values travel in the exec URL query, so anything sensitive must never be passed.
  const PTY_ENV_ALLOW = new Set(["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE"]);
  const PTY_MAX_COLS = 1000;
  const PTY_MAX_ROWS = 500;
  const clampDim = (v, dflt, max) => (Number.isInteger(v) && v >= 2 ? Math.min(v, max) : dflt);

  const spriteCache = new Map(); // runtimeId -> client.sprite(name); the handle itself is stateless
  const spriteOf = (runtimeId) => {
    let s = spriteCache.get(runtimeId);
    if (!s) {
      s = client.sprite(runtimeId);
      spriteCache.set(runtimeId, s);
    }
    return s;
  };

  /** One interactive shell on `sprite`. Rejects (redacted) when the exec connection cannot be opened. */
  async function spawnPty(sprite, { cwd, cols, rows, env }) {
    // `sh -c 'exec "${SHELL:-/bin/bash}" -il'`: a login interactive shell; exec replaces sh so the PTY's
    // foreground process (and its exit status / signals) is exactly the user's shell.
    const cmd = sprite.spawn("/bin/sh", ["-c", 'exec "${SHELL:-/bin/bash}" -il'], {
      tty: true,
      cwd,
      cols,
      rows,
      ...(Object.keys(env).length ? { env } : {}),
    });
    let resolveExit;
    const exit = new Promise((res) => {
      resolveExit = res;
    });
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolveExit(v);
      }
    };
    // The SDK synthesizes 'exit' on a tty WebSocket close without an exit frame (close code -> exit code),
    // so `exit` still resolves on a dropped connection; an explicit 'error' reports the failure message.
    cmd.on("exit", (code) => done({ state: "exited", exit: Number.isInteger(code) && code >= 0 ? code : null }));
    cmd.on("error", (e) => done({ state: "error", exit: null, message: redact(e?.message ?? e) }));
    await new Promise((resolve, reject) => {
      cmd.once("spawn", resolve);
      cmd.once("error", () => reject(new Error("PTY exec connection failed"))); // detailed reason lands on `exit`
    });
    return {
      stdout: cmd.stdout,
      write(data) {
        try {
          const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
          if (b.length) cmd.stdin.write(b);
        } catch {
          // dead stream: the exit promise already reports it
        }
      },
      eof() {
        try {
          cmd.stdin.end();
        } catch {
          // already closed
        }
      },
      resize(c, r) {
        try {
          cmd.resize(clampDim(c, cols, PTY_MAX_COLS), clampDim(r, rows, PTY_MAX_ROWS));
        } catch {
          // resize is best effort
        }
      },
      signal(sig) {
        try {
          cmd.signal(String(sig).slice(0, 16));
        } catch {
          // dead stream
        }
      },
      kill() {
        try {
          cmd.kill("SIGKILL");
        } catch {
          // best effort
        }
        try {
          cmd.close();
        } catch {
          // already closed
        }
      },
      exit,
    };
  }

  function pty(runtimeId) {
    // Interactive access is a delete-class capability: name-rule check before any SDK call, same as release.
    if (!isManaged(runtimeId)) throw new Error(`refusing interactive session on unmanaged Sprite ${String(runtimeId)}`);
    const sprite = spriteOf(runtimeId);
    return async ({ cwd, cols, rows, env } = {}) => {
      if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new TypeError("pty requires an absolute cwd");
      const safeEnv = {};
      for (const [k, v] of Object.entries(env ?? {})) {
        if (PTY_ENV_ALLOW.has(k) && typeof v === "string") safeEnv[k] = v.slice(0, 200);
      }
      return timed("pty", () => spawnPty(sprite, { cwd, cols: clampDim(cols, 80, PTY_MAX_COLS), rows: clampDim(rows, 24, PTY_MAX_ROWS), env: safeEnv }));
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
