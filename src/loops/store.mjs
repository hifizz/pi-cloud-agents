// Loop definitions: validation, CRUD with version snapshots (Issue14 Phase1).
// Persistence primitives live in src/control/store.mjs (loops/loopVersions/loopRuns); this module owns the schema
// rules of the `trigger`, `conditions` and `capabilities` JSON columns and the version-bump contract of PATCH.
import { randomBytes } from "node:crypto";
import { hashPassword } from "../auth.mjs";
import { LOOP_TRIGGER_KINDS } from "../control/db.mjs";

export class LoopValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoopValidationError";
    this.code = "invalid";
  }
}

const fail = (msg) => {
  throw new LoopValidationError(msg);
};

const NAME_MAX = 64;
const DESCRIPTION_MAX = 255;
const CONDITIONS_MAX = 8;
const INSTRUCTIONS_MAX = 100_000;
const PAYLOAD_MAX = 64 * 1024;

export const REASONING_LEVELS = ["auto", "low", "medium", "high"];
const CODE_LEVELS = ["none", "read", "readwrite"];
const EDIT_POLICIES = ["members", "admins", "owner"];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FREQS = ["hourly", "daily", "weekly", "monthly", "yearly"];
const GITHUB_ISSUE_EVENTS = ["opened", "labeled", "closed", "assigned", "commented"];
const GITHUB_PR_EVENTS = [
  "opened",
  "ready_for_review",
  "labeled",
  "merged",
  "checks_failed",
  "checks_passed",
  "review_submitted",
  "push",
  "commented",
];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const optStr = (v, max) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") fail(`expected a string, got ${typeof v}`);
  const t = v.trim();
  if (t.length > max) fail(`value is too long (max ${max} characters)`);
  return t || undefined;
};

/** Validate a trigger object; returns a normalized copy. `now` for startAt validation; `allowStartAt` is an
 * already-persisted value that may stay even when it lies in the past (unchanged schedule on edit). */
export function validateTrigger(trigger, { now = Date.now, allowStartAt } = {}) {
  if (!isObject(trigger)) fail("trigger must be an object");
  const kind = trigger.kind;
  if (!LOOP_TRIGGER_KINDS.includes(kind)) fail(`trigger.kind must be one of: ${LOOP_TRIGGER_KINDS.join(", ")}`);
  switch (kind) {
    case "manual":
      return { kind };
    case "webhook":
      return { kind };
    case "schedule": {
      const freq = trigger.freq;
      if (!FREQS.includes(freq)) fail(`schedule.freq must be one of: ${FREQS.join(", ")}`);
      const interval = trigger.interval === undefined ? 1 : trigger.interval;
      if (!Number.isInteger(interval) || interval < 1 || interval > 10_000) fail("schedule.interval must be an integer >= 1");
      const at = trigger.at === undefined ? undefined : trigger.at;
      if (at !== undefined && (typeof at !== "string" || !TIME_RE.test(at))) fail('schedule.at must be "HH:MM"');
      if (freq !== "hourly" && at === undefined) fail('schedule.at ("HH:MM") is required for daily/weekly/monthly/yearly');
      const tz = trigger.tz === undefined ? "UTC" : trigger.tz;
      if (typeof tz !== "string" || !tz) fail("schedule.tz must be a timezone name");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        fail(`schedule.tz is not a valid IANA timezone: ${tz}`);
      }
      const startAt = trigger.startAt === undefined ? now : Number(trigger.startAt);
      if (!Number.isFinite(startAt)) fail("schedule.startAt must be epoch milliseconds");
      if (startAt < now && startAt !== allowStartAt) fail("schedule.startAt cannot be in the past");
      let days;
      if (trigger.days !== undefined) {
        if (!Array.isArray(trigger.days) || trigger.days.length === 0 || trigger.days.length > 7) fail("schedule.days must be a non-empty array");
        days = trigger.days.map((d) => {
          const n = Number(d);
          if (!Number.isInteger(n) || n < 0 || n > 6) fail("schedule.days entries must be integers 0..6 (0=Sunday)");
          return n;
        });
        days = [...new Set(days)].sort((a, b) => a - b);
        if (freq !== "weekly") fail("schedule.days is only valid with freq weekly");
      }
      return {
        kind,
        freq,
        interval,
        ...(at !== undefined ? { at } : {}),
        tz,
        startAt,
        ...(days ? { days } : {}),
      };
    }
    case "github_issue":
    case "github_pr": {
      const allowed = kind === "github_issue" ? GITHUB_ISSUE_EVENTS : GITHUB_PR_EVENTS;
      // Accept either `events: ["opened", ...]` (spec shape) or the legacy single `event`. Normalized to `events`.
      let events;
      if (trigger.events !== undefined) {
        if (!Array.isArray(trigger.events) || trigger.events.length === 0) fail(`${kind}.events must be a non-empty array`);
        events = trigger.events.map((e) => {
          if (!allowed.includes(e)) fail(`${kind}.events entry must be one of: ${allowed.join(", ")} (got ${e})`);
          return e;
        });
        events = [...new Set(events)];
      } else if (trigger.event !== undefined) {
        if (!allowed.includes(trigger.event)) fail(`${kind}.event must be one of: ${allowed.join(", ")}`);
        events = [trigger.event];
      } else {
        fail(`${kind}.events is required`);
      }
      let filters;
      if (trigger.filters !== undefined) {
        if (!isObject(trigger.filters)) fail("trigger.filters must be an object");
        const f = trigger.filters;
        filters = {
          ...(f.branch !== undefined ? { branch: optStr(f.branch, 200) } : {}),
          ...(f.label !== undefined ? { label: optStr(f.label, 100) } : {}),
          ...(f.author !== undefined ? { author: optStr(f.author, 100) } : {}),
        };
      }
      return { kind, events, ...(filters && Object.keys(filters).length ? { filters } : {}) };
    }
  }
  fail(`unsupported trigger kind: ${kind}`);
}

