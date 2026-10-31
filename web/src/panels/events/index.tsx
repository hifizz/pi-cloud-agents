// AMP13-events panel: per-workspace GitHub event sync. The user explicitly enables it, presses "立即同步" to poll
// once, sees every processed event with its outcome, and appends an event to a session explicitly (or lets
// autoAppend do it for subscribed issues/PRs). Off by default; no public webhook; test repo only (server enforces).
import { useCallback, useContext, useEffect, useState } from "react";
import { request } from "../../lib/api";
import { WorkspaceContext, describeError, formatTime } from "../../lib/workspaces";
import type { PanelContext, PanelDefinition } from "../types";

/** One normalized GitHub event entry in the sync record (server shape). */
export interface SyncEvent {
  id: string;
  kind: "issue" | "pr" | "comment" | "review" | "review_comment" | "ci" | "checks";
  action?: string;
  state?: string | null;
  number?: number | null;
  title?: string;
  url?: string | null;
  actor?: string | null;
  at?: string | null;
  body?: string;
  isPr?: boolean;
  /** ci events */
  sha?: string;
  ref?: string;
  from?: string | null;
  targetUrl?: string | null;
  /** added by the server record */
  outcome?: string;
  seenAt?: string;
  delivered?: boolean;
  botId?: string;
}

export interface EventSubscription {
  key: string; // "issue:12" | "pr:34"
  botId: string;
  name?: string;
  at?: string;
}

export interface PrCheckRollup {
  pr: number;
  headSha: string;
  state: string;
}

export interface EventsSyncState {
  enabled: boolean;
  autoCreate: boolean;
  autoAppend: boolean;
  lastSyncAt: string | null;
  /** ISO time of the next scheduled background poll (null when polling is off / manual-only). */
  nextSyncAt: string | null;
  /** Per-workspace poll interval override (seconds); null = server default (60s). */
  pollSec: number | null;
  /** Number of timer-driven syncs since the state file was created. */
  pollCount?: number;
  lastError: string | null;
  lastResult: { events: number; appended: number; created: number; seeded?: number } | null;
  /** Baseline commit combined status (commit statuses — does NOT include Actions check runs). */
  baseline: { sha: string; state: string } | null;
  /** Per subscribed PR: head commit Checks-API rollup (this is where GitHub Actions reports). */
  prChecks?: PrCheckRollup[];
  subscriptions: EventSubscription[];
  record: SyncEvent[];
}

const enc = encodeURIComponent;

export const eventsApi = {
  state: (wsId: string) => request<EventsSyncState>("GET", `/api/workspaces/${enc(wsId)}/events`),
  configure: (wsId: string, input: { enabled?: boolean; autoCreate?: boolean; autoAppend?: boolean; pollSec?: number | null }) =>
    request<EventsSyncState>("POST", `/api/workspaces/${enc(wsId)}/events/configure`, input),
  sync: (wsId: string) => request<EventsSyncState>("POST", `/api/workspaces/${enc(wsId)}/events/sync`, {}),
  send: (wsId: string, input: { eventId: string; botId: string }) =>
    request<{ sent: boolean; botId: string; name: string }>("POST", `/api/workspaces/${enc(wsId)}/events/send`, input),
  subscribe: (wsId: string, input: { target: string; botId: string }) =>
    request<EventsSyncState>("POST", `/api/workspaces/${enc(wsId)}/events/subscribe`, input),
  disable: (wsId: string) => request<EventsSyncState>("POST", `/api/workspaces/${enc(wsId)}/events/disable`, {}),
};

const btn =
  "rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";
const btnAccent = "rounded-md bg-brand px-3 py-1 text-xs font-medium text-white hover:brightness-110 disabled:opacity-40";

const KIND_LABEL: Record<SyncEvent["kind"], string> = {
  issue: "Issue",
  pr: "PR",
  comment: "评论",
  review: "Review",
  review_comment: "Review 评论",
  ci: "基线状态",
  checks: "PR 检查",
};

function eventHeadline(ev: SyncEvent): string {
  const actor = ev.actor ? `@${ev.actor}` : "";
  switch (ev.kind) {
    case "issue":
      return `${actor} 新建 Issue #${ev.number}「${ev.title}」`;
    case "pr":
      return `${actor} ${ev.action} PR #${ev.number}「${ev.title}」`;
    case "comment":
      return `${actor} 评论了 ${ev.isPr ? "PR" : "Issue"} #${ev.number}「${ev.title}」`;
    case "review":
      return `${actor} 提交了 PR #${ev.number} 的 ${ev.state ?? "review"}`;
    case "review_comment":
      return `${actor} 在 PR #${ev.number} 留下 review 评论`;
    case "ci":
      return `基线 ${String(ev.sha).slice(0, 12)}（${ev.ref}）combined status：${ev.from ?? "?"} → ${ev.state}`;
    case "checks":
      return `PR #${ev.number} head @ ${String(ev.sha).slice(0, 12)} 检查：${ev.from ?? "?"} → ${ev.state}`;
  }
}

