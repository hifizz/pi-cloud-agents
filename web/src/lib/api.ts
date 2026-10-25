// REST wrapper for the TARSBot backend (src/api.mjs). Same-origin; Vite proxies /api in dev.
import type { BotMemory, BotSummary, ForkInput, HookItem, JobItem, NewBotInput, NewRoutineInput, RoutineItem, SkillItem, SpaceInfo } from "../types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type WhenBusy = "steer" | "followUp" | "reject";

const unauthorizedHandlers = new Set<() => void>();

/** Subscribe to 401 responses from any request. Returns an unsubscribe function. */
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedHandlers.add(fn);
  return () => {
    unauthorizedHandlers.delete(fn);
  };
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: unknown;
  const text = await res.text();
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  if (!res.ok) {
    const msg = (payload as { error?: string } | undefined)?.error ?? (text.slice(0, 200) || res.statusText);
    if (res.status === 401) for (const fn of [...unauthorizedHandlers]) fn();
    throw new ApiError(res.status, msg);
  }
  return payload as T;
}

export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const enc = encodeURIComponent;

export const api = {
  listBots: () => request<BotSummary[]>("GET", "/api/bots"),
  createBot: (input: NewBotInput) => request<BotSummary>("POST", "/api/bots", input),
  sendInput: (botId: string, text: string, opts: { whenBusy?: WhenBusy; requestId?: string } = {}) =>
    request<{ submissionId: number | string }>("POST", `/api/bots/${enc(botId)}/input`, {
      text,
      ...(opts.whenBusy ? { whenBusy: opts.whenBusy } : {}),
      requestId: opts.requestId ?? newRequestId(),
    }),
  abort: (botId: string, background = false) => request<{ ok: true }>("POST", `/api/bots/${enc(botId)}/abort`, background ? { background: true } : {}),
  compact: (botId: string, instructions?: string) =>
    request<{ taskId: unknown }>("POST", `/api/bots/${enc(botId)}/compact`, instructions ? { instructions } : {}),
  reset: (botId: string, note?: string) => request<{ ok: true }>("POST", `/api/bots/${enc(botId)}/reset`, note ? { note } : {}),
  usage: () => request<unknown>("GET", "/api/usage"),
  entries: (botId: string, limit = 100) => request<unknown[]>("GET", `/api/bots/${enc(botId)}/entries?limit=${limit}`),
  /** POST /api/bots/:id/fork. The route validates `entryId` as a string. */
  forkBot: (botId: string, input: ForkInput) =>
    request<BotSummary>("POST", `/api/bots/${enc(botId)}/fork`, {
      name: input.name,
      readOnly: input.readOnly,
      ...(input.entryId !== undefined ? { entryId: String(input.entryId) } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
    }),
  resolveApproval: (taskId: string, approved: boolean) =>
    request<{ ok: true }>("POST", `/api/approvals/${enc(taskId)}`, { approved }),
  listRoutines: () => request<RoutineItem[]>("GET", "/api/routines"),
  createRoutine: (input: NewRoutineInput) => request<RoutineItem>("POST", "/api/routines", input),
  cancelRoutine: (id: string) => request<{ ok: true; id: string }>("POST", `/api/routines/${enc(id)}/cancel`, {}),
  space: () => request<SpaceInfo>("GET", "/api/space"),
  answerAsk: (id: string, answer: string) => request<{ ok: true }>("POST", `/api/asks/${enc(id)}`, { answer }),
  listHooks: () => request<HookItem[]>("GET", "/api/hooks"),
  mintHook: (botId: string) => request<{ botId: string; token: string; url: string }>("POST", `/api/hooks/${enc(botId)}`, {}),
  listJobs: () => request<JobItem[]>("GET", "/api/jobs"),
  botMemory: (botId: string) => request<BotMemory>("GET", `/api/bots/${enc(botId)}/memory`),
  botSkills: (botId: string) => request<SkillItem[]>("GET", `/api/bots/${enc(botId)}/skills`),
};

export const googleLoginUrl = "/api/auth/google";

export const auth = {
  me: () => request<{ email: string }>("GET", "/api/auth/me"),
  login: (email: string, password: string) => request<{ email: string }>("POST", "/api/auth/login", { email, password }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
};