/** Validate capabilities; returns a normalized copy with every switch explicit. */
export function validateCapabilities(capabilities) {
  const c = capabilities === undefined || capabilities === null ? {} : capabilities;
  if (!isObject(c)) fail("capabilities must be an object");
  const code = c.code === undefined ? "read" : c.code;
  if (!CODE_LEVELS.includes(code)) fail(`capabilities.code must be one of: ${CODE_LEVELS.join(", ")}`);
  const web = c.web === undefined ? false : Boolean(c.web);
  const scopeToTrigger = c.scopeToTrigger === undefined ? true : Boolean(c.scopeToTrigger);
  let github;
  if (c.github !== undefined) {
    if (!isObject(c.github)) fail("capabilities.github must be an object");
    github = {
      comment: Boolean(c.github.comment),
      label: Boolean(c.github.label),
      openIssue: Boolean(c.github.openIssue),
      openPr: Boolean(c.github.openPr),
    };
  } else {
    github = { comment: false, label: false, openIssue: false, openPr: false };
  }
  let tools = [];
  if (c.tools !== undefined) {
    if (!Array.isArray(c.tools)) fail("capabilities.tools must be an array");
    tools = c.tools.map((t) => {
      if (!isObject(t) || typeof t.name !== "string" || !t.name) fail("capabilities.tools entries need {name, autoApprove?}");
      return { name: t.name, autoApprove: Boolean(t.autoApprove) };
    });
  }
  return { code, web, scopeToTrigger, github, tools };
}

function validateReasoning(reasoning) {
  const r = reasoning === undefined || reasoning === null ? "auto" : reasoning;
  if (!REASONING_LEVELS.includes(r)) fail(`reasoning must be one of: ${REASONING_LEVELS.join(", ")}`);
  return r;
}

function validateConditions(conditions) {
  if (conditions === undefined || conditions === null) return [];
  if (!Array.isArray(conditions)) fail("conditions must be an array");
  if (conditions.length > CONDITIONS_MAX) fail(`conditions: at most ${CONDITIONS_MAX} entries`);
  return conditions.map((c) => {
    if (!isObject(c) || typeof c.field !== "string" || !c.field) fail("each condition needs a field name");
    return c;
  });
}

function validateEditPolicy(editPolicy) {
  const p = editPolicy === undefined || editPolicy === null ? "members" : editPolicy;
  if (!EDIT_POLICIES.includes(p)) fail(`editPolicy must be one of: ${EDIT_POLICIES.join(", ")}`);
  return p;
}

