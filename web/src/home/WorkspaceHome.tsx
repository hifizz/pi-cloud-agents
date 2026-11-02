// The workspace home page (workspace-IA redesign): the surface opened by clicking a workspace in the rail.
// Compact header (repo, branch, status, refresh, settings) plus a 6-column grid of summary cards — Loops,
// Events, Issues, Pull requests, Integrations, Routines — each a real count + a few rows, with its full
// management surface behind a "查看全部" drawer. Only UI rearrangement: every action still hits the same APIs.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { loopsApi, triggerLabel, RUN_STATUS_LABEL, type Loop, type LoopRunStatus } from "../lib/loops";
import { OVERVIEW_SKELETON_MIN_MS, readOverviewCache, writeOverviewCache } from "../lib/overview-cache";
import {
  STATUS_LABEL,
  describeError,
  formatTime,
  type Workspace,
  type WorkspaceOverview,
  workspacesApi,
} from "../lib/workspaces";
import { SESSION_STATUS_LABEL, defaultSessionStatus, type BotSummary } from "../types";
import { eventsApi, EventsPanel, type EventsSyncState, type SyncEvent } from "../panels/events";
import { integrationsApi, integrationsPanel, type IntegrationInstall } from "../panels/integrations";
import { formatInterval, RoutinesPanel } from "../components/RoutinesPanel";
import { WorkspaceEnvSettings } from "../components/WorkspaceEnvSettings";
import { emptyVM } from "../lib/reducer";
import { Empty, EmptyDescription } from "../components/ui/empty";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { Button } from "../components/ui/button";
import { Icon } from "../components/Chat/primitives/Icon";
import { SidebarTrigger } from "../components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";

/** Which drawer is open. Each value mounts a detail surface only while open; undefined = closed.
 * Loops has no drawer: its full surface is the existing Loops pane (「管理全部 Loops」). */
export type HomeDrawer = "events" | "integrations" | "routines" | "issues" | "pulls" | "settings";

/** The payloads the home page caches, keyed by source name in the localStorage entry. */
interface HomeCacheData {
  overview?: WorkspaceOverview;
  loops?: Loop[];
  events?: EventsSyncState;
  installs?: IntegrationInstall[];
  routines?: Awaited<ReturnType<typeof api.listRoutines>>;
}

const SUMMARY_LIMIT = 12;
const BOTTOM_SHEET = "w-full rounded-t-2xl data-[side=bottom]:h-[75dvh] max-h-[90dvh]";
const ACTIVE_RUN = new Set<LoopRunStatus>(["queued", "starting", "running", "needs_approval"]);

/** One block of the home grid: header row (title + real count + actions) over a bordered summary body. */
function HomeCard({ title, count, actions, className, children, testId }: {
  title: string;
  count?: number;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section aria-label={title} className={`flex min-w-0 flex-col ${className ?? ""}`} data-testid={testId}>
      <div className="flex items-center justify-between gap-2 px-0.5 pb-1.5">
        <h3 className="flex min-w-0 items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span className="truncate">{title}</span>
          {count !== undefined && <span className="shrink-0 text-[11px] font-normal normal-case">{count}</span>}
        </h3>
        <span className="flex shrink-0 items-center gap-1">{actions}</span>
      </div>
      <div className="flex-1 rounded-xl border border-border bg-card p-3 text-[13px]">{children}</div>
    </section>
  );
}

/** One load source's terminal state: a failed fetch is an error the user can retry, never disguised as
 * "loading forever" and never rendered as an empty list / zero count. */
type Source<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: T };

const LOADING: Source<never> = { status: "loading" };

/** Rows of pulsing placeholders shaped like a summary card's body; used instead of a "加载中…" line while a
 * source has no cached snapshot. The `rows` count mirrors the content a card usually shows. */
function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="space-y-1.5">
          <Skeleton className="h-4" style={{ width: `${78 - i * 12}%` }} />
          <Skeleton className="h-3" style={{ width: `${55 - i * 8}%` }} />
        </li>
      ))}
    </ul>
  );
}

function SourceBody<T>({ source, retry, skeletonRows, children }: { source: Source<T>; retry: () => void; skeletonRows?: number; children: (data: T) => ReactNode }) {
  if (source.status === "loading") return <CardSkeleton rows={skeletonRows} />;
  if (source.status === "error")
    return (
      <p className="flex items-center gap-2 text-destructive" role="alert">
        <span className="min-w-0 flex-1 truncate" title={source.message}>加载失败：{source.message}</span>
        <Button type="button" variant="link" size="sm" onClick={retry} className="h-auto shrink-0 p-0 text-xs">
          重试
        </Button>
      </p>
    );
  return <>{children(source.data)}</>;
}

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

