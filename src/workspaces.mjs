// Workspace service (M1-07, docs/M1-PLAN.md §4.6): create a workspace record, then drive it through
//   runtime -> init -> code -> deps -> agent
// in the background. Everything here is built so that a process kill at ANY point can be followed by
// `resumePending()` on the same control database without creating a second Sprite, cloning twice, overwriting code,
// creating a second Bot, or submitting the first task twice.
//
// How each external action is made restart-safe:
//  - runtime: intent `sprites.create` (deterministic Sprite name from the workspace requestId) is written first;
//    `provider.ensure` looks the name up before creating, so a repeat finds the same Sprite. An uncertain failure
//    (5xx / network) leaves the step `unknown`; nothing calls create again until `retry`.
//  - code / deps: the shell command runs through the runner (survives a dropped connection). Each attempt is an
//    intent row `ws:<id>:<runtime>:<step>:<cmdhash>:<n>`; its state is the two-phase protocol
//      planned -> (prepare) -> sent -> (start) -> confirmed | failed | unknown
//    so a crash after `prepare` but before `start` is safe to start, while a crash after `sent` with a runner state of
//    claimed / lost / missing is "result unconfirmed" (never auto-started; a retry opens attempt n+1).
//    The code script itself is idempotent: an existing git directory is never re-cloned or reset.
//  - agent: Bot creation is skipped when the workspace already has a linked conversation; an orphan Bot (created but
//    not yet linked) is found by its unique instructions text, never created twice.
//  - first task: submitted AFTER the workspace is `ready` (a model tool call against a `preparing` workspace would hit
//    the env factory's "not ready" error). The submit uses requestId `ws:<id>:task`, which Pi Durable de-duplicates
//    across restarts (probe A3), and an intent row records whether it completed.
// Secrets: nothing here ever receives a token; every message stored or logged goes through `sanitize`.
import { defaultModel as configDefaultModel } from "./config.mjs";
import { STEPS } from "./control/db.mjs";
import { codeScript, createRunnerCache, definite, isUncertain, makeSanitizer, runAttempt, sha256 } from "./runner/attempt.mjs";

export { STEPS, isUncertain };

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REQUEST_ID_RE = /^[\x21-\x7e]{1,200}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
/** Lower-case `[a-z0-9-]` slug, at most `max` chars; "" when nothing usable is left (e.g. a non-ASCII-only task). */
export function slugify(text, max = 32) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** English instructions for the workspace's Bot; overrides steps 2 and 3 of the generic preamble workflow. */
export function workspaceInstructions(ws) {
  const at = ws.baseCommit ? ` (commit ${String(ws.baseCommit).slice(0, 12)})` : "";
  return [
    `This workspace is the GitHub repository ${ws.repo}.`,
    `- Working directory: ${ws.cwd}. The repository is already cloned there and the work branch ${ws.branch} is already checked out, created from the base branch ${ws.baseBranch}${at}.`,
    `- Do NOT clone the repository again and do NOT create another branch: this overrides steps 2 and 3 of the general git workflow. Work inside ${ws.cwd}, and check \`git status\` and \`git log --oneline -5\` first.`,
    `- Commit your work on ${ws.branch} and push only that branch (\`git push -u origin ${ws.branch}\`). Never push to ${ws.baseBranch} or to any other branch.`,
    `- The user normally opens the pull request from the web UI. If you are asked to open it yourself, first run \`gh pr list --head ${ws.branch} --state all\`; only when there is none run \`gh pr create --base ${ws.baseBranch} --head ${ws.branch}\`. Never open a second pull request for this branch.`,
  ].join("\n");
}

/**
 * @param {object} deps
 * @param {any} deps.store  control store (src/control/store.mjs)
 * @param {any} deps.github github client (getBranch / listBranches / listRepos)
 * @param {Record<string, any>} deps.providers  runtime providers by kind; `providers.sprites` creates workspaces
 * @param {any} deps.bots   BotRegistry (list / get / createBot / conversation)
 * @param {any} deps.ctx    Pi Durable context for conversation calls
 * @param {(runtimeId: string) => any} [deps.runnerFor] runner client factory (may return a Promise).
 *        Default: createRunnerClient({ bash: provider.bash(runtimeId) }), loaded lazily from ./runner/client.mjs
 */
