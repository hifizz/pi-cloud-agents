// Workspace API client, types and helpers (docs/M1-PLAN.md §4.8). The backend routes are owned by other tasks;
// everything here only assumes the shapes documented in the plan.
import { createContext, useEffect, useRef } from "react";
import { ApiError, request } from "./api";
import type { BotSummary } from "../types";

export type StepName = "runtime" | "init" | "code" | "deps" | "agent";
export type StepState = "pending" | "running" | "done" | "failed" | "unknown";
export type WorkspaceState = "preparing" | "ready" | "failed" | "archived";

export interface WorkspaceStep {
  step: StepName;
  state: StepState;
  error?: string | null;
  startedAt?: string | number | null;
  finishedAt?: string | number | null;
}

/** Summary of the active environment binding (provider + runtime id + version). */
export interface WorkspaceBinding {
  provider: string;
  runtimeId: string;
  version: number;
}

export interface Workspace {
  id: string;
  name: string;
  repo: string;
  baseBranch: string;
  baseCommit?: string | null;
  branch: string;
  model?: string | { provider?: string; modelId?: string } | null;
  task?: string | null;
  status: WorkspaceState;
  error?: string | null;
  createdAt?: string | number;
  updatedAt?: string | number;
  steps: WorkspaceStep[];
  /** Primary Bot of the workspace; absent until the `agent` step has run. */
  botId?: string | null;
  binding?: WorkspaceBinding | null;
}

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface GithubBranch {
  name: string;
  sha: string;
}

export interface NewWorkspaceInput {
  requestId: string;
  repo: string;
  baseBranch?: string;
  task?: string;
  modelId?: string;
  installCommand?: string;
  name?: string;
}

export interface PullInfo {
  number: number;
  url: string;
  state?: string;
  merged?: boolean;
  headRef?: string | null;
  baseRef?: string | null;
}

export interface CheckpointManifest {
  id: string | number;
  workspaceId?: string;
  pinned?: boolean;
  bindingVersion?: number | null;
  size: number;
  fileCount?: number | null;
  createdAt?: string | number | null;
  warnings?: string[];
  /** Set by POST .../checkpoint when nothing changed since the previous checkpoint. */
  unchanged?: boolean;
}

export interface RebuildResult {
  version?: number;
  provider?: string;
  runtimeId?: string;
}

export const STEP_ORDER: StepName[] = ["runtime", "init", "code", "deps", "agent"];
export const STEP_LABEL: Record<StepName, string> = {
  runtime: "创建环境",
  init: "初始化环境",
  code: "拉取代码",
  deps: "安装依赖",
  agent: "启动 Agent",
};
export const STEP_STATE_LABEL: Record<StepState, string> = {
  pending: "等待中",
  running: "进行中",
  done: "已完成",
  failed: "失败",
  unknown: "结果待确认",
};
export const STATUS_LABEL: Record<WorkspaceState, string> = {
  preparing: "准备中",
  ready: "就绪",
  failed: "失败",
  archived: "已归档",
};

const enc = encodeURIComponent;

/** Make sure `steps` is always an array, whatever the server returned. */
export function normalizeWorkspace(raw: Workspace): Workspace {
  return { ...raw, steps: Array.isArray(raw?.steps) ? raw.steps : [] };
}

export const workspacesApi = {
  repos: () => request<GithubRepo[]>("GET", "/api/github/repos"),
  branches: (repo: string) => request<GithubBranch[]>("GET", `/api/github/branches?repo=${enc(repo)}`),
  create: async (input: NewWorkspaceInput) => normalizeWorkspace(await request<Workspace>("POST", "/api/workspaces", input)),
  list: async () => (await request<Workspace[]>("GET", "/api/workspaces")).map(normalizeWorkspace),
  get: async (id: string) => normalizeWorkspace(await request<Workspace>("GET", `/api/workspaces/${enc(id)}`)),
  retry: async (id: string) => normalizeWorkspace(await request<Workspace>("POST", `/api/workspaces/${enc(id)}/retry`, {})),
  createPr: (id: string, input: { requestId: string; title?: string; body?: string; base?: string }) =>
    request<{ pull: PullInfo; created: boolean }>("POST", `/api/workspaces/${enc(id)}/pr`, input),
  saveCheckpoint: (id: string) => request<CheckpointManifest>("POST", `/api/workspaces/${enc(id)}/checkpoint`, {}),
  checkpoints: (id: string) => request<CheckpointManifest[]>("GET", `/api/workspaces/${enc(id)}/checkpoints`),
  rebuild: (id: string, input: { checkpointId: string | number; requestId?: string }) =>
    request<RebuildResult>("POST", `/api/workspaces/${enc(id)}/rebuild`, input),
};

/** User-facing text for any thrown value; never empty. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message || `请求失败（HTTP ${e.status}）`;
  if (e instanceof TypeError) return "网络请求失败，请检查连接后重试";
  if (e instanceof Error) return e.message || "未知错误";
  return String(e) || "未知错误";
}

/** The five steps in canonical order; steps the server did not report yet count as pending. */
export function orderedSteps(ws: Pick<Workspace, "steps">): WorkspaceStep[] {
  return STEP_ORDER.map((step) => ws.steps.find((s) => s.step === step) ?? { step, state: "pending" as StepState });
}

