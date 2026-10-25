// Rebuild a workspace on a NEW Sprite from a checkpoint (M1-10, docs/M1-PLAN.md section 3.3 / 3.5 / 4.7).
//
//   ensure (deterministic name) -> init + install runner -> clone at the checkpoint's baseCommit (via runner)
//   -> cps.apply (uncommitted work) -> bindings.bind (version + 1, the old binding becomes `replaced`)
//
// Rules this module keeps:
//  - The old runtime is never touched or deleted (M1 has no automatic release); the workspace stays `ready`.
//  - No new workspace fields. The history of a rebuild is: bindings history (version + 1, old one `replaced`) plus one intent
//    row `workspace.rebuild` whose evidence is {checkpointId, fromVersion, toVersion, ...}.
//  - Until the final `bind` the old binding stays active, so a failure at any step leaves the workspace exactly as it was.
//    Half-built Sprite names are written to the intent evidence and listed (names only) in the thrown error.
//  - Restart safe: the Sprite name is deterministic (provider.runtimeName(requestId)), every sub step has its own intent row,
//    and calling again with the same requestId continues instead of creating a second Sprite or cloning twice.
//  - Old, unfinished tool calls are NOT replayed on the new machine. That is Exec's job (src/ext/exec.mjs): it pins
//    {runtimeId, bindingVersion} in a memo and refuses to prepare/start when the current binding differs. Rebuilding bumps the
//    binding version, which is what makes that check fire (see test/workspace-rebuild.test.mjs).
//  - Nothing here receives a token; messages that are stored or returned go through `sanitize`.
import { HttpError } from "./api.mjs";
import { codeScript, createRunnerCache, definite, isUncertain, makeSanitizer, runAttempt, sq } from "./runner/attempt.mjs";

const REQUEST_ID_RE = /^[\x21-\x7e]{1,200}$/;