/** Validate a create spec; throws LoopValidationError. Returns normalized fields. */
export function validateCreate(spec, opts = {}) {
  if (!isObject(spec)) fail("spec must be an object");
  const name = optStr(spec.name, NAME_MAX);
  if (!name) fail("name is required");
  const description = optStr(spec.description, DESCRIPTION_MAX);
  const instructions = spec.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) fail("instructions is required");
  if (instructions.length > INSTRUCTIONS_MAX) fail(`instructions is too long (max ${INSTRUCTIONS_MAX} characters)`);
  return {
    name,
    description,
    instructions,
    trigger: validateTrigger(spec.trigger, opts),
    conditions: validateConditions(spec.conditions),
    capabilities: validateCapabilities(spec.capabilities),
    reasoning: validateReasoning(spec.reasoning),
    editPolicy: validateEditPolicy(spec.editPolicy),
    enabled: spec.enabled === undefined ? true : Boolean(spec.enabled),
    owner: spec.owner === undefined ? null : optStr(spec.owner, 200) ?? null,
  };
}

/** Fields a snapshot carries — never the webhook secret hash. */
export function snapshotOf(loop) {
  const { webhookSecretHash: _drop, ...rest } = loop;
  return structuredClone(rest);
}

/** The same webhook-trigger payload cap enforced at the HTTP edge. */
export const MAX_WEBHOOK_PAYLOAD = PAYLOAD_MAX;

/**
 * Loop store over a control store. `now` is the injected clock (tests).
 * @param {{ store: object, now?: () => number }} opts
 */
export function createLoopStore({ store, now = Date.now }) {
  async function create(workspaceId, spec) {
    const fields = validateCreate(spec, { now: now() });
    // A webhook trigger gets its secret on creation: generated here, hashed for storage, returned once.
    let secret;
    let webhookSecretHash;
    if (fields.trigger.kind === "webhook") {
      secret = `whsec_${randomBytes(24).toString("base64url")}`;
      webhookSecretHash = await hashPassword(secret);
    }
    const loop = store.loops.create({ ...fields, workspaceId, webhookSecretHash });
    store.loopVersions.add(loop.id, 1, snapshotOf(loop), { publishedBy: fields.owner });
    return { loop, ...(secret ? { webhookSecret: secret } : {}) };
  }

  /** PATCH: validates the merged result, bumps version, snapshots. Undefined keys keep their value. */
  async function update(id, patch = {}) {
    const current = store.loops.get(id);
    if (!current) return undefined;
    const merged = {
      name: patch.name === undefined ? current.name : patch.name,
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
      description: patch.description === undefined ? current.description : patch.description,
      instructions: patch.instructions === undefined ? current.instructions : patch.instructions,
      trigger: patch.trigger === undefined ? current.trigger : patch.trigger,
      conditions: patch.conditions === undefined ? current.conditions : patch.conditions,
      capabilities: patch.capabilities === undefined ? current.capabilities : patch.capabilities,
      reasoning: patch.reasoning === undefined ? current.reasoning : patch.reasoning,
      editPolicy: patch.editPolicy === undefined ? current.editPolicy : patch.editPolicy,
      owner: patch.owner === undefined ? current.owner : patch.owner,
    };
    const fields = validateCreate(merged, {
      now: now(),
      // Editing a loop without touching its startAt must not bounce off the past-check: an already-persisted
      // startAt is allowed to stay; a *changed* startAt still has to be in the future.
      allowStartAt: current.trigger?.kind === "schedule" ? current.trigger.startAt : undefined,
    });
    // Switching into a webhook trigger without a stored secret: mint one now.
    let secret;
    let webhookSecretHash;
    if (fields.trigger.kind === "webhook" && !current.webhookSecretHash) {
      secret = `whsec_${randomBytes(24).toString("base64url")}`;
      webhookSecretHash = await hashPassword(secret);
    }
    const version = current.version + 1;
    const loop = store.loops.update(id, { ...fields, version, ...(webhookSecretHash ? { webhookSecretHash } : {}) });
    store.loopVersions.add(id, version, snapshotOf(loop), { publishedBy: fields.owner });
    return { loop, ...(secret ? { webhookSecret: secret } : {}) };
  }

  async function rotateSecret(id) {
    const loop = store.loops.get(id);
    if (!loop) return undefined;
    if (loop.trigger?.kind !== "webhook") fail("loop has no webhook trigger");
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    store.loops.update(id, { webhookSecretHash: await hashPassword(secret) });
    return { loop: store.loops.get(id), webhookSecret: secret };
  }

  return {
    create,
    update,
    rotateSecret,
    get: (id) => store.loops.get(id),
    listByWorkspace: (workspaceId) => store.loops.listByWorkspace(workspaceId),
    setEnabled: (id, enabled) => store.loops.update(id, { enabled }),
    remove: (id) => store.loops.remove(id),
    versions: (id) => store.loopVersions.list(id),
  };
}
