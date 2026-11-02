// Delegation (AMP13-delegation): the product "委派子任务" panel backend.
// A human delegates an explicit task to a CHILD session: a fresh conversation (no inherited history)
// on the SAME Sprite (same runtime binding as its workspace) in its OWN worktree on its OWN
// tarsbot/task-* branch — children never write into the parent's directory. The parent stays the
// human's session; results flow back only when the human explicitly reads them (idle is never
// treated as done). Depth and child count are bounded; child instructions forbid push/PR.
//
//   GET  /api/bots/:id/delegation                    -> {parent, tasks}
//   POST /api/bots/:id/delegation {task, base?, contextPaths?}   -> {task}
//   POST /api/delegation/:taskId/message {message}               -> {ok}
//   POST /api/delegation/:taskId/read    {note?}                 -> {result:{...}}
//   POST /api/bots/:id/delegation/file   {path}                  -> {file:{...}}
//
// Needs app.ctx.bots (always present), app.ctx.control, app.ctx.workspaces and app.ctx.runtimeBash;
// like the other workspace routes, nothing is registered without them (one console.warn).
// All paths are server-decided (Bot record / workspace record), never client-supplied.
import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../api.mjs";
import { ctx } from "../harness.mjs";
import { shellQuote } from "../env.mjs";
import { Preamble } from "../ext/preamble.mjs";
import { CHILD_BRANCH_RE, MAX_CHILDREN, MAX_DEPTH, MAX_RESULTS, MAX_TEXT_CHARS, RESULT_INLINE_CHARS, RESULT_STORED_CHARS, readWorktreeFile } from "../delegation-env.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const posixDir = (p) => p.replace(/\/[^/]*$/, "") || "/";
const KIND = "delegation";

let warned = false;

/** Safety rules for delegation children. The general preamble (push/PR workflow) is removed; the
 * rules that still matter are restated on the record so a child can never open a push/PR workflow. */
const CHILD_RULES = [
  "Delegation safety rules (the general git/PR workflow is removed for this session; these rules apply instead):",
  "- Never print, echo, log or write any credential or token (GH_TOKEN, or any other secret in the environment). Do not run env, printenv, set, `git config --list`, `gh auth status` or `gh auth login`.",
  "- Never force-push (--force, -f, --force-with-lease, +refspec), never delete remote branches or tags, never merge or close a pull request, never change repository settings.",
  "- This session does not push and does not open pull requests: do not run `git push`, `gh pr create` or `gh pr merge`.",
  "- If a command is denied by approval, stop that operation, report exactly what was denied, and do not retry it in another form.",
].join("\n");

function jsonObject(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  return body;
}

