// InstaBox provider: one instabox.sh machine per workspace (docs/INSTABOX-PLAN.md §"M1 适配"), the same shape as the
// Sprites provider. Safety rules (AGENTS.md "安全红线"):
//  - Only machines named `pca-…` whose metadata carries app=pi-cloud-agents are managed. `release` (the only delete
//    path) re-checks name + metadata; other machines in the org are never touched.
//  - `ensure` creates only after a definite 404 from getMachine; any other error is rethrown (never create on doubt).
//  - Errors are redacted; logs carry only op / duration / outcome, never commands or tokens.
// InstaBox specifics (verified live, docs/INSTABOX-PLAN.md §3): machines auto-suspend after ~30 idle minutes (free
// plan) and are woken transparently by the bash primitive (src/sandbox/instabox.mjs) — status "available" therefore
// covers suspended/stopped too. The free plan caps an org at 5 machines, so `ensure` fails with the platform's quota
// error once all slots are taken (release a workspace to free its machine).
import { createHash } from "node:crypto";
import { createInstaboxBash, instaboxApi, redactMessage } from "../sandbox/instabox.mjs";
import { initCommon } from "./sprites-init.mjs";

export const APP_META_VALUE = "pi-cloud-agents";
export const NAME_PREFIX = "pca-";
/** Never managed, regardless of any other rule. */
export const LEGACY_MACHINE_NAMES = ["pi-cloud-agents"];