/** Target key an event would subscribe under ("issue:12" / "pr:34"); null for events without a number. */
function eventTargetKey(ev: SyncEvent): string | null {
  if (typeof ev.number !== "number" || ev.number <= 0) return null;
  return `${ev.isPr ? "pr" : "issue"}:${ev.number}`;
}

function Toggle({ label, checked, disabled, onChange, hint }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-xs text-fg">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <span>
        {label}
        {hint && <span className="block text-fg-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function EventsPanel({ bots }: PanelContext) {
  const wsCtx = useContext(WorkspaceContext);
  const workspace = wsCtx?.workspace;
  const wsId = workspace?.id;
  const [state, setState] = useState<EventsSyncState>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sendTarget, setSendTarget] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      setState(await eventsApi.state(wsId));
      setError(undefined);
    } catch (e) {
      setError(describeError(e));
    }
  }, [wsId]);

  useEffect(() => {
    setState(undefined);
    void load();
  }, [load]);

  if (!workspace) {
    return <p className="p-4 text-sm text-fg-muted">{wsCtx?.loading ? "加载中…" : "选择一个工作区后，这里可以同步它绑定仓库的 GitHub 事件。"}</p>;
  }

  // Sessions of this workspace that can receive appended events.
  const sessions = bots.filter((b) => b.workspaceId === workspace.id || b.id === workspace.botId);

  const run = async (fn: () => Promise<EventsSyncState | unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      const out = await fn();
      if (out && typeof out === "object" && "enabled" in out) setState(out as EventsSyncState);
      else await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const keyOf = (ev: SyncEvent) => `${ev.kind}:${ev.id}`;
  const subscribed = (ev: SyncEvent) => {
    const k = eventTargetKey(ev);
    return k ? state?.subscriptions.find((s) => s.key === k) : undefined;
  };
  const defaultTarget = (ev: SyncEvent) => subscribed(ev)?.botId ?? sessions[0]?.id ?? "";

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <section aria-label="GitHub 事件同步" className="space-y-3 rounded-lg border border-line bg-raised p-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">GitHub 事件同步</h3>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${state?.enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-zinc-500/15 text-fg-muted"}`}>
            {state ? (state.enabled ? "已启用" : "已停用") : "…"}
          </span>
        </div>
        <p className="text-xs text-fg-muted">
          后台轮询 <code className="font-mono">{workspace.repo}</code> 的认证事件 feed（仅限测试仓库；默认每 60 秒一次，也可点「立即同步」手动触发）。不是 webhook；不写 GitHub。外部内容视为不可信材料。
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-fg-muted">轮询</dt>
          <dd className="text-fg">
            {state?.enabled ? (
              <>
                每 {state.pollSec ?? 60} 秒自动同步
                {state.nextSyncAt ? ` · 下次 ${formatTime(state.nextSyncAt)}` : ""}
                {typeof state.pollCount === "number" && state.pollCount > 0 ? ` · 已自动同步 ${state.pollCount} 次` : ""}
              </>
            ) : (
              "已停止（不轮询；重新开启后恢复）"
            )}
          </dd>
          <dt className="text-fg-muted">最后同步</dt>
          <dd className="text-fg">{formatTime(state?.lastSyncAt) || "从未"}</dd>
          {state?.lastResult && (
            <>
              <dt className="text-fg-muted">上次结果</dt>
              <dd className="text-fg">
                {state.lastResult.events} 新事件 · {state.lastResult.appended} 条已追加 · {state.lastResult.created} 个新会话
                {state.lastResult.seeded !== undefined && `（首次启用已标记 ${state.lastResult.seeded} 条历史，不重放）`}
              </dd>
            </>
          )}
          {state?.baseline && (
            <>
              <dt className="text-fg-muted">基线 CI</dt>
              <dd className="text-fg">
                <code className="font-mono">{state.baseline.sha.slice(0, 12)}</code> {state.baseline.state}
                <span className="ml-1 text-fg-muted">（combined status，不含 Actions checks）</span>
              </dd>
            </>
          )}
          {state?.prChecks && state.prChecks.length > 0 && (
            <>
              <dt className="text-fg-muted">PR 检查</dt>
              <dd className="text-fg">
                {state.prChecks.map((c) => (
                  <span key={c.pr} className="mr-3 inline-block">
                    #{c.pr} <code className="font-mono">{c.headSha.slice(0, 7)}</code> {c.state}
                  </span>
                ))}
                <span className="text-fg-muted">（head commit 的 check runs）</span>
              </dd>
            </>
          )}
          {state?.lastError && (
            <>
              <dt className="text-fg-muted">上次错误</dt>
              <dd className="text-bad">{state.lastError}</dd>
            </>
          )}
        </dl>

        {state && (
          <div className="space-y-2 border-t border-line pt-3">
            <Toggle
              label="新 Issue/PR 自动建立讨论/Review 会话"
              hint="复用现有 issue-loop / review 流程；同一编号不重复创建"
              checked={state.autoCreate}
              disabled={busy || !state.enabled}
              onChange={(v) => void run(() => eventsApi.configure(workspace.id, { autoCreate: v }))}
            />
            <Toggle
              label="订阅的 Issue/PR 有新评论/Review 时自动追加到对应会话"
              hint="未开启时事件仅显示在下方列表，可手动追加"
              checked={state.autoAppend}
              disabled={busy || !state.enabled}
              onChange={(v) => void run(() => eventsApi.configure(workspace.id, { autoAppend: v }))}
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-bad">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {state?.enabled ? (
            <>
              <button type="button" className={btnAccent} disabled={busy} onClick={() => void run(() => eventsApi.sync(workspace.id))}>
                {busy ? "同步中…" : "立即同步"}
              </button>
              <button type="button" className={btn} disabled={busy} onClick={() => void run(() => eventsApi.disable(workspace.id))}>
                停止同步
              </button>
            </>
          ) : (
            <button type="button" className={btnAccent} disabled={busy} onClick={() => void run(() => eventsApi.configure(workspace.id, { enabled: true }))}>
              {busy ? "开启中…" : "开启事件同步"}
            </button>
          )}
        </div>
      </section>

      {state?.subscriptions && state.subscriptions.length > 0 && (
        <section aria-label="订阅" className="space-y-2 rounded-lg border border-line bg-raised p-4 text-sm">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">订阅</h3>
          <ul className="space-y-1 text-xs">
            {state.subscriptions.map((s) => (
              <li key={s.key} className="flex items-center justify-between gap-2">
                <code className="font-mono text-fg">{s.key}</code>
                <a className="text-accent underline" href={`?bot=${enc(s.botId)}`}>
                  {s.name ?? s.botId}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="事件记录" className="space-y-2">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">事件记录</h3>
        {!state || state.record.length === 0 ? (
          <p className="px-1 text-xs text-fg-muted">{state?.enabled ? "尚无事件。点「立即同步」拉取最新动态。" : "开启同步后，这里会列出每次同步处理过的事件。"}</p>
        ) : (
          <ul className="space-y-2">
            {state.record.map((ev, i) => {
              const k = keyOf(ev);
              const sub = subscribed(ev);
              return (
                <li key={`${k}-${i}`} data-testid="event-item" className="rounded-lg border border-line bg-raised p-3 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="mr-2 rounded bg-zinc-500/15 px-1 py-0.5 text-[10px] font-medium text-fg-muted">{KIND_LABEL[ev.kind]}</span>
                      <span className="break-words text-fg">{eventHeadline(ev)}</span>
                    </div>
                    <span className="shrink-0 text-fg-muted">{formatTime(ev.at ?? ev.seenAt)}</span>
                  </div>
                  {ev.url && (
                    <a className="mt-1 block truncate text-accent underline" href={ev.url} target="_blank" rel="noreferrer">
                      {ev.url}
                    </a>
                  )}
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className={`text-fg-muted ${ev.outcome?.startsWith("error") ? "text-bad" : ""}`}>{ev.outcome ?? ""}</span>
                    {state.enabled && sessions.length > 0 && !ev.delivered && ev.kind !== "ci" && ev.kind !== "checks" && (
                      <span className="flex items-center gap-1">
                        <select
                          aria-label={`追加事件 ${k} 到会话`}
                          className="rounded border border-line-strong bg-field px-1 py-0.5 text-xs text-fg"
                          value={sendTarget[k] ?? defaultTarget(ev)}
                          onChange={(e) => setSendTarget((m) => ({ ...m, [k]: e.target.value }))}
                        >
                          {sub && <option value={sub.botId}>{sub.name ?? sub.botId}（已订阅）</option>}
                          {sessions.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                        <button type="button" className={btn} disabled={busy || !eventTargetKey(ev)}
                          onClick={() => void run(() => eventsApi.subscribe(workspace.id, { target: eventTargetKey(ev)!, botId: sendTarget[k] ?? defaultTarget(ev) }))}>
                          订阅后续事件
                        </button>
                        <button
                          type="button"
                          className={btn}
                          disabled={busy}
                          onClick={() => void run(() => eventsApi.send(workspace.id, { eventId: k, botId: sendTarget[k] ?? defaultTarget(ev) }))}
                        >
                          追加到会话
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export const eventsPanel: PanelDefinition = {
  id: "events",
  title: "Events",
  icon: "globe",
  Component: EventsPanel,
};