function optString(obj, key, max) {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${key} is too long (max ${max} characters)`);
  return t || undefined;
}

export function register(app) {
  const { workspaces, control, bots } = app.ctx;
  if (!workspaces || !control || !bots) {
    if (!warned) {
      warned = true;
      console.warn("routes/delegation: app.ctx.workspaces / control / bots is not set, delegation routes are not registered");
    }
    return;
  }

  function botOr404(id) {
    const bot = bots.get(id);
    if (!bot) throw new HttpError(404, `bot not found: ${id}`);
    return bot;
  }

  /** The workspace a bot's conversation is linked to; it must be ready with an active binding. */
  function workspaceOf(bot) {
    const ws = control.links.workspaceOf(String(bot.conversationId));
    if (!ws) throw new HttpError(409, `session ${bot.id} has no workspace link`);
    if (ws.status !== "ready") throw new HttpError(409, `workspace is not ready (status: ${ws.status})`);
    if (!control.bindings.current(ws.id)) throw new HttpError(409, "workspace has no active runtime binding");
    return ws;
  }

  async function spriteBash(ws) {
    if (typeof app.ctx.runtimeBash !== "function") throw new HttpError(503, "runtime bash is not available");
    try {
      return await app.ctx.runtimeBash(ws.id);
    } catch (e) {
      throw new HttpError(409, `runtime unavailable: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  /** The directory a session actually works in: its own recorded worktree, else the workspace repo dir.
   * Never a client-supplied path. Order matters: a delegation child declares `worktree` (shared shape),
   * not issueLoop; issueLoop/review stay first for their own sessions. */
  function sessionDir(bot, ws) {
    const dir = bot.issueLoop?.dir ?? bot.worktree?.dir ?? bot.review?.dir ?? bot.loopRun?.dir ?? ws.cwd;
    if (typeof dir !== "string" || !dir.startsWith("/")) throw new HttpError(409, `session ${bot.id} has no usable worktree directory`);
    return dir;
  }

  /** The task record this bot owns (stored on the Bot record under `delegation.tasks`). */
  function taskOr404(bot, taskId) {
    const task = (bot.delegation?.tasks ?? []).find((t) => t.id === taskId);
    if (!task) throw new HttpError(404, `delegation task not found: ${taskId}`);
    return task;
  }

  /** 40-hex SHA; the resolved worktree pin must match or creation stops. */
  const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

  async function submitText(bot, content) {
    const conv = await bots.conversation(bot.id);
    if (!conv) throw new HttpError(404, `conversation not found for bot: ${bot.name}`);
    return conv.submit({ type: "input", content }, ctx);
  }

  // Best-effort LAST assistant text of a child conversation. `conv.entries` returns the newest entries
  // first: scanning in order and stopping at the first real assistant text finds the newest one; never
  // index items.at(-1) (that would be the oldest entry, and may not be an assistant message at all).
  // null when unreadable — the caller states 未取得, never a fake "done".
  async function lastAssistantText(childBot) {
    try {
      const conv = await bots.conversation(childBot.id);
      if (!conv) return null;
      let cursor;
      do {
        const page = await conv.entries({}, 200, cursor, ctx);
        for (const entry of page.items ?? []) {
          const text = (entry.model ?? [])
            .filter((message) => message.role === "assistant")
            .flatMap((message) => typeof message.content === "string" ? [message.content] :
              (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text))
            .join("\n").trim();
          if (text) return text;
        }
        cursor = page.next;
      } while (cursor);
      return null;
    } catch {
      return null;
    }
  }

  /** Busy/queued of a session; null when unreadable — the client must not show "idle" then. */
  async function liveState(bot) {
    try {
      const conv = await bots.conversation(bot.id);
      if (!conv) return { busy: null, queued: null };
      const view = await conv.viewState(ctx);
      try {
        const docs = view.value?.docs ?? {};
        return { busy: docs["pi.live"]?.run != null, queued: docs["pi.inbox"]?.items?.length ?? 0 };
      } finally {
        view.dispose?.();
      }
    } catch {
      return { busy: null, queued: null };
    }
  }

  function childView(bot) {
    if (!bot) return { exists: false };
    return {
      exists: true,
      botId: bot.id,
      name: bot.name,
      status: bot.status ?? null,
      busy: null, // filled by the caller when needed (live read); records never claim idle
    };
  }

  /** A task as the client sees it: record fields + the child's current business status. */
  async function taskView(bot, task) {
    const child = bots.get(task.childBotId);
    const live = child ? await liveState(child) : { busy: null, queued: null };
    return {
      id: task.id,
      task: task.task,
      state: task.state,
      createdAt: task.createdAt,
      base: task.base,
      branch: task.branch ?? null,
      dir: task.dir ?? null,
      pinnedSha: task.pinnedSha ?? null,
      error: task.error ?? null,
      result: task.result ? { summary: task.result.summary, truncated: task.result.truncated, readAt: task.result.readAt } : null,
      child: child ? { ...childView(child), busy: live.busy, queued: live.queued } : { exists: false, botId: task.childBotId },
    };
  }

  /** Persist a delegation patch on a Bot record; `bots.update` is widened for the `delegation` key. */
  function saveDelegation(botId, delegation) {
    if (typeof bots.update !== "function") throw new HttpError(503, "bot registry cannot persist delegation state");
    const updated = bots.update(botId, { delegation });
    if (!updated) throw new HttpError(404, `bot not found: ${botId}`);
    return updated;
  }

  // GET /api/bots/:id/delegation — the panel's data: parent facts + every delegation task (newest last).
  app.get("/api/bots/:id/delegation", async (_req, _res, { params }) => {
    const bot = botOr404(params.id);
    const ws = control.links.workspaceOf(String(bot.conversationId));
    if (!ws) throw new HttpError(409, `session ${bot.id} has no workspace link`);
    const depth = bot.delegation?.depth ?? 0;
    const tasks = [];
    for (const t of bot.delegation?.tasks ?? []) tasks.push(await taskView(bot, t));
    return {
      parent: {
        botId: bot.id,
        name: bot.name,
        depth,
        canDelegate: ws.status === "ready" && depth < MAX_DEPTH && !bot.readOnly && !bot.loopRun,
        dir: sessionDir(bot, ws),
        workspaceId: ws.id,
        maxChildren: MAX_CHILDREN,
        maxDepth: MAX_DEPTH,
      },
      tasks,
    };
  });

  // POST /api/bots/:id/delegation {task, base?, contextPaths?} — create the child session.
  app.post("/api/bots/:id/delegation", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const task = optString(b, "task", 4_000);
    if (!task) throw new HttpError(400, "task is required");
    const parent = botOr404(params.id);
    if (parent.readOnly) throw new HttpError(409, "read-only sessions cannot delegate");
    // Issue14: a Loop-run session is capability-restricted (loopRun); delegating would create a full-permission
    // child session outside the run's boundary — forbidden. The human creates a normal session to delegate.
    if (parent.loopRun?.runId) throw new HttpError(409, "loop-run sessions cannot delegate (capability boundary)");
    const ws = workspaceOf(parent);
    const dir = sessionDir(parent, ws);
    const delegation = parent.delegation ?? { tasks: [], results: [], depth: 0 };
    const depth = delegation.depth ?? 0;
    if (depth >= MAX_DEPTH) throw new HttpError(409, `delegation depth limit reached (${MAX_DEPTH}); this session is itself a child`);
    if ((delegation.tasks ?? []).length >= MAX_CHILDREN) throw new HttpError(409, `child limit reached (${MAX_CHILDREN}) for this session`);

    // Optional user-picked small files from inside the session's worktree / workspace repo dir.
    const paths = b.contextPaths === undefined || b.contextPaths === null ? [] : b.contextPaths;
    if (!Array.isArray(paths) || paths.length > 8) throw new HttpError(400, "contextPaths must be an array of at most 8 paths");
    const base = optString(b, "base", 120);
    if (base && !/^[0-9a-f]{7,40}$|^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base)) throw new HttpError(400, "base must be a SHA or a branch name");

    const bash = await spriteBash(ws);
    const sh = async (command, timeoutMs = 120_000) => {
      const r = await bash(command, { timeoutMs });
      if (r?.timedOut) throw new HttpError(500, "sprite command timed out");
      if (r?.exitCode !== 0) throw new HttpError(500, `sprite command failed (${r?.exitCode}): ${String(r?.stderr ?? r?.stdout ?? "").trim().slice(0, 300)}`);
      return String(r?.stdout ?? "").trim();
    };

    const files = [];
    for (const p of paths) {
      if (typeof p !== "string" || !p.trim()) throw new HttpError(400, "contextPaths entries must be non-empty strings");
      const f = await readWorktreeFile({ bash, dir, workspaceCwd: ws.cwd, path: p }).catch((e) => {
        throw new HttpError(e?.code === "too_large" ? 413 : 400, String(e?.message ?? e).slice(0, 300));
      });
      files.push({ path: f.path, size: f.size, content: f.content });
    }

    const taskId = `dt_${randomUUID().slice(0, 8)}`;
    const dirId = sha256(`${ws.id}:${parent.id}:${taskId}`).slice(0, 8);
    const branch = `tarsbot/task-${dirId}`;
    const childDir = `${app.ctx.homeDir?.() ?? "/home/sprite"}/delegation/${ws.id}/task-${dirId}`;

    // Record the attempt first: a worktree/model failure is a visible task record, not a silent no-op.
    const record = { id: taskId, task, state: "creating", createdAt: new Date().toISOString(), base: base ?? null };
    saveDelegation(parent.id, { ...delegation, tasks: [...(delegation.tasks ?? []), record] });

    try {
      // The child gets its own worktree + its own branch off the parent's pinned baseline (or HEAD when
      // none is recorded — HEAD of the workspace repo, never a client path). The parent's checkout is never touched.
      const baseRef = base ?? parent.issueLoop?.pinnedSha ?? parent.worktree?.pinnedSha ?? parent.review?.headSha ?? parent.loopRun?.pinnedSha ?? "HEAD";
      // Resolve the base to its ACTUAL commit SHA first: the recorded pinnedSha is the source of truth for every
      // reader (Header branch label, EnvironmentPane, Files/Git panels), so a symbolic base or a stale record is
      // resolved once, here — never re-derived by a client.
      const resolvedSha = await sh(`git -C ${shellQuote([ws.cwd])} rev-parse --verify ${shellQuote([`${baseRef}^{commit}`])}`);
      if (!FULL_SHA_RE.test(resolvedSha)) throw new HttpError(500, `could not resolve ${baseRef} to a commit SHA`);
      await sh(
        `mkdir -p ${shellQuote([posixDir(childDir)])} && git -C ${shellQuote([ws.cwd])} worktree add -b ${shellQuote([branch])} ${shellQuote([childDir])} ${shellQuote([resolvedSha])}`,
      );
      if (!CHILD_BRANCH_RE.test(branch)) throw new HttpError(500, "internal: child branch name failed safety pattern");

      const contextBlock = files.length
        ? files.map((f) => [`== 附件（用户选择，来源 ${f.path}，${f.size} bytes）==`, f.content].join("\n")).join("\n\n")
        : "（无附件；只携带任务文本。需要更多上下文时直接向用户索要，不要假设存在其他会话的历史。）";
      const name = `task-${dirId}`;
      const childModel = (parent.model && typeof parent.model === "object" && typeof parent.model.provider === "string" && typeof parent.model.modelId === "string")
        ? { provider: parent.model.provider, modelId: "swe-2" }
        : ws.model ?? parent.model;
      const message = [
        `委派子任务（delegation）。你是会话 “${parent.name}” 的子任务执行者：独立 worktree ${childDir}，分支 ${branch}。`,
        ``,
        `== 任务 ==`,
        task,
        ``,
        contextBlock,
        ``,
        `== 边界 ==`,
        `- 工作目录只有 ${childDir}：不要进入或修改父会话的目录 ${dir}，不要改动 ${ws.cwd} 的当前检出。`,
        `- 完成后回复一段结果摘要（改了什么、验证结果、值得注意的风险）；父会话由用户显式读取结果，不要认为「不再忙碌」就是已交付。`,
        ``,
        `== 安全规则 ==`,
        CHILD_RULES,
      ].join("\n");

      const child = await bots.createBot({
        name,
        model: childModel,
        thinkingLevel: "high",
        cwd: childDir,
        instructions: `委派子任务 Session：分支 ${branch}，工作目录 ${childDir}。按任务执行，完成后输出结果摘要。\n${CHILD_RULES}`,
        extensions: { remove: [Preamble] },
        workspaceId: ws.id,
        status: "executing",
        // Shared session-worktree metadata: the same shape every other reader already understands
        // (EnvironmentPane / SessionHeader / Files-Git resolution). pinnedSha is the ACTUAL resolved
        // commit, branch is the child's own tarsbot/task-* branch.
        worktree: { dir: childDir, pinnedSha: resolvedSha, baseBranch: parent.issueLoop?.baseBranch ?? parent.worktree?.baseBranch ?? ws.baseBranch ?? "main", branch },
        delegation: {
          role: "child",
          parentBotId: parent.id,
          taskId,
          depth: depth + 1,
        },
      });
      control.links.link({ conversationId: String(child.conversationId), workspaceId: ws.id, botId: child.id });
      await submitText(child, message);

      const stored = bots.get(parent.id);
      const tasks = (stored.delegation?.tasks ?? []).map((t) =>
        t.id === taskId ? { ...t, state: "running", childBotId: child.id, branch, dir: childDir, pinnedSha: resolvedSha } : t,
      );
      saveDelegation(parent.id, { ...stored.delegation, tasks });
      return { task: await taskView(stored, tasks.find((t) => t.id === taskId)) };
    } catch (e) {
      const stored = bots.get(parent.id);
      if (stored) {
        const tasks = (stored.delegation?.tasks ?? []).map((t) => (t.id === taskId ? { ...t, state: "failed", error: String(e?.message ?? e).slice(0, 300) } : t));
        try {
          saveDelegation(parent.id, { ...stored.delegation, tasks });
        } catch {
          // record update is best-effort; the original error is the response
        }
      }
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, String(e?.message ?? e).slice(0, 300));
    }
  });

  // POST /api/delegation/:taskId/message {message} — an explicit user message into an existing child.
  app.post("/api/delegation/:taskId/message", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const message = optString(b, "message", MAX_TEXT_CHARS);
    if (!message) throw new HttpError(400, "message is required");
    const owner = bots.list().find((x) => (x.delegation?.tasks ?? []).some((t) => t.id === params.taskId));
    if (!owner) throw new HttpError(404, `delegation task not found: ${params.taskId}`);
    const task = taskOr404(owner, params.taskId);
    const child = task.childBotId ? bots.get(task.childBotId) : undefined;
    if (!child) throw new HttpError(409, `task ${params.taskId} has no child session to message`);
    // Follow-ups go through the same authenticated input path as any user message (whenBusy defaults).
    await submitText(child, `来自父会话用户的跟进消息：\n${message}`);
    return { ok: true, childBotId: child.id };
  });

  // POST /api/delegation/:taskId/read {note?} — the human reads the child's result; a summary goes back
  // into the PARENT conversation and is stored on the task record. Never auto-fired by idle.
  app.post("/api/delegation/:taskId/read", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const note = optString(b, "note", 2_000);
    const owner = bots.list().find((x) => (x.delegation?.tasks ?? []).some((t) => t.id === params.taskId));
    if (!owner) throw new HttpError(404, `delegation task not found: ${params.taskId}`);
    const task = taskOr404(owner, params.taskId);
    if (task.state === "failed") throw new HttpError(409, `task ${params.taskId} failed during creation: ${task.error ?? "unknown error"}`);
    const child = task.childBotId ? bots.get(task.childBotId) : undefined;
    if (!child) throw new HttpError(409, `task ${params.taskId} has no child session`);
    const results = owner.delegation?.results ?? [];
    if (results.length >= MAX_RESULTS) throw new HttpError(409, `result buffer is full (${MAX_RESULTS})`);

    const summary = await lastAssistantText(child);
    const live = await liveState(child);
    const result = {
      taskId: task.id,
      childBotId: child.id,
      childName: child.name,
      summary: summary ? summary.slice(0, RESULT_STORED_CHARS) : "（未取得：子会话没有可读的 assistant 回复；空闲不代表完成，请打开子会话确认）",
      truncated: summary ? summary.length > RESULT_STORED_CHARS : false,
      readAt: new Date().toISOString(),
      // Explicitly the live signal at read time: the human sees whether the child was still running.
      childBusyAtRead: live.busy,
      ...(note ? { note } : {}),
    };

    // Back to the parent conversation as a visible user message; a truncated summary is stated, not hidden.
    const inline = result.summary.length > RESULT_INLINE_CHARS ? `${result.summary.slice(0, RESULT_INLINE_CHARS)}\n…（结果较长，已在任务记录中保留更多；打开子会话查看全部）` : result.summary;
    const busyNote = live.busy === true ? "（读取时子会话仍在运行；这是当前可见的最后回复，不是完成确认）" : live.busy === null ? "（读取时无法判断子会话是否仍在运行）" : "（读取时子会话无进行中的运行）";
    const childWs = control.links.workspaceOf(String(child.conversationId));
    const childDir = task.dir ?? sessionDir(child, childWs ?? {});
    const parentMessage = [
      `子任务结果（delegation read，用户显式读取）。${busyNote}`,
      `子会话：${child.name}（分支 ${task.branch ?? "?"}，目录 ${childDir}）`,
      `任务：${task.task.slice(0, 500)}`,
      ...(note ? [`备注：${note}`] : []),
      ``,
      inline,
    ].join("\n");
    await submitText(owner, parentMessage);

    const stored = bots.get(owner.id);
    const tasks = (stored.delegation?.tasks ?? []).map((t) =>
      t.id === task.id ? { ...t, state: "read", result: { summary: result.summary, truncated: result.truncated, readAt: result.readAt } } : t,
    );
    saveDelegation(owner.id, { ...stored.delegation, tasks, results: [...results, result] });
    return { result };
  });

  // POST /api/bots/:id/delegation/file {path} — read one user-picked file from the session's worktree.
  app.post("/api/bots/:id/delegation/file", async (_req, _res, { params, body }) => {
    const b = jsonObject(body);
    const bot = botOr404(params.id);
    const ws = workspaceOf(bot);
    const dir = sessionDir(bot, ws);
    const bash = await spriteBash(ws);
    const f = await readWorktreeFile({ bash, dir, workspaceCwd: ws.cwd, path: b.path }).catch((e) => {
      if (e?.code === "too_large") throw new HttpError(413, e.message);
      if (e?.code === "invalid") throw new HttpError(400, e.message);
      throw new HttpError(409, String(e?.message ?? e).slice(0, 300));
    });
    return { file: { path: f.path, size: f.size, content: f.content } };
  });
}