export interface WorkspaceHomeProps {
  workspace: Workspace;
  railOpen: boolean;
  /** All sessions; executions of THIS workspace are grouped under their issue, and routines/integrations scope to it. */
  bots: BotSummary[];
  onExpandRail: () => void;
  /** Issue 讨论 action: reuse the existing discussion or create one via the discuss flow. */
  onOpenIssue: (wsId: string, issue: number) => Promise<void>;
  /** Open an existing session (e.g. an execution session named on a result card). */
  onOpenSession: (botId: string) => void;
  /** PR row 打开 Review Session action; resolves when the review session is created/reused and opened. */
  onReview: (wsId: string, pr: number) => Promise<void>;
  /** Open the workspace's Loops management surface (list / editor). */
  onOpenLoops: () => void;
  /** Open one loop's run history directly. */
  onOpenLoopRuns: (loopId: string) => void;
  /** Closeable drawers; the parent mounts the matching detail surface for `drawer`. */
  drawer: HomeDrawer | undefined;
  onDrawerChange: (d: HomeDrawer | undefined) => void;
}

export function WorkspaceHome({
  workspace,
  railOpen,
  bots,
  onExpandRail,
  onOpenIssue,
  onOpenSession,
  onReview,
  onOpenLoops,
  onOpenLoopRuns,
  drawer,
  onDrawerChange,
}: WorkspaceHomeProps) {
  const cached = useMemo(() => readOverviewCache(workspace.id)?.data as HomeCacheData | undefined, [workspace.id]);
  // Each source initializes from the persisted snapshot when there is one, so a revisit renders content instantly;
  // the loaders below overwrite it with fresh data. `stale` marks "showing cache, fetch in flight" for the header.
  const [data, setData] = useState<Source<WorkspaceOverview>>(() => (cached?.overview ? { status: "ok", data: cached.overview } : LOADING));
  const [loops, setLoops] = useState<Source<Loop[]>>(() => (cached?.loops ? { status: "ok", data: cached.loops } : LOADING));
  const [events, setEvents] = useState<Source<EventsSyncState>>(() => (cached?.events ? { status: "ok", data: cached.events } : LOADING));
  const [installs, setInstalls] = useState<Source<IntegrationInstall[]>>(() => (cached?.installs ? { status: "ok", data: cached.installs } : LOADING));
  const [routines, setRoutines] = useState<Source<Awaited<ReturnType<typeof api.listRoutines>>>>(() => (cached?.routines ? { status: "ok", data: cached.routines } : LOADING));
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(() => cached !== undefined);
  /** True once any source produced content this mount; the skeleton delay only matters before that. */
  const hadContent = useRef(cached !== undefined);
  /** Pending delayed set-applies; cancelled on unmount so a workspace switch can't write state into a dead tree. */
  const pendingTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => pendingTimers.current.forEach(clearTimeout), []);
  /** Issue row expanded into its detail + actions panel (click toggles; it never starts a session by itself). */
  const [expandedIssue, setExpandedIssue] = useState<number>();
  /** Issue currently being opened via the discuss flow; disables every issue action until it resolves. */
  const [opening, setOpening] = useState<number>();
  /** PR whose review request is in flight; disables every Review button until it resolves. */
  const [reviewing, setReviewing] = useState<number>();
  const [selectedPr, setSelectedPr] = useState<number>();
  const [prFilter, setPrFilter] = useState<"open" | "closed" | "all">("open");

  // Routines live on a global list; only the ones attached to THIS workspace's sessions belong on this page.
  const wsBotIds = useMemo(
    () => new Set(bots.filter((b) => b.workspaceId === workspace.id || b.id === workspace.botId).map((b) => b.id)),
    [bots, workspace.id, workspace.botId],
  );

  // Independent sources: each summary card owns its fetch so one failure can't freeze or falsify the others.
  // Every loader writes its payload into the shared cache entry, and — only while the card still shows a skeleton
  // (no cache, nothing rendered yet) — holds the result back briefly so the skeleton can't flash for a sub-frame
  // instant. Once real content is on screen, fresh data applies the moment it arrives.
  const settle = useCallback(<T,>(set: (s: Source<T>) => void, patch: Partial<HomeCacheData>, started: number, ok: Source<T>) => {
    const apply = () => {
      set(ok);
      writeOverviewCache(workspace.id, patch);
      hadContent.current = true;
    };
    const delay = hadContent.current ? 0 : OVERVIEW_SKELETON_MIN_MS - (Date.now() - started);
    if (delay <= 0) {
      apply();
    } else {
      const t = setTimeout(() => {
        pendingTimers.current.delete(t);
        apply();
      }, delay);
      pendingTimers.current.add(t);
    }
  }, [workspace.id]);
  const loadOverview = useCallback(async () => {
    const started = Date.now();
    try {
      const v = await workspacesApi.overview(workspace.id, { allPrs: true });
      settle(setData, { overview: v }, started, { status: "ok", data: v });
    } catch (e) {
      settle(setData, {}, started, { status: "error", message: describeError(e) });
    }
  }, [workspace.id, settle]);
  const loadLoops = useCallback(async () => {
    const started = Date.now();
    try {
      const l = await loopsApi.list(workspace.id);
      const list = Array.isArray(l) ? l : [];
      settle(setLoops, { loops: list }, started, { status: "ok", data: list });
    } catch (e) {
      settle(setLoops, {}, started, { status: "error", message: describeError(e) });
    }
  }, [workspace.id, settle]);
  const loadEvents = useCallback(async () => {
    const started = Date.now();
    try {
      const v = await eventsApi.state(workspace.id);
      settle(setEvents, { events: v }, started, { status: "ok", data: v });
    } catch (e) {
      settle(setEvents, {}, started, { status: "error", message: describeError(e) });
    }
  }, [workspace.id, settle]);
  const loadInstalls = useCallback(async () => {
    const started = Date.now();
    try {
      const r = await integrationsApi.list(workspace.id);
      const list = r.installs ?? [];
      settle(setInstalls, { installs: list }, started, { status: "ok", data: list });
    } catch (e) {
      settle(setInstalls, {}, started, { status: "error", message: describeError(e) });
    }
  }, [workspace.id, settle]);
  const loadRoutines = useCallback(async () => {
    const started = Date.now();
    try {
      const v = await api.listRoutines();
      settle(setRoutines, { routines: v }, started, { status: "ok", data: v });
    } catch (e) {
      settle(setRoutines, {}, started, { status: "error", message: describeError(e) });
    }
  }, [settle]);

  const LOADERS = useMemo(() => [loadOverview, loadLoops, loadEvents, loadInstalls, loadRoutines], [loadOverview, loadLoops, loadEvents, loadInstalls, loadRoutines]);
  const load = useCallback(async () => {
    setLoading(true);
    await Promise.all(LOADERS.map((fn) => fn()));
    setStale(false);
    setLoading(false);
  }, [LOADERS]);
  /** Drawer close / action refresh: re-pull summaries without resetting their state to a global spinner. */
  const refresh = useCallback(() => void Promise.all(LOADERS.map((fn) => fn())), [LOADERS]);
  useEffect(() => {
    setExpandedIssue(undefined);
    void load();
  }, [load]);

  // Execution sessions of this workspace, grouped by issue. A bot is an execution only when issueLoop carries a
  // sourceBotId; discussions and review/manual sessions are never listed here.
  const executionsByIssue = useMemo(() => {
    const map = new Map<number, BotSummary[]>();
    for (const b of bots) {
      if (b.workspaceId !== workspace.id) continue;
      const issue = b.issueLoop?.sourceBotId ? b.issueLoop.issue : b.loopRun ? b.executionResult?.issue : undefined;
      if (!issue) continue;
      const list = map.get(issue) ?? [];
      list.push(b);
      map.set(issue, list);
    }
    return map;
  }, [bots, workspace.id]);

  const openIssue = async (issueNo: number) => {
    if (opening !== undefined) return;
    setOpening(issueNo);
    try {
      await onOpenIssue(workspace.id, issueNo);
    } finally {
      setOpening(undefined);
    }
  };

  const startReview = async (pr: number) => {
    if (reviewing !== undefined) return;
    setReviewing(pr);
    try {
      await onReview(workspace.id, pr);
    } finally {
      setReviewing(undefined);
    }
  };

  const overviewData = data.status === "ok" ? data.data : undefined;
  const openPulls = (overviewData?.pulls ?? []).filter((p) => p.state === "open" && !p.merged);
  const closedPulls = (overviewData?.pulls ?? []).filter((p) => !(p.state === "open" && !p.merged));
  const shownPulls = prFilter === "open" ? openPulls : prFilter === "closed" ? closedPulls : (overviewData?.pulls ?? []);
  const prStateLabel = (p: { state?: string; merged?: boolean }) => (p.merged ? "已合并" : p.state === "closed" ? "已关闭" : "开放");

  const loopList = loops.status === "ok" ? loops.data : [];
  const enabledLoops = loopList.filter((l) => l.enabled);
  const recentRuns = loopList
    .filter((l) => l.latestRun)
    .sort((a, b) => String(b.latestRun!.enqueuedAt).localeCompare(String(a.latestRun!.enqueuedAt)));

  // The server record is unshift-ordered (newest first, src/github-events.mjs record()); take the head, not the tail.
  const recentEvents = (events.status === "ok" && Array.isArray(events.data.record) ? events.data.record : []).slice(0, 4);
  const wsRoutines = (routines.status === "ok" ? routines.data : []).filter((r) => r.enabled && r.botId && wsBotIds.has(r.botId));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-overview">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        {!railOpen && <SidebarTrigger aria-label="Expand sidebar" title="Expand sidebar" onClick={onExpandRail} className="shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground" title={workspace.name}>{workspace.name}</h2>
            <Badge variant="secondary" className="shrink-0 px-1.5 text-[10.5px]">{STATUS_LABEL[workspace.status]}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground" title={`${workspace.repo} · ${workspace.branch}`}>
            {workspace.repo} · {workspace.branch}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="shrink-0">
          {loading ? (stale ? "更新中…" : "加载中…") : "刷新"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onDrawerChange("settings")}
          data-testid="open-workspace-settings"
          className="shrink-0"
        >
          <Icon name="settings" className="size-3.5" />
          设置
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
          <HomeCard
            title="Loops（自动运行）"
            count={loops.status === "ok" ? loops.data.length : undefined}
            testId="home-loops"
            className="md:col-span-1 xl:col-span-3"
            actions={
              <Button type="button" variant="link" size="sm" onClick={onOpenLoops} data-testid="open-loops" className="h-auto p-0">
                管理全部 Loops →
              </Button>
            }
          >
            <SourceBody source={loops} retry={() => void loadLoops()} skeletonRows={4}>
              {(loopList) =>
                loopList.length === 0 ? (
              <p className="text-muted-foreground">
                还没有 Loop。Loop 可以按定时计划、Webhook 或 GitHub 事件自动运行任务，
                <Button type="button" variant="link" size="sm" onClick={onOpenLoops} className="h-auto p-0 align-baseline">
                  新建一个 →
                </Button>
              </p>
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">
                <ul className="space-y-1.5">
                  {enabledLoops.slice(0, 4).map((loop) => (
                    <li key={loop.id} className="rounded-lg border border-border px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="link"
                          onClick={() => onOpenLoopRuns(loop.id)}
                          className="h-auto min-w-0 flex-1 justify-start truncate p-0 text-[13px] font-medium text-foreground"
                          title={loop.name}
                        >
                          {loop.name}
                        </Button>
                        <span className="shrink-0 text-[11px] text-muted-foreground" title={JSON.stringify(loop.trigger)}>
                          {triggerLabel(loop.trigger)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid={`overview-loop-last-${loop.id}`}>
                        {loop.latestRun
                          ? `最近：${RUN_STATUS_LABEL[loop.latestRun.status]} · ${formatTime(loop.latestRun.endedAt ?? loop.latestRun.enqueuedAt)}`
                          : "从未运行"}
                      </p>
                    </li>
                  ))}
                  {loopList.length > enabledLoops.length && (
                    <li className="px-1 text-[11px] text-muted-foreground">另有 {loopList.length - enabledLoops.length} 个已停用的 Loop，在管理页查看。</li>
                  )}
                </ul>
                {recentRuns.length > 0 && (
                  <div className="rounded-lg border border-border px-3 py-2">
                    <p className="pb-1 text-[11px] font-medium text-muted-foreground">最近运行</p>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {recentRuns.slice(0, 4).map((loop) => {
                        const run = loop.latestRun!;
                        return (
                          <li key={`${loop.id}-${run.id}`} className="flex items-center gap-2">
                            <span className={`shrink-0 font-medium ${ACTIVE_RUN.has(run.status) ? "text-warn" : run.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                              {RUN_STATUS_LABEL[run.status]}
                            </span>
                            <Button type="button" variant="link" onClick={() => onOpenLoopRuns(loop.id)} className="h-auto min-w-0 flex-1 justify-start truncate p-0 text-xs font-normal text-foreground">
                              {loop.name}
                            </Button>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(run.endedAt ?? run.enqueuedAt)}</span>
                            {run.botId && (
                              <Button type="button" variant="link" onClick={() => onOpenSession(run.botId!)} className="h-auto shrink-0 p-0 text-[11px]">
                                打开会话
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )
            }
            </SourceBody>
          </HomeCard>

          <HomeCard
            title="Events"
            count={events.status === "ok" ? events.data.record?.length : undefined}
            testId="home-events"
            className="md:col-span-1 xl:col-span-3"
            actions={
              <Button type="button" variant="link" size="sm" onClick={() => onDrawerChange("events")} data-testid="open-events" className="h-auto p-0">
                查看全部 →
              </Button>
            }
          >
            <SourceBody source={events} retry={() => void loadEvents()} skeletonRows={4}>
              {(ev) => (
              <>
                <div className="flex items-center gap-2 pb-1.5">
                  <Badge variant={ev.enabled ? "default" : "secondary"} className={ev.enabled ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15" : ""}>
                    {ev.enabled ? "已启用" : "已停用"}
                  </Badge>
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {ev.enabled
                      ? `每 ${ev.pollSec ?? 60} 秒轮询${ev.lastSyncAt ? ` · 上次 ${formatTime(ev.lastSyncAt)}` : ""}`
                      : "GitHub 事件同步未开启"}
                  </span>
                </div>
                {ev.lastError && <p className="pb-1 text-[11px] text-destructive">{ev.lastError}</p>}
                {recentEvents.length === 0 ? (
                  <p className="text-muted-foreground">{ev.enabled ? "尚无事件记录。" : "开启后，这里会汇总同步处理过的 GitHub 事件。"}</p>
                ) : (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {recentEvents.map((ev, i) => (
                      <li key={`${ev.kind}:${ev.id}:${i}`} className="flex items-center gap-2" title={eventHeadline(ev)}>
                        <Badge variant="secondary" className="shrink-0 px-1 text-[10px]">{KIND_LABEL[ev.kind]}</Badge>
                        <span className="min-w-0 flex-1 truncate">{eventHeadline(ev)}</span>
                        <span className="shrink-0 text-[11px]">{formatTime(ev.at ?? ev.seenAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
              )}
            </SourceBody>
          </HomeCard>

          <HomeCard
            title="Issues（未解决）"
            count={data.status === "ok" ? data.data.issues.length : undefined}
            testId="home-issues"
            className="min-h-[clamp(22rem,46dvh,32rem)] md:col-span-1 xl:col-span-3"
            actions={
              <Button type="button" variant="link" size="sm" onClick={() => onDrawerChange("issues")} data-testid="open-issues" className="h-auto p-0">
                查看全部 →
              </Button>
            }
          >
            <SourceBody source={data} retry={() => void loadOverview()} skeletonRows={6}>
              {(ov) =>
                ov.issues.length === 0 ? (
              <p className="text-muted-foreground">没有未解决的 issue。</p>
            ) : (
              <ul className="divide-y divide-border/60 text-[13px]">
                {ov.issues.slice(0, SUMMARY_LIMIT).map((issue) => (
                  <li key={issue.number} className="flex min-h-9 items-center gap-2 py-2" data-testid={`issue-summary-${issue.number}`} title={`#${issue.number} ${issue.title}`}>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">#{issue.number}</span>
                    <button type="button" onClick={() => { setExpandedIssue(issue.number); onDrawerChange("issues"); }} className="min-w-0 flex-1 text-left leading-5 hover:underline focus-visible:outline-2 focus-visible:outline-ring"><span className="line-clamp-2 break-words">{issue.title}</span></button>
                    {typeof issue.comments === "number" && issue.comments > 0 && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">💬 {issue.comments}</span>
                    )}
                    {issue.discussionBotId && <span className="shrink-0 text-[11px] text-muted-foreground">已有讨论</span>}
                  </li>
                ))}
                {ov.issues.length > SUMMARY_LIMIT && <li><Button type="button" variant="link" size="sm" className="px-1 text-xs" onClick={() => onDrawerChange("issues")}>还有 {ov.issues.length - SUMMARY_LIMIT} 个，查看全部 →</Button></li>}
              </ul>
            )
            }
            </SourceBody>
          </HomeCard>

          <HomeCard
            title="Pull requests"
            count={data.status === "ok" ? openPulls.length : undefined}
            testId="home-pulls"
            className="min-h-[clamp(22rem,46dvh,32rem)] md:col-span-1 xl:col-span-3"
            actions={
              <Button type="button" variant="link" size="sm" onClick={() => { setSelectedPr(undefined); onDrawerChange("pulls"); }} data-testid="open-pulls" className="h-auto p-0">
                查看全部 →
              </Button>
            }
          >
            <SourceBody source={data} retry={() => void loadOverview()} skeletonRows={6}>
              {() =>
                openPulls.length === 0 ? (
              <p className="text-muted-foreground">没有开放的 PR。</p>
            ) : (
              <ul className="divide-y divide-border/60 text-[13px]">
                {openPulls.slice(0, SUMMARY_LIMIT).map((pr) => (
                  <li key={pr.number} className="flex min-h-9 items-center gap-2 py-2" title={`#${pr.number} ${pr.title ?? ""}`}>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">#{pr.number}</span>
                    <button type="button" onClick={() => { setPrFilter("open"); setSelectedPr(pr.number); onDrawerChange("pulls"); }} className="min-w-0 flex-1 text-left leading-5 text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                      <span className="line-clamp-2 break-words">{pr.title ?? ""}</span>
                    </button>
                    {pr.updatedAt && <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(pr.updatedAt)}</span>}
                  </li>
                ))}
                {openPulls.length > SUMMARY_LIMIT && <li><Button type="button" variant="link" size="sm" className="px-1 text-xs" onClick={() => { setSelectedPr(undefined); onDrawerChange("pulls"); }}>还有 {openPulls.length - SUMMARY_LIMIT} 个开放的 PR，查看全部 →</Button></li>}
              </ul>
            )
            }
            </SourceBody>
          </HomeCard>

          <HomeCard
            title="Integrations"
            count={installs.status === "ok" ? installs.data.length : undefined}
            testId="home-integrations"
            className="md:col-span-1 xl:col-span-3"
            actions={
              <Button type="button" variant="link" size="sm" onClick={() => onDrawerChange("integrations")} data-testid="open-integrations" className="h-auto p-0">
                查看全部 →
              </Button>
            }
          >
            <SourceBody source={installs} retry={() => void loadInstalls()} skeletonRows={3}>
              {(list) =>
                list.length === 0 ? (
              <p className="text-muted-foreground">还没有安装集成。Skill 与 MCP 供 Pi Agent 使用；安装入口在「查看全部」。</p>
            ) : (
              <ul className="space-y-1 text-[13px]">
                {list.slice(0, 5).map((i) => (
                  <li key={i.id} className="flex items-center gap-2" title={i.description ?? i.name}>
                    <span className="min-w-0 flex-1 truncate">{i.name}</span>
                    {i.kind === "mcp" && <span className="shrink-0 text-[11px] text-muted-foreground">{i.toolCount ?? 0} 工具</span>}
                    <Badge variant="secondary" className="shrink-0 rounded-sm px-1 py-0.5 text-[10px] uppercase tracking-wide">{i.kind}</Badge>
                    {!i.enabled && <Badge variant="destructive" className="shrink-0 rounded-sm px-1 py-0.5 text-[10px] uppercase tracking-wide">停用</Badge>}
                  </li>
                ))}
                {list.length > 5 && <li><Button type="button" variant="link" size="sm" className="px-1 text-xs" onClick={() => onDrawerChange("integrations")}>还有 {list.length - 5} 个，查看全部 →</Button></li>}
              </ul>
            )
            }
            </SourceBody>
          </HomeCard>

          <HomeCard
            title="Routines"
            count={routines === undefined ? undefined : wsRoutines.length}
            testId="home-routines"
            className="md:col-span-1 xl:col-span-3"
            actions={
              <Button type="button" variant="link" size="sm" onClick={() => onDrawerChange("routines")} data-testid="open-routines" className="h-auto p-0">
                查看全部 →
              </Button>
            }
          >
            <SourceBody source={routines} retry={() => void loadRoutines()} skeletonRows={3}>
              {() =>
                wsRoutines.length === 0 ? (
              <p className="text-muted-foreground">本工作区的会话还没有 routine。Routine 挂在具体会话上定时发消息，新建入口在「查看全部」。</p>
            ) : (
              <ul className="space-y-1 text-[13px]">
                {wsRoutines.slice(0, 5).map((r) => (
                  <li key={r.id} className="flex items-center gap-2" title={r.prompt}>
                    <span className="min-w-0 flex-1 truncate">{r.prompt}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{r.bot ?? "unknown bot"}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatInterval(r)}</span>
                  </li>
                ))}
                {wsRoutines.length > 5 && <li><Button type="button" variant="link" size="sm" className="px-1 text-xs" onClick={() => onDrawerChange("routines")}>还有 {wsRoutines.length - 5} 个，查看全部 →</Button></li>}
              </ul>
            )
            }
            </SourceBody>
            {routines.status === "ok" && routines.data.some((r) => r.enabled && (!r.botId || !wsBotIds.has(r.botId))) && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">仅显示本工作区会话的 routine。</p>
            )}
          </HomeCard>
        </div>
      </div>

      {/* Full detail surfaces live in closeable drawers; each mounts only while open, so no stale fetches linger
          between drawers or after a workspace switch (the whole page is remounted by the parent key). */}
      <Sheet open={drawer === "issues"} onOpenChange={(open) => !open && onDrawerChange(undefined)}>
        <SheetContent side="bottom" className={BOTTOM_SHEET} data-testid="drawer-issues">
          <SheetHeader>
            <SheetTitle>Issues · {workspace.name}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {!overviewData || overviewData.issues.length === 0 ? (
              <Empty className="h-48">
                <EmptyDescription>没有未解决的 issue。</EmptyDescription>
              </Empty>
            ) : (
              <ul className="space-y-1.5">
                {overviewData.issues.map((issue) => {
                  const executions = executionsByIssue.get(issue.number) ?? [];
                  const expanded = expandedIssue === issue.number;
                  return (
                    <li key={issue.number}>
                      <button
                        type="button"
                        onClick={() => setExpandedIssue(expanded ? undefined : issue.number)}
                        aria-expanded={expanded}
                        className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-[13px] text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                        data-testid={`issue-row-${issue.number}`}
                        title={`#${issue.number} ${issue.title}`}
                      >
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">#{issue.number}</span>
                        <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                        {issue.author && <span className="shrink-0 text-[11px] text-muted-foreground">@{issue.author}</span>}
                        {typeof issue.comments === "number" && issue.comments > 0 && (
                          <span className="shrink-0 text-[11px] text-muted-foreground">💬 {issue.comments}</span>
                        )}
                        {issue.discussionBotId && <span className="shrink-0 text-[11px] text-muted-foreground">已有讨论</span>}
                        <span className="shrink-0 text-[11px] text-muted-foreground" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                      </button>
                      {expanded && (
                        <div className="mt-1 rounded-lg border border-border bg-card px-3 py-2 text-xs" data-testid={`issue-detail-${issue.number}`}>
                          <p className="text-muted-foreground">
                            #{issue.number} · {issue.state === "open" ? "开放" : (issue.state ?? "未知状态")}
                            {issue.author ? ` · 作者 @${issue.author}` : ""}
                            {typeof issue.comments === "number" ? ` · ${issue.comments} 条评论` : ""}
                            {issue.updatedAt ? ` · 更新于 ${formatTime(issue.updatedAt)}` : ""}
                          </p>
                          <p className="mt-1 text-muted-foreground">先看信息再决定动作；点击本行不会创建任何会话。</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void openIssue(issue.number)}
                              disabled={opening !== undefined}
                              data-testid={`issue-discuss-${issue.number}`}
                            >
                              {opening === issue.number ? "创建讨论中…" : issue.discussionBotId ? "打开讨论 Session" : "开始讨论 Session"}
                            </Button>
                            {issue.url && (
                              <a href={issue.url} target="_blank" rel="noreferrer" className="text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                                在 GitHub 查看 ↗
                              </a>
                            )}
                          </div>
                        </div>
                      )}
                      {executions.length > 0 && (
                        <ul className="ml-4 mt-1 space-y-1" aria-label={`issue #${issue.number} 执行结果`}>
                          {executions.map((exec) => {
                            const result = exec.executionResult;
                            const st = defaultSessionStatus(exec);
                            return (
                              <li key={exec.id} className="rounded-lg border border-border bg-card px-3 py-2 text-[13px]" data-testid={`exec-card-${exec.id}`}>
                                <div className="flex items-center gap-2">
                                  <Button type="button" variant="link" onClick={() => onOpenSession(exec.id)} className="h-auto min-w-0 flex-1 justify-start truncate p-0 text-[13px] font-medium text-foreground">
                                    {exec.name}
                                  </Button>
                                  {/* Business status; 待确认 is a pending human decision, not an approval state. */}
                                  <Badge variant="secondary" className="shrink-0">{SESSION_STATUS_LABEL[st]}</Badge>
                                </div>
                                <p className="mt-1 text-muted-foreground">{result?.summary ?? "未记录"}</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {result?.testsReportedByHuman ? <>测试记录（人工填写）: {result.testsReportedByHuman}</> : "测试记录: 未记录"}
                                </p>
                                {result?.pull && (
                                  <a href={result.pull.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-xs text-primary underline">
                                    #{result.pull.number} {result.pull.title}
                                    {result.pull.state && <span className="ml-1 text-muted-foreground no-underline">{result.pull.state}</span>}
                                  </a>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={drawer === "pulls"} onOpenChange={(open) => !open && onDrawerChange(undefined)}>
        <SheetContent side="bottom" className={BOTTOM_SHEET} data-testid="drawer-pulls">
          <SheetHeader>
            <SheetTitle>Pull requests · {workspace.name}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <div className="pb-2">
              <ToggleGroup
                value={[prFilter]}
                onValueChange={(v: string[]) => v[0] && setPrFilter(v[0] as "open" | "closed" | "all")}
                size="sm"
                spacing={1}
                className="flex items-center gap-1"
                aria-label="PR 状态筛选"
              >
                {([
                  ["open", `开放 ${openPulls.length}`],
                  ["closed", `已关闭 ${closedPulls.length}`],
                  ["all", `全部 ${(overviewData?.pulls ?? []).length}`],
                ] as const).map(([key, label]) => (
                  <ToggleGroupItem key={key} value={key} className="h-auto px-2 py-0.5 text-[11px] font-medium">
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {shownPulls.length === 0 ? (
              <Empty className="h-48">
                <EmptyDescription>{prFilter === "open" ? "没有开放的 PR。" : "没有符合条件的 PR。"}</EmptyDescription>
              </Empty>
            ) : (
              <ul className="space-y-1.5">
                {shownPulls.map((pr) => (
                  <li key={pr.number} data-selected={selectedPr === pr.number ? "true" : undefined} ref={(node) => { if (selectedPr === pr.number) node?.scrollIntoView?.({ block: "nearest" }); }} className="rounded-lg border border-border bg-card px-3 py-2 text-[13px] data-[selected=true]:border-primary">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">#{pr.number}</span>
                      <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring" title={pr.title ?? ""}>
                        {pr.title ?? ""}
                      </a>
                      <Badge variant={pr.merged ? "secondary" : pr.state === "closed" ? "destructive" : "outline"} className="shrink-0">
                        {prStateLabel(pr)}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {pr.headRef && <span className="min-w-0 truncate font-mono">{pr.headRef}</span>}
                      {pr.updatedAt && <span className="shrink-0">更新于 {formatTime(pr.updatedAt)}</span>}
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void startReview(pr.number)}
                          disabled={reviewing !== undefined}
                          data-testid={`pr-review-${pr.number}`}
                        >
                          {reviewing === pr.number ? "创建 Review Session 中…" : "打开 Review Session"}
                        </Button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <Sheet open={drawer === "events"} onOpenChange={(open) => { if (!open) { onDrawerChange(undefined); refresh(); } }}>
        <SheetContent side="bottom" className={BOTTOM_SHEET} data-testid="drawer-events">
          <SheetHeader>
            <SheetTitle>Events · {workspace.name}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {/* The full events surface, same component the removed right-panel tab rendered. */}
            {drawer === "events" && <EventsPanel bots={bots} vm={emptyVM()} />}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={drawer === "integrations"} onOpenChange={(open) => { if (!open) { onDrawerChange(undefined); refresh(); } }}>
        <SheetContent side="bottom" className={BOTTOM_SHEET} data-testid="drawer-integrations">
          <SheetHeader>
            <SheetTitle>Integrations · {workspace.name}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {/* No bot prop on the home page: the panel makes the user pick a workspace session explicitly. */}
            {drawer === "integrations" && <integrationsPanel.Component bots={bots} vm={emptyVM()} />}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={drawer === "routines"} onOpenChange={(open) => { if (!open) { onDrawerChange(undefined); refresh(); } }}>
        <SheetContent side="bottom" className={BOTTOM_SHEET} data-testid="drawer-routines">
          <SheetHeader>
            <SheetTitle>Routines · {workspace.name}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {/* Scoped to this workspace's sessions: its routines only, and new routines can only target them. */}
            {drawer === "routines" && (
              <RoutinesPanel bots={bots.filter((b) => wsBotIds.has(b.id))} botIds={wsBotIds} embedded />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={drawer === "settings"} onOpenChange={(open) => !open && onDrawerChange(undefined)}>
        <SheetContent side="right" className="w-full sm:max-w-lg" data-testid="drawer-settings">
          <SheetHeader>
            <SheetTitle>设置 · {workspace.name}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {drawer === "settings" && <WorkspaceEnvSettings workspaceId={workspace.id} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