/** The step to talk about: the running one, else the first failed / unconfirmed one, else the first pending one. */
export function currentStep(ws: Pick<Workspace, "steps">): WorkspaceStep | undefined {
  const steps = orderedSteps(ws);
  return (
    steps.find((s) => s.state === "running") ??
    steps.find((s) => s.state === "failed" || s.state === "unknown") ??
    steps.find((s) => s.state === "pending")
  );
}

/** True when the user can ask the server to retry (a failed workspace or any failed / unconfirmed step). */
export function needsRetry(ws: Pick<Workspace, "status" | "steps">): boolean {
  if (ws.status === "archived" || ws.status === "ready") return false;
  return ws.status === "failed" || ws.steps.some((s) => s.state === "failed" || s.state === "unknown");
}

/** "sprites · a1b2c3": provider plus the last 6 characters of the runtime id. */
export function envName(ws: Pick<Workspace, "binding">): string | undefined {
  const b = ws.binding;
  if (!b?.provider || !b.runtimeId) return undefined;
  return `${b.provider} · ${b.runtimeId.slice(-6)}`;
}

export function modelLabel(model: Workspace["model"]): string | undefined {
  if (!model) return undefined;
  return typeof model === "string" ? model : model.modelId;
}

export function shortSha(sha: string | null | undefined): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}

export function repoName(repo: string): string {
  return repo.split("/").pop() || repo;
}

export function formatBytes(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "未知大小";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Local "YYYY-MM-DD HH:mm"; empty string when the value is missing or not a date. */
export function formatTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** botId → workspaceId. A Bot belongs to a workspace directly (`workspace.botId`) or through the Bot it was forked from. */
export function mapBotsToWorkspaces(bots: BotSummary[], workspaces: Workspace[]): Map<string, string> {
  const direct = new Map<string, string>();
  for (const w of workspaces) if (w.botId) direct.set(String(w.botId), w.id);
  const byId = new Map(bots.map((b) => [b.id, b]));
  const resolve = (bot: BotSummary, seen: Set<string>): string | undefined => {
    const own = direct.get(bot.id);
    if (own) return own;
    const parent = bot.parent?.botId ? byId.get(bot.parent.botId) : undefined;
    if (!parent || seen.has(parent.id)) return undefined;
    seen.add(parent.id);
    return resolve(parent, seen);
  };
  const out = new Map<string, string>();
  for (const b of bots) {
    const ws = resolve(b, new Set([b.id]));
    if (ws) out.set(b.id, ws);
  }
  return out;
}

export interface LocalWorkspace {
  workspace: Workspace;
  at: number;
}
export const LOCAL_WORKSPACE_TTL_MS = 30_000;

/**
 * Merge a fresh list response with workspaces this client just created. A list request that was already in flight
 * when the workspace was created may not contain it; keep it until a list shows it (or the entry expires), so the
 * selection does not jump away. Entries that were seen or expired are removed from `local`.
 */
export function mergeWorkspaceList(list: Workspace[], local: Map<string, LocalWorkspace>, now = Date.now()): Workspace[] {
  const merged = [...list];
  for (const [id, entry] of [...local]) {
    if (list.some((w) => w.id === id) || now - entry.at > LOCAL_WORKSPACE_TTL_MS) local.delete(id);
    else merged.unshift(entry.workspace);
  }
  return merged;
}

export function upsertWorkspace(list: Workspace[], ws: Workspace): Workspace[] {
  return list.some((w) => w.id === ws.id) ? list.map((w) => (w.id === ws.id ? ws : w)) : [ws, ...list];
}

export const WORKSPACE_POLL_MS = 2000;

/**
 * Poll GET /api/workspaces/:id every `intervalMs` while `enabled` (the workspace is preparing). Pauses while the page is
 * hidden and resumes with an immediate fetch when it becomes visible again. Failures are reported through `onError`
 * and polling keeps going.
 */
export function useWorkspacePoll(
  id: string | undefined,
  enabled: boolean,
  onData: (ws: Workspace) => void,
  onError?: (e: unknown) => void,
  intervalMs = WORKSPACE_POLL_MS,
): void {
  const data = useRef(onData);
  const error = useRef(onError);
  data.current = onData;
  error.current = onError;

  useEffect(() => {
    if (!id || !enabled) return;
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (!stopped && !document.hidden) timer = setTimeout(() => void tick(), intervalMs);
    };
    const tick = async () => {
      if (stopped || running || document.hidden) return;
      running = true;
      try {
        const ws = await workspacesApi.get(id);
        if (!stopped) data.current(ws);
      } catch (e) {
        if (!stopped) error.current?.(e);
      } finally {
        running = false;
        schedule();
      }
    };
    const onVisibility = () => {
      if (stopped || document.hidden) return;
      clearTimeout(timer);
      void tick();
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id, enabled, intervalMs]);
}

/** What the App tells deep components (the Environment panel) about the selected workspace. */
export interface WorkspaceContextValue {
  workspace?: Workspace;
  /** True until the first workspace list has loaded. */
  loading?: boolean;
  onUpdate: (ws: Workspace) => void;
  /** Ask the App to refetch (after a rebuild changed the binding, say). */
  onChanged: () => void;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
