// 控制库对外 API（M1-01）。签名以 docs/M1-PLAN.md §4.1 为准。
// 单进程单写者；所有写操作都是同步事务；不读环境变量、不 import config.mjs。
import { randomBytes } from "node:crypto";
import { openControlDb, STEPS } from "./db.mjs";

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
    close() {
      db.close();
    },
  };
}