export function createWorkspaceService({
  store,
  github,
  providers,
  bots,
  ctx,
  runnerFor,
  now = Date.now,
  home,
  cloneUrl = (repo) => `https://github.com/${repo}.git`,
  defaultModel: modelDefault = configDefaultModel,
  secrets = [],
  log = () => {},
  stepTimeoutMs = 30 * 60_000,
  waitSeconds = 20,
  waitRetries = 5,
  retryDelayMs = 1000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (const [k, v] of Object.entries({ store, github, providers, bots })) {
    if (!v) throw new TypeError(`createWorkspaceService requires ${k}`);
  }

  const note = (entry) => {
    try {
      log(entry);
    } catch {
      // logging never breaks a call
    }
  };

  // ---- redaction ----------------------------------------------------------------------------------------------------
  const sanitize = makeSanitizer(secrets);

  const homeDir = () => home ?? providers.sprites?.home ?? "/home/sprite";

  // ---- helpers ------------------------------------------------------------------------------------------------------
  function bindingOf(ws) {
    const binding = store.bindings.current(ws.id);
    if (!binding) throw definite(`工作区 ${ws.id} 没有 active 运行环境绑定`);
    const provider = Object.hasOwn(providers, binding.provider) ? providers[binding.provider] : undefined;
    if (!provider) throw definite(`供应商 ${binding.provider} 未注册`);
    return { binding, provider };
  }

  const runners = createRunnerCache({ runnerFor });
  const getRunner = (runtimeId, provider) => runners.get(runtimeId, provider);

  /**
   * Run `command` through the runner as a restart-safe attempt (see src/runner/attempt.mjs). Resolves on exit code 0.
   * Throws definite(...) for a non-zero exit, uncertain(...) when the outcome cannot be confirmed.
   */
  async function runCommand({ ws, runtimeId, provider, step, cwd, command }) {
    const runner = await getRunner(runtimeId, provider);
    return runAttempt(
      { store, runner, sanitize, now, sleep, stepTimeoutMs, waitSeconds, waitRetries, retryDelayMs },
      { workspaceId: ws.id, keyPrefix: `ws:${ws.id}:${runtimeId}:${step}`, kind: `workspace.${step}`, cwd, command },
    );
  }

  // ---- steps --------------------------------------------------------------------------------------------------------
  async function stepRuntime(ws) {
    const provider = providers.sprites;
    if (!provider) throw definite("供应商 sprites 未配置");
    const rid = `ws:${ws.id}:sprites.create`;
    const name = provider.runtimeName(ws.requestId);
    const { intent } = store.intents.begin({ requestId: rid, kind: "sprites.create", target: name, workspaceId: ws.id });

    if (store.bindings.current(ws.id)) {
      if (intent.state !== "confirmed") store.intents.settle(rid, { state: "confirmed", evidence: { runtimeId: name } });
      return;
    }
    store.intents.markSent(rid); // every attempt: the request may reach the platform from here on
    let res;
    try {
      res = await provider.ensure({ requestId: ws.requestId, workspaceId: ws.id });
    } catch (e) {
      store.intents.settle(rid, { state: isUncertain(e) ? "unknown" : "failed", evidence: { error: sanitize(e?.message, 300) } });
      throw e;
    }
    store.bindings.bind(ws.id, { provider: provider.kind ?? "sprites", runtimeId: res.runtimeId });
    store.intents.settle(rid, { state: "confirmed", evidence: { runtimeId: res.runtimeId, created: Boolean(res.created) } });
  }

  async function stepInit(ws) {
    const { binding, provider } = bindingOf(ws);
    await provider.init(binding.runtimeId);
    const runner = await getRunner(binding.runtimeId, provider);
    await runner.install();
  }

  async function stepCode(ws) {
    const { binding, provider } = bindingOf(ws);
    let baseCommit = ws.baseCommit;
    if (!baseCommit) {
      let branch;
      try {
        branch = await github.getBranch(ws.repo, ws.baseBranch);
      } catch (e) {
        throw definite(`读取基准分支失败：${e?.message ?? e}`); // a read: nothing was changed
      }
      if (!branch?.sha) throw definite(`基准分支 ${ws.baseBranch} 在 ${ws.repo} 中不存在`);
      baseCommit = branch.sha;
      store.workspaces.update(ws.id, { baseCommit });
    }
    const command = codeScript({ url: cloneUrl(ws.repo), dir: ws.cwd, branch: ws.branch, commit: baseCommit });
    await runCommand({ ws, runtimeId: binding.runtimeId, provider, step: "code", cwd: homeDir(), command });
  }

  async function stepDeps(ws) {
    const project = store.projects.get(ws.projectId);
    const installCommand = project?.installCommand?.trim();
    if (!installCommand) return "未配置";
    const { binding, provider } = bindingOf(ws);
    await runCommand({ ws, runtimeId: binding.runtimeId, provider, step: "deps", cwd: ws.cwd, command: installCommand });
  }

  function freeBotName(ws) {
    if (!bots.get(ws.name)) return ws.name;
    const hex = ws.branch.slice(ws.branch.lastIndexOf("-") + 1);
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? `${ws.name}-${hex}` : `${ws.name}-${hex}-${i + 1}`;
      if (!bots.get(candidate)) return candidate;
    }
  }

  async function stepAgent(ws) {
    if (store.links.conversationsOf(ws.id).length > 0) return; // already done: do not infer from message history
    const instructions = workspaceInstructions(ws);
    // a Bot created by an interrupted earlier pass (created, not yet linked) carries this workspace's id; matching on
    // instruction text would also adopt an unrelated Bot that happens to have the same text (a fork copies it)
    let bot = bots.list().find((b) => b.workspaceId === ws.id && !store.links.workspaceOf(String(b.conversationId)));
    if (!bot) bot = await bots.createBot({ name: freeBotName(ws), model: ws.model, cwd: ws.cwd, instructions, workspaceId: ws.id });
    // Pi Durable conversation ids are numbers; the control store keys them as text
    store.links.link({ conversationId: String(bot.conversationId), workspaceId: ws.id, botId: bot.id });
  }

  const STEP_IMPL = { runtime: stepRuntime, init: stepInit, code: stepCode, deps: stepDeps, agent: stepAgent };

  // ---- first task ---------------------------------------------------------------------------------------------------
  const taskKey = (ws) => `ws:${ws.id}:task`;
  const taskPending = (ws) => Boolean(ws.task) && store.intents.get(taskKey(ws))?.state !== "confirmed";

  /** Submit the workspace task exactly once (requestId is de-duplicated by Pi Durable across restarts). */
  async function dispatchTask(ws) {
    if (!taskPending(ws)) return;
    const rid = taskKey(ws);
    store.intents.begin({ requestId: rid, kind: "workspace.task", target: ws.id, workspaceId: ws.id });
    const link = store.links.conversationsOf(ws.id)[0];
    try {
      const bot = link ? (link.botId ? bots.get(link.botId) : bots.list().find((b) => String(b.conversationId) === link.conversationId)) : undefined;
      const conv = bot ? await bots.conversation(bot.id) : undefined;
      if (!conv) throw definite("找不到工作区的会话，无法提交首条任务");
      store.intents.markSent(rid);
      await conv.submit({ type: "input", content: ws.task, requestId: rid }, ctx);
      store.intents.settle(rid, { state: "confirmed" });
    } catch (e) {
      store.intents.settle(rid, { state: "failed", evidence: { error: sanitize(e?.message, 300) } });
      note({ ev: "task.failed", workspaceId: ws.id, error: sanitize(e?.message, 300) });
    }
  }

  // ---- running ------------------------------------------------------------------------------------------------------
  function recordFailure(ws, step, e) {
    const unsure = isUncertain(e);
    const raw = sanitize(e?.message ?? e);
    const message = unsure && !raw.startsWith("结果待确认") ? `结果待确认：${raw}` : raw;
    store.workspaces.setStep(ws.id, step, { state: unsure ? "unknown" : "failed", error: message });
    // `unknown` waits for the user to retry and keeps the workspace `preparing`; a definite failure fails it
    store.workspaces.update(ws.id, unsure ? { error: message } : { status: "failed", error: message });
    note({ ev: "step.error", workspaceId: ws.id, step, outcome: unsure ? "unknown" : "failed", error: message });
  }

  async function runOnce(id) {
    let ws = store.workspaces.get(id);
    if (!ws) throw coded("not_found", `工作区不存在：${id}`);
    if (ws.status === "ready") {
      await dispatchTask(ws);
      return store.workspaces.get(id);
    }
    if (ws.status !== "preparing") return ws;

    for (const step of STEPS) {
      ws = store.workspaces.get(id);
      if (ws.status !== "preparing") return ws;
      const state = store.workspaces.steps(id).find((s) => s.step === step)?.state ?? "pending";
      if (state === "done") continue;
      if (state === "failed" || state === "unknown") return ws; // wait for retry()
      store.workspaces.setStep(id, step, { state: "running" });
      note({ ev: "step.start", workspaceId: id, step });
      let doneNote;
      try {
        doneNote = await STEP_IMPL[step](ws);
      } catch (e) {
        recordFailure(ws, step, e);
        return store.workspaces.get(id);
      }
      store.workspaces.setStep(id, step, { state: "done", ...(doneNote ? { error: doneNote } : {}) });
      note({ ev: "step.done", workspaceId: id, step });
    }

    ws = store.workspaces.update(id, { status: "ready", error: null });
    note({ ev: "ready", workspaceId: id });
    await dispatchTask(ws);
    return store.workspaces.get(id);
  }

  const chains = new Map();
  /** Same-workspace runs are serialized; different workspaces run in parallel. */
  function run(id) {
    const prev = chains.get(id) ?? Promise.resolve();
    const next = prev.then(() => runOnce(id));
    const tail = next.catch(() => {});
    chains.set(id, tail);
    tail.then(() => {
      if (chains.get(id) === tail) chains.delete(id);
    });
    return next;
  }

  function schedule(id) {
    run(id).catch((e) => note({ ev: "run.error", workspaceId: id, error: sanitize(e?.message) }));
  }

  // ---- create -------------------------------------------------------------------------------------------------------
  const str = (v, name, max) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw coded("invalid", `${name} 必须是字符串`);
    const t = v.trim();
    if (!t) return null;
    if (t.length > max) throw coded("invalid", `${name} 过长（最多 ${max} 个字符）`);
    return t;
  };

  function normalize(input) {
    if (!input || typeof input !== "object") throw coded("invalid", "请求体必须是对象");
    const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
    if (!REQUEST_ID_RE.test(requestId)) throw coded("invalid", "requestId 必填（1-200 个可见 ASCII 字符）");
    const repo = typeof input.repo === "string" ? input.repo.trim() : "";
    if (!REPO_RE.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) throw coded("invalid", "repo 必须形如 owner/name");
    const baseBranch = str(input.baseBranch, "baseBranch", 200);
    if (baseBranch && (!BRANCH_RE.test(baseBranch) || baseBranch.includes("..") || baseBranch.includes("//") || baseBranch.endsWith("/") || baseBranch.endsWith(".lock"))) {
      throw coded("invalid", "baseBranch 不是合法的分支名");
    }
    const modelId = str(input.modelId, "modelId", 100);
    if (modelId && !MODEL_ID_RE.test(modelId)) throw coded("invalid", "modelId 不合法");
    return {
      requestId,
      repo,
      baseBranch,
      task: str(input.task, "task", 20_000),
      modelId,
      installCommand: str(input.installCommand, "installCommand", 4_000),
      name: str(input.name, "name", 80),
    };
  }

  /** Default branch of `repo`: listRepos entry first, then the caller's baseBranch, then a main / master probe. */
  async function resolveDefaultBranch(repo, fallback) {
    try {
      const repos = await github.listRepos({ limit: 300 });
      const hit = repos.find((r) => r.fullName?.toLowerCase() === repo.toLowerCase());
      if (hit?.defaultBranch) return hit.defaultBranch;
    } catch (e) {
      if (!fallback) throw e;
    }
    if (fallback) return fallback;
    for (const candidate of ["main", "master"]) {
      if (await github.getBranch(repo, candidate)) return candidate;
    }
    throw coded("not_found", `无法确定 ${repo} 的默认分支，请指定 baseBranch`);
  }

  const findByRequestId = (requestId) => store.workspaces.list({ includeArchived: true }).find((w) => w.requestId === requestId);

  async function create(input) {
    const n = normalize(input);
    const payloadHash = sha256(JSON.stringify([n.repo, n.baseBranch, n.task, n.modelId, n.installCommand, n.name]));
    const began = store.requests.begin({ scope: "workspace.create", requestId: n.requestId, payloadHash });
    if (began.conflict) throw coded("conflict", "请求编号已被不同内容使用");

    // Same request again (including one that died between requests.begin and workspaces.create): look at the
    // workspace table, not at `created`, to decide whether there is anything left to create.
    const existing = findByRequestId(n.requestId);
    if (existing) return existing;

    const known = store.projects.getByRepo(n.repo);
    const defaultBranch = known?.defaultBranch ?? (await resolveDefaultBranch(n.repo, n.baseBranch ?? undefined));
    const baseBranch = n.baseBranch ?? defaultBranch;
    const project = store.projects.upsert({
      repo: n.repo,
      defaultBranch,
      ...(n.installCommand ? { installCommand: n.installCommand } : {}),
    });

    const repoName = n.repo.slice(n.repo.indexOf("/") + 1);
    const slug = slugify(n.task) || slugify(repoName) || "work";
    const hex = sha256(n.requestId).slice(0, 6);
    const model = n.modelId ? { provider: modelDefault().provider, modelId: n.modelId } : modelDefault();
    const { workspace, created } = store.workspaces.create({
      requestId: n.requestId,
      projectId: project.id,
      name: n.name ?? (n.task ? n.task.split("\n")[0].slice(0, 60) : repoName),
      baseBranch,
      branch: `tarsbot/${slug}-${hex}`,
      cwd: `${homeDir()}/workspace/${repoName}`,
      model,
      task: n.task,
    });
    if (created) schedule(workspace.id);
    return workspace;
  }

  // ---- retry / resume -----------------------------------------------------------------------------------------------
  function retry(id) {
    const ws = store.workspaces.get(id);
    if (!ws) throw coded("not_found", `工作区不存在：${id}`);
    if (ws.status === "archived") return ws;
    if (ws.status === "ready") {
      if (taskPending(ws)) schedule(id); // only re-sends a first task that never completed
      return ws;
    }
    for (const s of store.workspaces.steps(id)) {
      if (s.state === "failed" || s.state === "unknown") store.workspaces.setStep(id, s.step, { state: "pending" });
    }
    store.workspaces.update(id, { status: "preparing", error: null });
    schedule(id);
    return store.workspaces.get(id);
  }

  /**
   * Continue every unfinished workspace: status `preparing`, or `ready` with a first task that never completed.
   * Call it BEFORE harness.resume() (PLAN §3.6). The runs are queued per workspace and may take minutes (clone,
   * install), so by default the returned promise resolves once they are QUEUED, which is what keeps server start-up
   * from blocking on the network. Pass `{ wait: true }` (or `await svc.idle()`) to wait for them to finish.
   */
  async function resumePending({ wait = false } = {}) {
    const todo = store.workspaces.list().filter((w) => w.status === "preparing" || (w.status === "ready" && taskPending(w)));
    const runs = todo.map((w) => run(w.id));
    for (const p of runs) p.catch((e) => note({ ev: "run.error", error: sanitize(e?.message) }));
    if (wait) await Promise.allSettled(runs);
  }

  /** Resolves when no run is in flight (tests, graceful shutdown). */
  async function idle() {
    while (chains.size > 0) await Promise.allSettled([...chains.values()]);
  }

  return {
    create,
    run,
    retry,
    resumePending,
    idle,
    get: (id) => store.workspaces.get(id),
    list: () => store.workspaces.list(),
    workspaceInstructions,
  };
}