export function createInstaboxProvider({
  apiKey,
  baseUrl,
  ghToken,
  gitEmail,
  templateId, // optional; default resolved once from GET /v1/templates (agent-browser, the free-plan template)
  log = () => {},
  startTimeoutMs,
  fetchImpl,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new TypeError("createInstaboxProvider requires INSTABOX_API_KEY");
  const client = instaboxApi({ ...(fetchImpl ? { fetchImpl } : {}), apiKey, baseUrl });
  const secrets = [apiKey, ghToken].filter((s) => typeof s === "string" && s);
  const redact = (m) => redactMessage(m, secrets);
  const denied = new Set([...LEGACY_MACHINE_NAMES, process.env.TARSBOT_INSTABOX_NAME].filter(Boolean));

  /** Redacted copy of an error that keeps status / apiCode / code. */
  const clean = (e) => {
    const out = new Error(redact(e?.message ?? e));
    if (e?.status !== undefined) out.status = e.status;
    if (e?.apiCode !== undefined) out.apiCode = redact(e.apiCode);
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
      note({ op, ms: Date.now() - t0, outcome: "error", apiCode: e?.apiCode, status: e?.status });
      throw clean(e);
    }
  };
  const isNotFound = (e) => e?.code === "INSTABOX_API" && (e.apiCode === "machine_not_found" || e.apiCode === "not_found" || e.status === 404);

  const runtimeName = (requestId) => {
    if (typeof requestId !== "string" || !requestId) throw new TypeError("requestId must be a non-empty string");
    return NAME_PREFIX + createHash("sha256").update(requestId).digest("hex").slice(0, 10);
  };

  /** `metadata` undefined = not known (name-only check); otherwise the app label must be present. */
  const isManaged = (name, metadata) => {
    if (typeof name !== "string" || !name.startsWith(NAME_PREFIX) || denied.has(name)) return false;
    if (metadata === undefined || metadata === null) return true;
    return typeof metadata === "object" && metadata.app === APP_META_VALUE;
  };

  const assertOwned = (name, machine) => {
    if (!isManaged(name, machine?.metadata)) {
      throw new Error(`machine ${name} exists but its metadata is not app=${APP_META_VALUE}; refusing to use it`);
    }
  };

  let resolvedTemplateId; // cache: the default template, resolved once
  async function defaultTemplateId() {
    if (typeof templateId === "string" && templateId) return templateId;
    resolvedTemplateId ??= (async () => {
      const listed = (await client.listTemplates()).templates ?? [];
      const chosen = listed.find((t) => t.id === "agent-browser") ?? listed[0];
      if (!chosen) throw new Error("GET /v1/templates returned no templates");
      return chosen.id;
    })();
    return resolvedTemplateId;
  }

  async function ensure({ requestId, workspaceId }) {
    const name = runtimeName(requestId);
    return timed("ensure", async () => {
      try {
        const m = await client.getMachine(name);
        assertOwned(name, m);
        return { runtimeId: name, created: false };
      } catch (e) {
        if (!isNotFound(e)) throw e; // includes the metadata-mismatch error and all network/5xx errors
      }
      let ref;
      try {
        ref = await client.createMachine({
          name,
          templateId: await defaultTemplateId(),
          metadata: { app: APP_META_VALUE, ws: String(workspaceId) },
        });
      } catch (e) {
        // concurrent create / lost response: the machine already exists — confirm and reuse
        if (!(e?.code === "INSTABOX_API" && e.status === 409)) throw e;
        const m = await client.getMachine(name);
        assertOwned(name, m);
        return { runtimeId: name, created: false };
      }
      const done = await client.waitOperation(ref, { timeoutMs: 300_000 });
      if (done.state !== "succeeded") {
        throw new Error(`create machine ${name} failed: ${redact(String(done.error?.message ?? done.error ?? done.state))}`);
      }
      assertOwned(name, done.machine);
      return { runtimeId: name, created: true };
    });
  }

  const bashCache = new Map();
  function bash(runtimeId) {
    if (typeof runtimeId !== "string" || !runtimeId) throw new TypeError("runtimeId required");
    let b = bashCache.get(runtimeId);
    if (!b) {
      b = createInstaboxBash({
        ...(fetchImpl ? { fetchImpl } : {}),
        apiKey,
        baseUrl,
        name: runtimeId,
        ...(startTimeoutMs ? { startTimeoutMs } : {}),
        env: ghToken ? { GH_TOKEN: ghToken } : {},
        secrets,
        log: (e) => note({ op: "bash", ...e }),
      });
      bashCache.set(runtimeId, b);
    }
    return b;
  }

  async function init(runtimeId) {
    return timed("init", () =>
      initCommon({
        bash: bash(runtimeId),
        gitEmail,
        credentialHelper: Boolean(ghToken),
        ghProbe: "command -v gh >/dev/null 2>&1 || test -x \"$HOME/.local/bin/gh\"",
        redact,
        what: "instabox init",
      }),
    );
  }

  async function statusOf(runtimeId) {
    try {
      const m = await client.getMachine(runtimeId);
      // suspended / stopped machines are fine: the bash primitive wakes them on demand
      return { state: "available", raw: m?.state };
    } catch (e) {
      if (isNotFound(e)) return { state: "missing" };
      return { state: "unknown", raw: redact(e?.message ?? e) };
    }
  }

  async function list() {
    return timed("list", async () => {
      const out = [];
      let cursor;
      do {
        const q = new URLSearchParams({ limit: "100", metadata: "app:pi-cloud-agents", ...(cursor ? { cursor } : {}) });
        const page = await client.listMachines(q.toString());
        for (const m of page?.machines ?? []) {
          if (isManaged(m.name, m.metadata)) {
            out.push({
              runtimeId: m.name,
              labels: [`app:${APP_META_VALUE}`, ...(typeof m.metadata?.ws === "string" ? [`ws:${m.metadata.ws}`] : [])],
            });
          }
        }
        cursor = typeof page?.cursor === "string" && page.cursor ? page.cursor : undefined;
      } while (cursor);
      return out;
    });
  }

  async function release(runtimeId) {
    // Hard check before any network call: name rule.
    if (!isManaged(runtimeId)) throw new Error(`refusing to release ${String(runtimeId)}: not a managed InstaBox machine`);
    return timed("release", async () => {
      let m;
      try {
        m = await client.getMachine(runtimeId);
      } catch (e) {
        if (isNotFound(e)) return { released: false };
        throw e;
      }
      // Second check with the metadata actually read from the platform.
      if (!isManaged(runtimeId, m?.metadata)) throw new Error(`refusing to release ${runtimeId}: missing metadata app=${APP_META_VALUE}`);
      let ref;
      try {
        ref = await client.deleteMachine(runtimeId);
      } catch (e) {
        if (isNotFound(e)) return { released: false };
        throw e;
      }
      await client.waitOperation(ref, { timeoutMs: 300_000 });
      bashCache.delete(runtimeId);
      return { released: true };
    });
  }

  return { kind: "instabox", home: "/data/home", runtimeName, isManaged, ensure, init, status: statusOf, bash, list, release };
}
