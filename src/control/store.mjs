// 控制库对外 API（M1-01）。签名以 docs/M1-PLAN.md §4.1 为准。
// 单进程单写者；所有写操作都是同步事务；不读环境变量、不 import config.mjs。
import { randomBytes } from "node:crypto";
import { openControlDb, STEPS } from "./db.mjs";

/** loop_runs terminal statuses: a run in one of these never transitions again (B1 fix: canceled/failed/succeeded
 *  must not be revived by a late in-flight write). */
const RUN_TERMINAL = new Set(["succeeded", "failed", "canceled", "skipped"]);

export class ControlStoreError extends Error {
  /** @param {"conflict"|"not_found"|"invalid"} code */
  constructor(code, message) {
    super(message);
    this.name = "ControlStoreError";
    this.code = code;
  }
}

const newId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;
const toJson = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const fromJson = (s) => (s === null || s === undefined ? null : JSON.parse(s));

function must(cond, code, message) {
  if (!cond) throw new ControlStoreError(code, message);
}

export function openControlStore({ path = null, now = Date.now } = {}) {
  const db = openControlDb({ path });
  const iso = () => new Date(now()).toISOString();

  // 事务封装：允许嵌套（内层直接并入外层事务）。
  let depth = 0;
  function tx(fn) {
    if (depth > 0) return fn();
    db.exec("BEGIN IMMEDIATE");
    depth++;
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务已失效
      }
      throw err;
    } finally {
      depth--;
    }
  }

  const q = (sql) => db.prepare(sql);

  // ---------------------------------------------------------------- projects
  const projectRow = (r) =>
    r && {
      id: r.id,
      repo: r.repo,
      defaultBranch: r.default_branch,
      installCommand: r.install_command,
      testCommand: r.test_command,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };

  const projects = {
    upsert({ repo, defaultBranch, installCommand, testCommand }) {
      must(typeof repo === "string" && repo, "invalid", "repo 必填");
      must(typeof defaultBranch === "string" && defaultBranch, "invalid", "defaultBranch 必填");
      return tx(() => {
        const t = iso();
        const existing = q("SELECT * FROM projects WHERE repo = ?").get(repo);
        if (!existing) {
          const id = newId("prj");
          q(
            "INSERT INTO projects (id, repo, default_branch, install_command, test_command, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(id, repo, defaultBranch, installCommand ?? null, testCommand ?? null, t, t);
          return projects.get(id);
        }
        // undefined 表示保持原值；null 表示清空
        const install = installCommand === undefined ? existing.install_command : installCommand;
        const test = testCommand === undefined ? existing.test_command : testCommand;
        q("UPDATE projects SET default_branch = ?, install_command = ?, test_command = ?, updated_at = ? WHERE id = ?").run(
          defaultBranch,
          install,
          test,
          t,
          existing.id,
        );
        return projects.get(existing.id);
      });
    },
    get: (id) => projectRow(q("SELECT * FROM projects WHERE id = ?").get(id)),
    getByRepo: (repo) => projectRow(q("SELECT * FROM projects WHERE repo = ?").get(repo)),
    list: () => q("SELECT * FROM projects ORDER BY created_at, rowid").all().map(projectRow),
  };

  // -------------------------------------------------------------- workspaces
  const WS_SELECT = "SELECT w.*, p.repo AS repo FROM workspaces w JOIN projects p ON p.id = w.project_id";
  const workspaceRow = (r) =>
    r && {
      id: r.id,
      requestId: r.request_id,
      projectId: r.project_id,
      repo: r.repo,
      name: r.name,
      baseBranch: r.base_branch,
      baseCommit: r.base_commit ?? null,
      branch: r.branch,
      cwd: r.cwd,
      model: fromJson(r.model),
      task: r.task ?? null,
      status: r.status,
      error: r.error ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };

  const WS_PATCH_COLUMNS = {
    name: "name",
    baseCommit: "base_commit",
    branch: "branch",
    cwd: "cwd",
    task: "task",
    status: "status",
    error: "error",
  };

  const workspaces = {
    create({ requestId, projectId, name, baseBranch, branch, cwd, model, task }) {
      must(typeof requestId === "string" && requestId, "invalid", "requestId 必填");
      return tx(() => {
        const existing = q(`${WS_SELECT} WHERE w.request_id = ?`).get(requestId);
        if (existing) return { workspace: workspaceRow(existing), created: false };
        must(projects.get(projectId), "not_found", `项目不存在：${projectId}`);
        must(model !== undefined && model !== null, "invalid", "model 必填");
        const id = newId("ws");
        const t = iso();
        q(
          `INSERT INTO workspaces (id, request_id, project_id, name, base_branch, branch, cwd, model, task, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`,
        ).run(id, requestId, projectId, name, baseBranch, branch, cwd, toJson(model), task ?? null, t, t);
        const stepInsert = q("INSERT INTO workspace_steps (workspace_id, step, state) VALUES (?, ?, 'pending')");
        for (const step of STEPS) stepInsert.run(id, step);
        return { workspace: workspaces.get(id), created: true };
      });
    },
    get: (id) => workspaceRow(q(`${WS_SELECT} WHERE w.id = ?`).get(id)),
    list({ includeArchived = false } = {}) {
      const where = includeArchived ? "" : " WHERE w.status != 'archived'";
      return q(`${WS_SELECT}${where} ORDER BY w.created_at, w.rowid`).all().map(workspaceRow);
    },
    update(id, patch = {}) {
      return tx(() => {
        must(workspaces.get(id), "not_found", `工作区不存在：${id}`);
        const sets = [];
        const values = [];
        for (const [key, value] of Object.entries(patch)) {
          if (key === "model") {
            sets.push("model = ?");
            values.push(toJson(value));
          } else if (WS_PATCH_COLUMNS[key]) {
            sets.push(`${WS_PATCH_COLUMNS[key]} = ?`);
            values.push(value ?? null);
          } else {
            throw new ControlStoreError("invalid", `不可更新的工作区字段：${key}`);
          }
        }
        sets.push("updated_at = ?");
        values.push(iso(), id);
        q(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...values);
        return workspaces.get(id);
      });
    },
    archive: (id) => workspaces.update(id, { status: "archived" }),
    setStep(id, step, { state, error } = {}) {
      return tx(() => {
        must(workspaces.get(id), "not_found", `工作区不存在：${id}`);
        must(STEPS.includes(step), "invalid", `未知步骤：${step}`);
        const t = iso();
        // 状态值合法性由表的 CHECK 约束兜底
        const prev = q("SELECT * FROM workspace_steps WHERE workspace_id = ? AND step = ?").get(id, step);
        let startedAt = prev?.started_at ?? null;
        let finishedAt = null;
        if (state === "pending") startedAt = null;
        else if (state === "running") startedAt = t;
        else finishedAt = t;
        q("UPDATE workspace_steps SET state = ?, error = ?, started_at = ?, finished_at = ? WHERE workspace_id = ? AND step = ?").run(
          state,
          error ?? null,
          startedAt,
          finishedAt,
          id,
          step,
        );
        q("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(t, id);
        return workspaces.steps(id).find((s) => s.step === step);
      });
    },
    steps(id) {
      const rows = q("SELECT * FROM workspace_steps WHERE workspace_id = ?").all(id);
      return rows
        .map((r) => ({
          step: r.step,
          state: r.state,
          error: r.error ?? null,
          startedAt: r.started_at ?? null,
          finishedAt: r.finished_at ?? null,
        }))
        .sort((a, b) => STEPS.indexOf(a.step) - STEPS.indexOf(b.step));
    },
  };

  // ---------------------------------------------------------------- bindings
  const bindingRow = (r) =>
    r && {
      id: r.id,
      workspaceId: r.workspace_id,
      provider: r.provider,
      runtimeId: r.runtime_id,
      version: r.version,
      state: r.state,
      createdAt: r.created_at,
      replacedAt: r.replaced_at ?? null,
    };

  const bindings = {
    bind(workspaceId, { provider, runtimeId }) {
      must(typeof provider === "string" && provider, "invalid", "provider 必填");
      must(typeof runtimeId === "string" && runtimeId, "invalid", "runtimeId 必填");
      return tx(() => {
        must(workspaces.get(workspaceId), "not_found", `工作区不存在：${workspaceId}`);
        const t = iso();
        const max = q("SELECT MAX(version) AS v FROM runtime_bindings WHERE workspace_id = ?").get(workspaceId).v ?? 0;
        // 先置旧的为 replaced，再插入新的 active（部分唯一索引保证至多一个 active）
        q("UPDATE runtime_bindings SET state = 'replaced', replaced_at = ? WHERE workspace_id = ? AND state = 'active'").run(t, workspaceId);
        const res = q(
          "INSERT INTO runtime_bindings (workspace_id, provider, runtime_id, version, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
        ).run(workspaceId, provider, runtimeId, max + 1, t);
        q("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(t, workspaceId);
        return bindingRow(q("SELECT * FROM runtime_bindings WHERE id = ?").get(Number(res.lastInsertRowid)));
      });
    },
    current: (workspaceId) =>
      bindingRow(q("SELECT * FROM runtime_bindings WHERE workspace_id = ? AND state = 'active'").get(workspaceId)),
    history: (workspaceId) =>
      q("SELECT * FROM runtime_bindings WHERE workspace_id = ? ORDER BY version").all(workspaceId).map(bindingRow),
  };

  // ------------------------------------------------------------------- links
  const linkRow = (r) =>
    r && {
      conversationId: r.conversation_id,
      workspaceId: r.workspace_id,
      botId: r.bot_id ?? null,
      createdAt: r.created_at,
    };

  const links = {
    /** 同会话同工作区重复调用幂等（返回原记录）；关联到不同工作区抛 conflict。 */
    link({ conversationId, workspaceId, botId }) {
      must(typeof conversationId === "string" && conversationId, "invalid", "conversationId 必填");
      return tx(() => {
        const existing = q("SELECT * FROM conversation_links WHERE conversation_id = ?").get(conversationId);
        if (existing) {
          if (existing.workspace_id !== workspaceId) {
            throw new ControlStoreError("conflict", `会话 ${conversationId} 已关联到工作区 ${existing.workspace_id}`);
          }
          if (existing.bot_id == null && botId) {
            q("UPDATE conversation_links SET bot_id = ? WHERE conversation_id = ?").run(botId, conversationId);
          }
          return linkRow(q("SELECT * FROM conversation_links WHERE conversation_id = ?").get(conversationId));
        }
        must(workspaces.get(workspaceId), "not_found", `工作区不存在：${workspaceId}`);
        q("INSERT INTO conversation_links (conversation_id, workspace_id, bot_id, created_at) VALUES (?, ?, ?, ?)").run(
          conversationId,
          workspaceId,
          botId ?? null,
          iso(),
        );
        return linkRow(q("SELECT * FROM conversation_links WHERE conversation_id = ?").get(conversationId));
      });
    },
    /** 返回会话所属的 Workspace 对象；没有关联时返回 undefined。 */
    workspaceOf(conversationId) {
      const r = q(`${WS_SELECT} JOIN conversation_links l ON l.workspace_id = w.id WHERE l.conversation_id = ?`).get(conversationId);
      return workspaceRow(r);
    },
    /** 返回该工作区的关联记录数组 [{conversationId, workspaceId, botId, createdAt}]。 */
    conversationsOf: (workspaceId) =>
      q("SELECT * FROM conversation_links WHERE workspace_id = ? ORDER BY created_at, rowid").all(workspaceId).map(linkRow),
    /** The link record of one conversation ({conversationId, workspaceId, botId}) — undefined when unlinked. */
    ofConversation: (conversationId) =>
      linkRow(q("SELECT * FROM conversation_links WHERE conversation_id = ?").get(String(conversationId))),
  };

  // ----------------------------------------------------------------- intents
  const INTENT_SETTLE_STATES = ["sent", "confirmed", "failed", "unknown"];
  const intentRow = (r) =>
    r && {
      id: r.id,
      requestId: r.request_id,
      kind: r.kind,
      target: r.target,
      workspaceId: r.workspace_id ?? null,
      state: r.state,
      evidence: fromJson(r.evidence),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };

  const intents = {
    begin({ requestId, kind, target, workspaceId }) {
      must(typeof requestId === "string" && requestId, "invalid", "requestId 必填");
      must(typeof kind === "string" && kind, "invalid", "kind 必填");
      must(typeof target === "string" && target, "invalid", "target 必填");
      return tx(() => {
        const existing = q("SELECT * FROM intents WHERE request_id = ?").get(requestId);
        if (existing) return { intent: intentRow(existing), created: false };
        const t = iso();
        q("INSERT INTO intents (request_id, kind, target, workspace_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'planned', ?, ?)").run(
          requestId,
          kind,
          target,
          workspaceId ?? null,
          t,
          t,
        );
        return { intent: intents.get(requestId), created: true };
      });
    },
    /** 状态 sent（已发出）/ confirmed / failed / unknown；evidence 为任意 JSON，省略则保留原值。 */
    settle(requestId, { state, evidence } = {}) {
      must(INTENT_SETTLE_STATES.includes(state), "invalid", `意图状态不合法：${state}`);
      return tx(() => {
        const existing = q("SELECT * FROM intents WHERE request_id = ?").get(requestId);
        must(existing, "not_found", `意图不存在：${requestId}`);
        const ev = evidence === undefined ? existing.evidence : toJson(evidence);
        q("UPDATE intents SET state = ?, evidence = ?, updated_at = ? WHERE request_id = ?").run(state, ev, iso(), requestId);
        return intents.get(requestId);
      });
    },
    /** 便捷封装：settle(requestId, {state: "sent"}) */
    markSent: (requestId, evidence) => intents.settle(requestId, { state: "sent", evidence }),
    get: (requestId) => intentRow(q("SELECT * FROM intents WHERE request_id = ?").get(requestId)),
    list({ state, kind } = {}) {
      const where = [];
      const params = [];
      if (state !== undefined) {
        where.push("state = ?");
        params.push(state);
      }
      if (kind !== undefined) {
        where.push("kind = ?");
        params.push(kind);
      }
      const sql = `SELECT * FROM intents${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
      return q(sql).all(...params).map(intentRow);
    },
  };

  // -------------------------------------------------------------------- meta
  const meta = {
    get(key) {
      const r = q("SELECT value FROM meta WHERE key = ?").get(key);
      return r ? JSON.parse(r.value) : undefined;
    },
    /** 首次调用写入 makeValue() 并返回；之后一律返回已有值（同一事务内完成）。 */
    ensure(key, makeValue) {
      return tx(() => {
        const r = q("SELECT value FROM meta WHERE key = ?").get(key);
        if (r) return JSON.parse(r.value);
        const value = makeValue();
        must(value !== undefined, "invalid", `meta.ensure(${key}) 的 makeValue 返回了 undefined`);
        q("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
        return value;
      });
    },
    /** generation 加一并返回新值（从备份恢复到新部署时用）；尚无 generation 时按初始值 1 计，结果为 2。 */
    bumpGeneration() {
      return tx(() => {
        const cur = meta.get("generation") ?? 1;
        must(Number.isInteger(cur), "invalid", "generation 不是整数");
        const next = cur + 1;
        q("INSERT INTO meta (key, value) VALUES ('generation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
          JSON.stringify(next),
        );
        return next;
      });
    },
  };

  // -------------------------------------------------------------- executions
  const EXEC_PATCH = { state: "state", runtimeId: "runtime_id", bindingVersion: "binding_version", cwd: "cwd", commandHash: "command_hash" };
  const executionRow = (r) =>
    r && {
      runId: r.run_id,
      workspaceId: r.workspace_id,
      runtimeId: r.runtime_id,
      bindingVersion: r.binding_version,
      cwd: r.cwd,
      commandHash: r.command_hash,
      state: r.state,
      exit: fromJson(r.exit_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };

  const executions = {
    claim({ runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash }) {
      must(typeof runId === "string" && runId, "invalid", "runId 必填");
      return tx(() => {
        const existing = q("SELECT * FROM executions WHERE run_id = ?").get(runId);
        if (existing) return { execution: executionRow(existing), created: false };
        const t = iso();
        q(
          `INSERT INTO executions (run_id, workspace_id, runtime_id, binding_version, cwd, command_hash, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
        ).run(runId, workspaceId, runtimeId, bindingVersion, cwd, commandHash, t, t);
        return { execution: executions.get(runId), created: true };
      });
    },
    /** patch 可含 state、exit，以及 runtimeId / bindingVersion / cwd / commandHash。state 取值由表 CHECK 约束。 */
    update(runId, patch = {}) {
      return tx(() => {
        must(executions.get(runId), "not_found", `执行记录不存在：${runId}`);
        const sets = [];
        const values = [];
        for (const [key, value] of Object.entries(patch)) {
          if (key === "exit") {
            sets.push("exit_json = ?");
            values.push(toJson(value));
          } else if (EXEC_PATCH[key]) {
            sets.push(`${EXEC_PATCH[key]} = ?`);
            values.push(value);
          } else {
            throw new ControlStoreError("invalid", `不可更新的执行字段：${key}`);
          }
        }
        sets.push("updated_at = ?");
        values.push(iso(), runId);
        q(`UPDATE executions SET ${sets.join(", ")} WHERE run_id = ?`).run(...values);
        return executions.get(runId);
      });
    },
    get: (runId) => executionRow(q("SELECT * FROM executions WHERE run_id = ?").get(runId)),
    /** 状态不是 exited 的，供重启后核对。 */
    listOpen: () => q("SELECT * FROM executions WHERE state != 'exited' ORDER BY created_at, rowid").all().map(executionRow),
  };

  // ---------------------------------------------------------------- requests
  const requests = {
    /** 首次 → {created:true, conflict:false}；同内容 → {created:false, conflict:false}；不同内容 → {created:false, conflict:true}（不覆盖原记录）。 */
    begin({ scope, requestId, payloadHash }) {
      must(typeof scope === "string" && scope, "invalid", "scope 必填");
      must(typeof requestId === "string" && requestId, "invalid", "requestId 必填");
      must(typeof payloadHash === "string" && payloadHash, "invalid", "payloadHash 必填");
      return tx(() => {
        const existing = q("SELECT payload_hash FROM requests WHERE scope = ? AND request_id = ?").get(scope, requestId);
        if (!existing) {
          q("INSERT INTO requests (scope, request_id, payload_hash, created_at) VALUES (?, ?, ?, ?)").run(scope, requestId, payloadHash, iso());
          return { created: true, conflict: false };
        }
        return { created: false, conflict: existing.payload_hash !== payloadHash };
      });
    },
  };

  // ------------------------------------------------------------- checkpoints
  const checkpointRow = (r) =>
    r && {
      id: r.id,
      workspaceId: r.workspace_id,
      bindingVersion: r.binding_version ?? null,
      path: r.path,
      sha256: r.sha256,
      size: r.size,
      baseCommit: r.base_commit ?? null,
      headCommit: r.head_commit ?? null,
      treeHash: r.tree_hash ?? null,
      pinned: r.pinned === 1,
      createdAt: r.created_at,
    };

  const checkpoints = {
    add({ workspaceId, bindingVersion, path: filePath, sha256, size, baseCommit, headCommit, treeHash }) {
      must(typeof workspaceId === "string" && workspaceId, "invalid", "workspaceId 必填");
      must(typeof filePath === "string" && filePath, "invalid", "path 必填");
      must(typeof sha256 === "string" && sha256, "invalid", "sha256 必填");
      must(Number.isInteger(size) && size >= 0, "invalid", "size 必须是非负整数");
      const id = newId("cp");
      q(
        `INSERT INTO checkpoints (id, workspace_id, binding_version, path, sha256, size, base_commit, head_commit, tree_hash, pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(id, workspaceId, bindingVersion ?? null, filePath, sha256, size, baseCommit ?? null, headCommit ?? null, treeHash ?? null, iso());
      return checkpoints.get(id);
    },
    /** 同一工作区的检查点，新的在前。 */
    list: (workspaceId) =>
      q("SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC").all(workspaceId).map(checkpointRow),
    get: (id) => checkpointRow(q("SELECT * FROM checkpoints WHERE id = ?").get(id)),
    /** 返回是否真的删除了一条记录。 */
    remove: (id) => Number(q("DELETE FROM checkpoints WHERE id = ?").run(id).changes) > 0,
    setPinned(id, pinned) {
      const res = q("UPDATE checkpoints SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
      must(Number(res.changes) > 0, "not_found", `检查点不存在：${id}`);
      return checkpoints.get(id);
    },
  };

  // ------------------------------------------------------------------- loops
  // Loop definitions, version snapshots and the run queue (Issue14 Phase1).
  // Higher-level validation (name length, trigger/capabilities schema) lives in src/loops/store.mjs;
  // here only persistence primitives.
  const loopRow = (r) =>
    r && {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      description: r.description ?? null,
      instructions: r.instructions,
      trigger: fromJson(r.trigger),
      conditions: fromJson(r.conditions),
      capabilities: fromJson(r.capabilities),
      reasoning: r.reasoning,
      enabled: r.enabled === 1,
      owner: r.owner ?? null,
      editPolicy: r.edit_policy,
      version: r.version,
      webhookSecretHash: r.webhook_secret_hash ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };

  const LOOP_COLUMNS = {
    name: "name",
    description: "description",
    instructions: "instructions",
    reasoning: "reasoning",
    owner: "owner",
    editPolicy: "edit_policy",
    version: "version",
    webhookSecretHash: "webhook_secret_hash",
  };

  const loops = {
    create(spec) {
      must(typeof spec?.workspaceId === "string" && spec.workspaceId, "invalid", "workspaceId 必填");
      must(typeof spec?.name === "string" && spec.name, "invalid", "name 必填");
      must(typeof spec?.instructions === "string" && spec.instructions, "invalid", "instructions 必填");
      must(spec?.trigger !== undefined && spec.trigger !== null, "invalid", "trigger 必填");
      return tx(() => {
        must(workspaces.get(spec.workspaceId), "not_found", `工作区不存在：${spec.workspaceId}`);
        const id = newId("loop");
        const t = iso();
        q(
          `INSERT INTO loops (id, workspace_id, name, description, instructions, trigger, conditions, capabilities, reasoning, enabled, owner, edit_policy, version, webhook_secret_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(
          id,
          spec.workspaceId,
          spec.name,
          spec.description ?? null,
          spec.instructions,
          toJson(spec.trigger),
          toJson(spec.conditions),
          toJson(spec.capabilities ?? {}),
          spec.reasoning ?? "auto",
          spec.enabled === false ? 0 : 1,
          spec.owner ?? null,
          spec.editPolicy ?? "members",
          spec.webhookSecretHash ?? null,
          t,
          t,
        );
        return loops.get(id);
      });
    },
    get: (id) => loopRow(q("SELECT * FROM loops WHERE id = ?").get(id)),
    listByWorkspace: (workspaceId) =>
      q("SELECT * FROM loops WHERE workspace_id = ? ORDER BY created_at, rowid").all(workspaceId).map(loopRow),
    /** Every enabled loop whose trigger is a github_* kind — the ingestion fan-out candidate set. */
    listEnabledGithub() {
      return q("SELECT * FROM loops WHERE enabled = 1").all().map(loopRow).filter((l) => {
        const k = l.trigger?.kind;
        return k === "github_issue" || k === "github_pr";
      });
    },
    /** patch keys: name, description, instructions, trigger, conditions, capabilities, reasoning, enabled,
     *  owner, editPolicy, version, webhookSecretHash. undefined keys are ignored; null clears nullable fields. */
    update(id, patch = {}) {
      return tx(() => {
        must(loops.get(id), "not_found", `loop 不存在：${id}`);
        const sets = [];
        const values = [];
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          if (key === "trigger" || key === "conditions" || key === "capabilities") {
            sets.push(`${key} = ?`);
            values.push(toJson(value));
          } else if (key === "enabled") {
            sets.push("enabled = ?");
            values.push(value ? 1 : 0);
          } else if (LOOP_COLUMNS[key]) {
            sets.push(`${LOOP_COLUMNS[key]} = ?`);
            values.push(value ?? null);
          } else {
            throw new ControlStoreError("invalid", `不可更新的 loop 字段：${key}`);
          }
        }
        if (!sets.length) return loops.get(id);
        sets.push("updated_at = ?");
        values.push(iso(), id);
        q(`UPDATE loops SET ${sets.join(", ")} WHERE id = ?`).run(...values);
        return loops.get(id);
      });
    },
    remove(id) {
      const res = q("DELETE FROM loops WHERE id = ?").run(id);
      return Number(res.changes) > 0;
    },
  };

  const loopVersionRow = (r) =>
    r && {
      loopId: r.loop_id,
      version: r.version,
      snapshot: fromJson(r.snapshot),
      publishedAt: r.published_at,
      publishedBy: r.published_by ?? null,
    };

  const loopVersions = {
    add(loopId, version, snapshot, { publishedBy } = {}) {
      q("INSERT INTO loop_versions (loop_id, version, snapshot, published_at, published_by) VALUES (?, ?, ?, ?, ?)").run(
        loopId,
        version,
        toJson(snapshot),
        iso(),
        publishedBy ?? null,
      );
      return loopVersions.get(loopId, version);
    },
    get: (loopId, version) =>
      loopVersionRow(q("SELECT * FROM loop_versions WHERE loop_id = ? AND version = ?").get(loopId, version)),
    list: (loopId) =>
      q("SELECT * FROM loop_versions WHERE loop_id = ? ORDER BY version").all(loopId).map(loopVersionRow),
  };

  const runRow = (r) =>
    r && {
      id: r.id,
      loopId: r.loop_id ?? null,
      loopVersion: r.loop_version ?? null,
      workspaceId: r.workspace_id,
      triggerKind: r.trigger_kind,
      triggerKey: r.trigger_key,
      payload: fromJson(r.payload),
      entityRef: r.entity_ref ?? null,
      botId: r.bot_id ?? null,
      branch: r.branch ?? null,
      prNumber: r.pr_number ?? null,
      status: r.status,
      error: r.error ?? null,
      enqueuedAt: r.enqueued_at,
      startedAt: r.started_at ?? null,
      endedAt: r.ended_at ?? null,
      usage: fromJson(r.usage),
    };

  const RUN_PATCH = {
    status: "status",
    error: "error",
    botId: "bot_id",
    branch: "branch",
    prNumber: "pr_number",
    startedAt: "started_at",
    endedAt: "ended_at",
    entityRef: "entity_ref",
  };

  const loopRuns = {
    /** Insert a queued run. Returns {run, created:false} when (loop_id, trigger_key) already exists. */
    enqueue({ loopId, loopVersion, workspaceId, triggerKind, triggerKey, payload, entityRef, status = "queued" }) {
      must(typeof triggerKind === "string" && triggerKind, "invalid", "triggerKind 必填");
      must(typeof triggerKey === "string" && triggerKey, "invalid", "triggerKey 必填");
      return tx(() => {
        const existing = q("SELECT * FROM loop_runs WHERE loop_id IS ? AND trigger_key = ?").get(loopId ?? null, triggerKey);
        if (existing) return { run: runRow(existing), created: false };
        const id = newId("run");
        q(
          `INSERT INTO loop_runs (id, loop_id, loop_version, workspace_id, trigger_kind, trigger_key, payload, entity_ref, status, enqueued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          loopId ?? null,
          loopVersion ?? null,
          workspaceId,
          triggerKind,
          triggerKey,
          toJson(payload),
          entityRef ?? null,
          status,
          iso(),
        );
        return { run: loopRuns.get(id), created: true };
      });
    },
    get: (id) => runRow(q("SELECT * FROM loop_runs WHERE id = ?").get(id)),
    /** patch keys: status, error, botId, branch, prNumber, startedAt, endedAt, entityRef, usage.
     * Status is one-way: once terminal (succeeded/failed/canceled/skipped) it cannot change — a late write from an
     * in-flight execution that lost its slot never resurrects the row. Non-status fields stay writable (audit data
     * such as an orphan botId may still be recorded). */
    update(id, patch = {}) {
      return tx(() => {
        const existing = loopRuns.get(id);
        must(existing, "not_found", `run 不存在：${id}`);
        if (patch.status !== undefined && RUN_TERMINAL.has(existing.status) && patch.status !== existing.status) {
          throw new ControlStoreError("invalid", `run 已终结（${existing.status}），不可再变更状态`);
        }
        const sets = [];
        const values = [];
        for (const [key, value] of Object.entries(patch)) {
          if (key === "usage") {
            sets.push("usage = ?");
            values.push(toJson(value));
          } else if (key === "payload") {
            sets.push("payload = ?");
            values.push(toJson(value));
          } else if (RUN_PATCH[key]) {
            sets.push(`${RUN_PATCH[key]} = ?`);
            values.push(value ?? null);
          } else {
            throw new ControlStoreError("invalid", `不可更新的 run 字段：${key}`);
          }
        }
        if (!sets.length) return loopRuns.get(id);
        values.push(id);
        q(`UPDATE loop_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
        return loopRuns.get(id);
      });
    },
    listByLoop(loopId, { limit = 50 } = {}) {
      return q("SELECT * FROM loop_runs WHERE loop_id = ? ORDER BY enqueued_at DESC, rowid DESC LIMIT ?")
        .all(loopId, limit)
        .map(runRow);
    },
    /** All runs holding a queue slot or waiting in line: queued FIFO order first class. */
    listActive() {
      return q(
        `SELECT * FROM loop_runs WHERE status IN ('queued','starting','running','needs_approval') ORDER BY enqueued_at, rowid`,
      )
        .all()
        .map(runRow);
    },
    /** Oldest queued run, or undefined. */
    nextQueued() {
      return runRow(
        q("SELECT * FROM loop_runs WHERE status = 'queued' ORDER BY enqueued_at, rowid LIMIT 1").get(),
      );
    },
    /** Runs holding a concurrency slot (everything active that is not queued). */
    listOccupying() {
      return q("SELECT * FROM loop_runs WHERE status IN ('starting','running','needs_approval')")
        .all()
        .map(runRow);
    },
    countOccupying() {
      return q("SELECT COUNT(*) AS n FROM loop_runs WHERE status IN ('starting','running','needs_approval')").get().n;
    },
    /** Queued runs in FIFO order with 1-based positions. */
    listQueued() {
      return q("SELECT * FROM loop_runs WHERE status = 'queued' ORDER BY enqueued_at, rowid").all().map(runRow);
    },
    /** The newest run of a loop (for list summaries), undefined when none. */
    latestOf(loopId) {
      return runRow(q("SELECT * FROM loop_runs WHERE loop_id = ? ORDER BY enqueued_at DESC, rowid DESC LIMIT 1").get(loopId));
    },
  };

  // ------------------------------------------------------------- loops phase 2
  // Condition-match state: one row per (loop, entity); `matched` flips on the transition into/out of the
  // condition set — the "starts matching" semantics. Deliveries table is the ingestion-level cross-channel
  // dedup for GitHub events; per-loop dedup is loop_runs' UNIQUE(loop_id,trigger_key). The poll cursor
  // persists the newest seen event id per workspace.
  const loopMatchState = {
    get(loopId, entityRef) {
      const r = q("SELECT matched FROM loop_match_state WHERE loop_id = ? AND entity_ref = ?")
        .get(loopId, entityRef);
      return r ? r.matched === 1 : false;
    },
    set(loopId, entityRef, matched) {
      q(
        `INSERT INTO loop_match_state (loop_id, entity_ref, matched, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (loop_id, entity_ref) DO UPDATE SET matched = excluded.matched, updated_at = excluded.updated_at`,
      ).run(loopId, entityRef, matched ? 1 : 0, iso());
    },
    clearLoop(loopId) {
      q("DELETE FROM loop_match_state WHERE loop_id = ?").run(loopId);
    },
  };

  const githubCursor = {
    get(workspaceId) {
      const r = q("SELECT last_event_id, polled_at FROM github_event_cursor WHERE workspace_id = ?").get(workspaceId);
      return r ? { lastEventId: r.last_event_id, polledAt: r.polled_at } : undefined;
    },
    set(workspaceId, lastEventId) {
      q(
        `INSERT INTO github_event_cursor (workspace_id, last_event_id, polled_at) VALUES (?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET last_event_id = excluded.last_event_id, polled_at = excluded.polled_at`,
      ).run(workspaceId, lastEventId, iso());
    },
  };

  const githubDeliveries = {
    /** Insert an ingestion record; false when the canonical event key was already ingested (either channel). */
    mark(eventKey, source) {
      const r = q(
        "INSERT OR IGNORE INTO github_deliveries (event_key, source, received_at) VALUES (?, ?, ?)",
      ).run(eventKey, source, iso());
      return r.changes > 0;
    },
    seen(eventKey) {
      return q("SELECT source FROM github_deliveries WHERE event_key = ?").get(eventKey)?.source;
    },
  };

  return {
    projects,
    workspaces,
    bindings,
    links,
    intents,
    meta,
    bumpGeneration: meta.bumpGeneration,
    executions,
    requests,
    checkpoints,
    loops,
    loopVersions,
    loopRuns,
    loopMatchState,
    githubCursor,
    githubDeliveries,
    close() {
      db.close();
    },
  };
}
