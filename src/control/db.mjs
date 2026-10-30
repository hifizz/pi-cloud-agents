// 控制库：打开 sqlite、建表迁移。不读环境变量，路径由调用方传入。
// 迁移用 PRAGMA user_version：MIGRATIONS[i] 把库从版本 i 升到 i+1，每个迁移在事务内执行，可重复打开。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const STEPS = ["runtime", "init", "code", "deps", "agent"];
export const STEP_STATES = ["pending", "running", "done", "failed", "unknown"];
export const WORKSPACE_STATUSES = ["preparing", "ready", "failed", "archived"];
export const INTENT_STATES = ["planned", "sent", "confirmed", "failed", "unknown"];
export const EXECUTION_STATES = ["claimed", "started", "exited", "lost", "unknown"];
export const LOOP_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "needs_approval",
  "succeeded",
  "failed",
  "canceled",
  "skipped",
];
/** Statuses that occupy a queue slot (anything else is terminal). */
export const LOOP_RUN_ACTIVE = ["queued", "starting", "running", "needs_approval"];
export const LOOP_TRIGGER_KINDS = ["manual", "schedule", "webhook", "github_issue", "github_pr"];

const list = (xs) => xs.map((x) => `'${x}'`).join(", ");

export const MIGRATIONS = [
  // v1：初始表结构
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE projects (
    id              TEXT PRIMARY KEY,
    repo            TEXT NOT NULL UNIQUE,
    default_branch  TEXT NOT NULL,
    install_command TEXT,
    test_command    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    request_id  TEXT NOT NULL UNIQUE,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    name        TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    base_commit TEXT,
    branch      TEXT NOT NULL,
    cwd         TEXT NOT NULL,
    model       TEXT NOT NULL,
    task        TEXT,
    status      TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN (${list(WORKSPACE_STATUSES)})),
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX workspaces_project ON workspaces(project_id);
  CREATE INDEX workspaces_status ON workspaces(status);

  CREATE TABLE workspace_steps (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    step         TEXT NOT NULL CHECK (step IN (${list(STEPS)})),
    state        TEXT NOT NULL CHECK (state IN (${list(STEP_STATES)})),
    error        TEXT,
    started_at   TEXT,
    finished_at  TEXT,
    PRIMARY KEY (workspace_id, step)
  );

  CREATE TABLE runtime_bindings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    runtime_id   TEXT NOT NULL,
    version      INTEGER NOT NULL CHECK (version >= 1),
    state        TEXT NOT NULL CHECK (state IN ('active', 'replaced')),
    created_at   TEXT NOT NULL,
    replaced_at  TEXT,
    UNIQUE (workspace_id, version)
  );
  CREATE UNIQUE INDEX runtime_bindings_one_active ON runtime_bindings(workspace_id) WHERE state = 'active';

  CREATE TABLE conversation_links (
    conversation_id TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id          TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX conversation_links_workspace ON conversation_links(workspace_id);

  CREATE TABLE intents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id   TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL,
    target       TEXT NOT NULL,
    workspace_id TEXT,
    state        TEXT NOT NULL DEFAULT 'planned' CHECK (state IN (${list(INTENT_STATES)})),
    evidence     TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX intents_state ON intents(state);

  CREATE TABLE executions (
    run_id          TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    runtime_id      TEXT NOT NULL,
    binding_version INTEGER NOT NULL,
    cwd             TEXT NOT NULL,
    command_hash    TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'claimed' CHECK (state IN (${list(EXECUTION_STATES)})),
    exit_json       TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX executions_state ON executions(state);

  CREATE TABLE requests (
    scope        TEXT NOT NULL,
    request_id   TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (scope, request_id)
  );

  CREATE TABLE checkpoints (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    binding_version INTEGER,
    path            TEXT NOT NULL,
    sha256          TEXT NOT NULL,
    size            INTEGER NOT NULL,
    base_commit     TEXT,
    head_commit     TEXT,
    tree_hash       TEXT,
    pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at      TEXT NOT NULL
  );
  CREATE INDEX checkpoints_workspace ON checkpoints(workspace_id);
  `,
  // v2：Loops（Issue14 Phase1）：loop 定义/版本/运行队列 + Phase2 预留表
  `
  CREATE TABLE loops (
    id                  TEXT PRIMARY KEY,
    workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    description         TEXT,
    instructions        TEXT NOT NULL,
    trigger             TEXT NOT NULL,
    conditions          TEXT,
    capabilities        TEXT NOT NULL,
    reasoning           TEXT NOT NULL DEFAULT 'auto',
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    owner               TEXT,
    edit_policy         TEXT NOT NULL DEFAULT 'members',
    version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    webhook_secret_hash TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
  CREATE INDEX loops_workspace ON loops(workspace_id);

  CREATE TABLE loop_versions (
    loop_id      TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL CHECK (version >= 1),
    snapshot     TEXT NOT NULL,
    published_at TEXT NOT NULL,
    published_by TEXT,
    PRIMARY KEY (loop_id, version)
  );

  CREATE TABLE loop_runs (
    id            TEXT PRIMARY KEY,
    loop_id       TEXT,
    loop_version  INTEGER,
    workspace_id  TEXT NOT NULL,
    trigger_kind  TEXT NOT NULL,
    trigger_key   TEXT NOT NULL,
    payload       TEXT,
    entity_ref    TEXT,
    bot_id        TEXT,
    branch        TEXT,
    pr_number     INTEGER,
    status        TEXT NOT NULL CHECK (status IN (${list(LOOP_RUN_STATUSES)})),
    error         TEXT,
    enqueued_at   TEXT NOT NULL,
    started_at    TEXT,
    ended_at      TEXT,
    usage         TEXT
  );
  CREATE UNIQUE INDEX loop_runs_dedup ON loop_runs(loop_id, trigger_key) WHERE loop_id IS NOT NULL;
  CREATE INDEX loop_runs_status ON loop_runs(status);
  CREATE INDEX loop_runs_loop ON loop_runs(loop_id, enqueued_at);

  CREATE TABLE loop_match_state (
    loop_id    TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
    entity_ref TEXT NOT NULL,
    matched    INTEGER NOT NULL CHECK (matched IN (0,1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (loop_id, entity_ref)
  );

  CREATE TABLE github_event_cursor (
    workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    last_event_id TEXT,
    polled_at     TEXT
  );

  CREATE TABLE github_deliveries (
    event_key   TEXT PRIMARY KEY,
    source      TEXT NOT NULL CHECK (source IN ('webhook','poll')),
    received_at TEXT NOT NULL
  );
  `,
];

export function migrate(db, migrations = MIGRATIONS) {
  const current = db.prepare("PRAGMA user_version").get().user_version;
  if (current > migrations.length) {
    throw new Error(`控制库版本 ${current} 高于当前程序支持的 ${migrations.length}，拒绝打开`);
  }
  for (let v = current; v < migrations.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务已失效
      }
      throw err;
    }
  }
}

/** 打开（必要时创建）控制库并迁移到最新。path 为 null 时用内存库。 */
export function openControlDb({ path }) {
  if (path !== null && path !== undefined) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path ?? ":memory:");
  try {
    if (path) db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
