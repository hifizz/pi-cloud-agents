// Loops API client + types (Issue14 Phase1). Mirrors src/routes/loops.mjs.
import { request } from "./api";

export type LoopTriggerKind = "manual" | "schedule" | "webhook" | "github_issue" | "github_pr";
export type LoopReasoning = "auto" | "low" | "medium" | "high";
export type LoopCodeLevel = "none" | "read" | "readwrite";
export type LoopRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "needs_approval"
  | "succeeded"
  | "failed"
  | "canceled"
  | "skipped";

export interface LoopScheduleSpec {
  kind: "schedule";
  freq: "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  at?: string; // "HH:MM"
  tz: string;
  startAt: number;
  days?: number[]; // weekly, 0=Sunday
}

export interface LoopTrigger {
  kind: LoopTriggerKind;
  [key: string]: unknown;
}

export interface LoopCapabilities {
  code: LoopCodeLevel;
  web: boolean;
  scopeToTrigger: boolean;
  github: { comment: boolean; label: boolean; openIssue: boolean; openPr: boolean };
  tools: { name: string; autoApprove: boolean }[];
}

export interface Loop {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  instructions: string;
  trigger: LoopTrigger;
  conditions?: unknown[] | null;
  capabilities: LoopCapabilities;
  reasoning: LoopReasoning;
  enabled: boolean;
  owner?: string | null;
  editPolicy: string;
  version: number;
  hasWebhookSecret?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Latest run summary attached by list/detail views. */
  latestRun?: LoopRun | null;
}

export interface LoopRun {
  id: string;
  loopId: string | null;
  loopVersion: number | null;
  workspaceId: string;
  triggerKind: LoopTriggerKind;
  triggerKey: string;
  payload?: unknown;
  entityRef?: string | null;
  botId?: string | null;
  branch?: string | null;
  prNumber?: number | null;
  status: LoopRunStatus;
  error?: string | null;
  enqueuedAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  usage?: unknown;
  /** Queue position (queued runs only), 1-based. */
  position?: number;
}

export interface LoopQueueView {
  maxConcurrent: number;
  running: LoopRun[];
  queued: LoopRun[];
}

export interface LoopInput {
  name: string;
  description?: string;
  instructions: string;
  trigger: LoopTrigger;
  conditions?: unknown[];
  capabilities?: Partial<LoopCapabilities>;
  reasoning?: LoopReasoning;
  enabled?: boolean;
  owner?: string;
  editPolicy?: string;
}

const enc = encodeURIComponent;

export const RUN_STATUS_LABEL: Record<LoopRunStatus, string> = {
  queued: "排队中",
  starting: "启动中",
  running: "运行中",
  needs_approval: "待审批",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
  skipped: "已跳过",
};

/** Short human label for a trigger, e.g. "每天 09:00 Asia/Shanghai". */
export function triggerLabel(trigger: LoopTrigger): string {
  switch (trigger.kind) {
    case "manual":
      return "手动";
    case "webhook":
      return "Webhook";
    case "github_issue":
      return `GitHub issue · ${String(trigger.event ?? "?")}`;
    case "github_pr":
      return `GitHub PR · ${String(trigger.event ?? "?")}`;
    case "schedule": {
      const s = trigger as unknown as LoopScheduleSpec;
      const freq =
        s.freq === "hourly"
          ? `每 ${s.interval} 小时`
          : s.freq === "daily"
            ? (s.interval > 1 ? `每 ${s.interval} 天` : "每天")
            : s.freq === "weekly"
              ? (s.interval > 1 ? `每 ${s.interval} 周` : "每周")
              : s.freq === "monthly"
                ? (s.interval > 1 ? `每 ${s.interval} 个月` : "每月")
                : (s.interval > 1 ? `每 ${s.interval} 年` : "每年");
      const days = s.days?.length ? ` · ${s.days.map((d) => ["日", "一", "二", "三", "四", "五", "六"][d]).join("/")}` : "";
      return `${freq} ${s.at ?? ""}${days} ${s.tz}`.trim();
    }
  }
  return String(trigger.kind);
}

export const loopsApi = {
  list: (workspaceId: string) => request<Loop[]>("GET", `/api/workspaces/${enc(workspaceId)}/loops`),
  get: (id: string) => request<Loop>("GET", `/api/loops/${enc(id)}`),
  create: (workspaceId: string, input: LoopInput) =>
    request<{ loop: Loop; webhookSecret?: string }>("POST", `/api/workspaces/${enc(workspaceId)}/loops`, input),
  update: (id: string, patch: Partial<LoopInput>) =>
    request<{ loop: Loop; webhookSecret?: string }>("PATCH", `/api/loops/${enc(id)}`, patch),
  remove: (id: string) => request<{ ok: boolean; id: string }>("DELETE", `/api/loops/${enc(id)}`),
  setEnabled: (id: string, enabled: boolean) =>
    request<{ loop: Loop }>("POST", `/api/loops/${enc(id)}/${enabled ? "enable" : "disable"}`, {}),
  run: (id: string, entity?: { issue?: number; pr?: number }) =>
    request<{ runId: string; status: LoopRunStatus }>("POST", `/api/loops/${enc(id)}/run`, entity ? { entity } : {}),
  runs: (id: string, limit = 50) => request<LoopRun[]>("GET", `/api/loops/${enc(id)}/runs?limit=${limit}`),
  versions: (id: string) => request<unknown[]>("GET", `/api/loops/${enc(id)}/versions`),
  cancelRun: (runId: string) => request<LoopRun>("POST", `/api/loop-runs/${enc(runId)}/cancel`, {}),
  queue: () => request<LoopQueueView>("GET", "/api/loops/queue"),
  rotateSecret: (id: string) => request<{ webhookSecret: string }>("POST", `/api/loops/${enc(id)}/webhook/rotate`, {}),
};