export class RebuildError extends Error {
  /** @param {"not_found"|"conflict"|"invalid"|"integrity"|"failed"|"uncertain"} code */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "RebuildError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Put the half-built clone back on the base commit with a clean tree (only used on a Sprite that was never bound). */
function cleanScript({ dir, commit }) {
  return ["set -eu", `cd ${sq(dir)}`, `git reset -q --hard ${sq(commit)}`, "git clean -fdxq", "git rev-parse HEAD"].join("\n");
}

/**
 * @param {object} deps
 * @param {any} deps.svc    workspace service (svc.get)
 * @param {any} deps.store  control store
 * @param {any} [deps.github] unused today (the base commit comes from the checkpoint); kept for the contract
 * @param {Record<string, any>} deps.providers  the default provider (deps.providerKind, sprites by default) hosts rebuilt workspaces
 * @param {any} deps.cps    checkpoint service (verify, apply)
 * @param {(runtimeId: string) => any} [deps.runnerFor] runner client factory (default: createRunnerClient over provider.bash)
 * @param {string} [deps.home] Sprite home (default provider.home or /home/sprite)
 * @param {(repo: string) => string} [deps.cloneUrl]
 * @param {string[]} [deps.secrets] extra values to redact
 * @param {(entry: object) => void} [deps.log]
 */
export function createRebuilder(deps) {
  const {
    svc,
    store,
    providers,
    providerKind = process.env.TARSBOT_PROVIDER ?? "sprites",
    cps,
    runnerFor,
    cloneUrl = (repo) => `https://github.com/${repo}.git`,
    secrets = [],
    log = () => {},
  } = deps ?? {};
  const {
    now = Date.now,
    stepTimeoutMs = 30 * 60_000,
    waitSeconds = 20,
    waitRetries = 5,
    retryDelayMs = 1000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps ?? {};
  for (const [k, v] of Object.entries({ store, providers, cps })) {
    if (!v) throw new TypeError(`rebuildWorkspace requires ${k}`);
  }

  const note = (entry) => {
    try {
      log(entry);
    } catch {
      // logging never breaks a call
    }
  };

  const sanitize = makeSanitizer(secrets);

  const getWorkspace = (id) => (svc?.get ? svc.get(id) : store.workspaces.get(id));

  const runners = createRunnerCache({ runnerFor });
  const getRunner = (runtimeId, provider) => runners.get(runtimeId, provider);

  /** Run `command` through the runner on the new Sprite as a restart-safe attempt (src/runner/attempt.mjs). */
  async function runCommand({ workspaceId, rid, runtimeId, provider, step, cwd, command }) {
    const runner = await getRunner(runtimeId, provider);
    return runAttempt(
      { store, runner, sanitize, now, sleep, stepTimeoutMs, waitSeconds, waitRetries, retryDelayMs },
      { workspaceId, keyPrefix: `${rid}:${step}`, kind: `workspace.rebuild.${step}`, cwd, command },
    );
  }

  // Same-workspace rebuilds are serialized, so a repeated call with the same requestId sees the first one's result.
  const chains = new Map();
  function serialized(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn);
    const tail = next.catch(() => {});
    chains.set(key, tail);
    tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return next;
  }

  async function rebuildOnce({ workspaceId, checkpointId, requestId }) {
    if (typeof workspaceId !== "string" || !workspaceId) throw new RebuildError("invalid", "workspaceId 必填");
    if (typeof checkpointId !== "string" || !checkpointId) throw new RebuildError("invalid", "checkpointId 必填");
    if (requestId !== undefined && !(typeof requestId === "string" && REQUEST_ID_RE.test(requestId))) {
      throw new RebuildError("invalid", "requestId 必须是 1-200 个可见 ASCII 字符");
    }

    const ws = getWorkspace(workspaceId);
    if (!ws) throw new RebuildError("not_found", `工作区不存在：${workspaceId}`);
    if (ws.status !== "ready") throw new RebuildError("conflict", `工作区不是 ready 状态（${ws.status}），不能重建`);

    // The checkpoint must be this workspace's own. Another workspace's id is reported exactly like an unknown one.
    const checkpoint = store.checkpoints.get(checkpointId);
    if (!checkpoint || checkpoint.workspaceId !== ws.id) throw new RebuildError("not_found", `检查点不存在：${checkpointId}`);
    if (!(await cps.verify(checkpoint))) throw new RebuildError("integrity", "检查点校验失败（文件缺失或 sha256 不符），拒绝重建");

    const current = store.bindings.current(ws.id);
    if (!current) throw new RebuildError("conflict", `工作区 ${ws.id} 没有 active 运行环境绑定`);
    const history = store.bindings.history(ws.id);
    const nextVersion = Math.max(0, ...history.map((b) => b.version)) + 1;

    const rid = requestId ?? `${ws.id}:rebuild:${nextVersion}`;
    const provider = providers[providerKind] ?? providers.sprites;
    if (!provider) throw new RebuildError("conflict", `供应商 ${providerKind} 未配置`);
    const baseCommit = checkpoint.baseCommit ?? ws.baseCommit;
    if (!baseCommit) throw new RebuildError("invalid", "检查点和工作区都没有记录基准提交，无法重建");

    // ---- intent: resume / idempotency --------------------------------------------------------------------------------
    const prior = store.intents.get(rid);
    if (prior) {
      if (prior.kind !== "workspace.rebuild" || prior.workspaceId !== ws.id || prior.evidence?.checkpointId !== checkpoint.id) {
        throw new RebuildError("conflict", "requestId 已被不同的请求使用");
      }
      if (prior.state === "confirmed") {
        const done = history.find((b) => b.runtimeId === prior.target && b.version === prior.evidence?.toVersion);
        if (done) return done;
        throw new RebuildError("conflict", "该 requestId 对应的重建已完成，但绑定记录已变化");
      }
    }
    const toVersion = prior?.evidence?.toVersion ?? nextVersion;
    const fromVersion = prior?.evidence?.fromVersion ?? current.version;
    const name = prior?.target ?? provider.runtimeName(rid);

    // bound but not yet settled (crash between bind and settle): finish the bookkeeping, build nothing
    const already = history.find((b) => b.runtimeId === name && b.version === toVersion);
    if (already) {
      store.intents.settle(rid, { state: "confirmed", evidence: { ...(prior?.evidence ?? {}), checkpointId: checkpoint.id, fromVersion, toVersion, runtimeId: name } });
      return already;
    }
    if (current.version !== fromVersion) throw new RebuildError("conflict", `绑定已从版本 ${fromVersion} 变为 ${current.version}，请重新发起重建`);
    if (provider.isManaged && !provider.isManaged(name)) throw new RebuildError("failed", "供应商返回了非受管的运行环境名称，拒绝使用");

    const { intent } = store.intents.begin({ requestId: rid, kind: "workspace.rebuild", target: name, workspaceId: ws.id });
    const evidence = { ...(intent.evidence ?? {}), checkpointId: checkpoint.id, fromVersion, toVersion };
    const halfBuilt = new Set(Array.isArray(evidence.halfBuilt) ? evidence.halfBuilt : []);
    const persist = (state, extra = {}) => {
      Object.assign(evidence, extra);
      evidence.halfBuilt = [...halfBuilt];
      store.intents.settle(rid, { state, evidence });
    };
    persist("sent");
    note({ ev: "rebuild.start", workspaceId: ws.id, fromVersion, toVersion });

    let step = "runtime";
    try {
      // 1. new Sprite (deterministic name; ensure looks it up before creating)
      const createRid = `${rid}:sprites.create`;
      store.intents.begin({ requestId: createRid, kind: "sprites.create", target: name, workspaceId: ws.id });
      store.intents.markSent(createRid);
      let res;
      try {
        res = await provider.ensure({ requestId: rid, workspaceId: ws.id });
      } catch (e) {
        // an uncertain failure may still have created it: list the name so a person can check
        if (isUncertain(e)) halfBuilt.add(name);
        store.intents.settle(createRid, { state: isUncertain(e) ? "unknown" : "failed", evidence: { error: sanitize(e?.message, 300) } });
        throw e;
      }
      if (res.runtimeId !== name) throw definite("供应商返回的运行环境名称与确定性名称不一致");
      halfBuilt.add(name);
      store.intents.settle(createRid, { state: "confirmed", evidence: { runtimeId: name, created: Boolean(res.created) } });
      persist("sent");

      // 2. init + runner
      step = "init";
      await provider.init(name);
      const runner = await getRunner(name, provider);
      await runner.install();

      // 3. clone and check out the checkpoint's baseCommit (never the newest base branch)
      step = "code";
      const home = deps.home ?? provider.home ?? "/home/sprite";
      await runCommand({
        workspaceId: ws.id,
        rid,
        runtimeId: name,
        provider,
        step: "code",
        cwd: home,
        command: codeScript({ url: cloneUrl(ws.repo), dir: ws.cwd, branch: ws.branch, commit: baseCommit }),
      });

      // 4. uncommitted work. A previous attempt that may have half-applied leaves the tree dirty (apply refuses a dirty
      //    tree), and this Sprite has never been bound, so putting it back on the base commit loses nothing.
      step = "apply";
      const applyRid = `${rid}:apply`;
      const applyIntent = store.intents.begin({ requestId: applyRid, kind: "workspace.rebuild.apply", target: checkpoint.id, workspaceId: ws.id }).intent;
      if (applyIntent.state !== "confirmed") {
        const bash = provider.bash(name);
        if (applyIntent.state !== "planned") {
          // idempotent and quick, so it goes straight through the bash primitive (no exactly-once bookkeeping needed)
          const cr = await bash(cleanScript({ dir: ws.cwd, commit: baseCommit }), { timeoutMs: 120_000 });
          if (cr?.timedOut || cr?.exitCode !== 0) throw definite(`清理上次未完成的恢复失败：${sanitize(cr?.stderr, 300)}`);
        }
        store.intents.markSent(applyRid);
        try {
          await cps.apply({ checkpoint, bash, cwd: ws.cwd });
        } catch (e) {
          store.intents.settle(applyRid, { state: isUncertain(e) ? "unknown" : "failed", evidence: { error: sanitize(e?.message, 300) } });
          throw e;
        }
        store.intents.settle(applyRid, { state: "confirmed" });
      }

      // 5. switch the binding: version + 1, the old one becomes `replaced`, the workspace stays `ready`
      step = "bind";
      if (store.bindings.current(ws.id)?.version !== fromVersion) throw definite(`绑定已变化（期望版本 ${fromVersion}），放弃切换`);
      const binding = store.bindings.bind(ws.id, { provider: provider.kind ?? "sprites", runtimeId: name });
      persist("confirmed", { runtimeId: name, bindingVersion: binding.version });
      note({ ev: "rebuild.done", workspaceId: ws.id, fromVersion, toVersion: binding.version });
      return binding;
    } catch (e) {
      const unsure = isUncertain(e);
      const names = [...halfBuilt];
      const reason = sanitize(e?.message ?? e, 400);
      try {
        persist(unsure ? "unknown" : "failed", { failedStep: step, error: reason });
      } catch {
        // the control store itself failing must not hide the original error
      }
      note({ ev: "rebuild.error", workspaceId: ws.id, step, outcome: unsure ? "unknown" : "failed", error: reason });
      const tailMsg = names.length > 0 ? `；已创建的半成品 Sprite（需人工清理，旧绑定仍然有效）：${names.join(", ")}` : "";
      throw new RebuildError(unsure ? "uncertain" : "failed", `重建失败（${step}）：${unsure && !reason.startsWith("结果待确认") ? "结果待确认：" : ""}${reason}${tailMsg}`, {
        step,
        halfBuilt: names,
      });
    }
  }

  return function rebuild(args) {
    return serialized(args?.workspaceId ?? "", () => rebuildOnce(args ?? {}));
  };
}

/** `rebuildWorkspace(deps, { workspaceId, checkpointId, requestId? }) -> Binding` (docs/M1-PLAN.md section 4.7). */
export function rebuildWorkspace(deps, args) {
  // one rebuilder per deps object so concurrent calls with the same deps are serialized
  let rebuilder = REBUILDERS.get(deps);
  if (!rebuilder) {
    rebuilder = createRebuilder(deps);
    if (deps && typeof deps === "object") REBUILDERS.set(deps, rebuilder);
  }
  return rebuilder(args);
}
const REBUILDERS = new WeakMap();

const STATUS = { not_found: 404, conflict: 409, invalid: 400, integrity: 409, uncertain: 502, failed: 500 };

/** Safe summary of a binding for API responses (no secrets exist in a binding; ids are Sprite names). */
const bindingView = (b, replaced) => ({
  id: b.id,
  workspaceId: b.workspaceId,
  provider: b.provider,
  runtimeId: b.runtimeId,
  version: b.version,
  state: b.state,
  createdAt: b.createdAt,
  // The previous environment is kept (M1 never releases it); its name is how newer work can still be recovered.
  ...(replaced ? { replaced: { runtimeId: replaced.runtimeId, version: replaced.version } } : {}),
});

/**
 * POST /api/workspaces/:id/rebuild  body {checkpointId, requestId?} -> the new binding.
 * Only registered when `app.ctx.rebuild` is injected: an async `({ workspaceId, checkpointId, requestId? }) => Binding`
 * (M1-13 builds it with `(args) => rebuildWorkspace({ svc, store, github, providers, cps, ... }, args)`).
 */
export function register(app) {
  const { rebuild, control } = app.ctx ?? {};
  if (typeof rebuild !== "function") return;

  app.post("/api/workspaces/:id/rebuild", async (_req, _res, { params, body }) => {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
    if (typeof body.checkpointId !== "string" || !body.checkpointId.trim()) throw new HttpError(400, "checkpointId is required");
    if (body.requestId !== undefined && typeof body.requestId !== "string") throw new HttpError(400, "requestId must be a string");
    try {
      const binding = await rebuild({
        workspaceId: params.id,
        checkpointId: body.checkpointId.trim(),
        ...(body.requestId ? { requestId: body.requestId.trim() } : {}),
      });
      const previous = control?.bindings?.history?.(params.id)?.filter((x) => x.version < binding.version).pop();
      return bindingView(binding, previous);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof RebuildError) throw new HttpError(STATUS[e.code] ?? 500, e.message);
      throw new HttpError(500, sanitizeRoute(e));
    }
  });
}

function sanitizeRoute(e) {
  return String(e?.message ?? e)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "***")
    .replace(/(?:\/Users|\/private\/var|\/var\/folders)\/[^\s'"):]+/g, "<path>")
    .slice(0, 300);
}
