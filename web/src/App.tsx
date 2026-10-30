import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./lib/api";
import { useBotStream } from "./hooks/useBotStream";
import { BotList } from "./components/BotList";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
import { WorkspaceStatus } from "./components/WorkspaceStatus";
import { ApprovalBar } from "./components/ApprovalBar";
import { ForkDialog } from "./components/ForkDialog";
import { useApprovals } from "./hooks/useApprovals";
import { MessageList } from "./components/Chat/MessageList";
import { Icon } from "./components/Chat/primitives/Icon";
import { Composer, type SendMode } from "./components/Chat/Composer";
import { WorkspaceShell } from "./shell/WorkspaceShell";
import { PanelHost } from "./shell/PanelHost";
import { SessionHeader } from "./shell/SessionHeader";
import { StatusLine } from "./shell/ComposerContext";
import { RailFooter, RailHeader } from "./shell/rail";
import { usePanelState } from "./shell/usePanelState";
import { useRailState } from "./shell/useRailState";
import { PANELS } from "./panels";
import {
  STATUS_LABEL,
  WorkspaceContext,
  describeError,
  mapBotsToWorkspaces,
  mergeWorkspaceList,
  upsertWorkspace,
  useWorkspacePoll,
  workspacesApi,
  type LocalWorkspace,
  type Workspace,
  type WorkspaceContextValue,
  type WorkspaceOverview,
} from "./lib/workspaces";
import { SESSION_STATUS_LABEL, defaultSessionStatus, type BotSummary, type ForkInput, type SessionStatus } from "./types";

/** Small publish-task form for an issue-loop discussion session. Empty input; the human writes the task explicitly. */
function PublishTaskForm({ busy, error, onPublish, onCancel }: { busy: boolean; error?: string; onPublish: (task: string) => void; onCancel: () => void }) {
  const [task, setTask] = useState("");
  return (
    <form
      aria-label="发布任务"
      className="mx-auto w-full max-w-[720px] px-[18px] pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (task.trim() && !busy) onPublish(task);
      }}
    >
      <div className="rounded-lg border border-line-strong bg-raised p-3">
        <label className="block text-xs font-medium text-fg-muted" htmlFor="publish-task-input">
          发布任务（逐字作为新执行会话的首条消息；不会带入本讨论的内容）
        </label>
        <textarea
          id="publish-task-input"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="写下要执行的任务…"
          rows={3}
          className="mt-2 w-full resize-y rounded-md border border-line bg-field px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {error && (
          <p role="alert" className="mt-1 text-xs text-bad">
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover">
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !task.trim()}
            className="rounded-md bg-brand px-3 py-1 text-xs font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
          >
            {busy ? "发布中…" : "确认发布"}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Central workspace overview (SPIKE-workspace-overview): open unresolved issues and open, unmerged PRs of the
 * workspace's bound repo. Fetches once when the workspace is opened and on the manual 刷新 button — it is NOT part
 * of the 3s bots poll. Clicking an issue reuses its existing discussion or creates one via the discuss flow; a PR
 * row's Review button starts a review session pinned at the PR head SHA. Execution sessions of this workspace are
 * grouped under their issue (issueLoop.issue/sourceBotId) as result cards; clicking a name opens that session. */
function WorkspaceOverview({
  workspace,
  railOpen,
  bots,
  onExpandRail,
  onOpenIssue,
  onOpenSession,
  onReview,
}: {
  workspace: Workspace;
  railOpen: boolean;
  /** All sessions; execution bots of THIS workspace are grouped under their issue below. */
  bots: BotSummary[];
  onExpandRail: () => void;
  /** Returns a promise so the row can stay disabled until the discuss flow resolves (simplest repeated-click guard). */
  onOpenIssue: (wsId: string, issue: number) => Promise<void>;
  /** Open an existing session (e.g. an execution session named on a result card). */
  onOpenSession: (botId: string) => void;
  /** PR row Review action; resolves when the review session is created/reused and opened. */
  onReview: (wsId: string, pr: number) => Promise<void>;
}) {
  const [data, setData] = useState<WorkspaceOverview>();
  const [err, setErr] = useState<string>();
  const [loading, setLoading] = useState(true);
  /** Issue currently being opened via the discuss flow; disables every issue row until it resolves. */
  const [opening, setOpening] = useState<number>();
  /** PR whose review request is in flight; disables every Review button until it resolves. */
  const [reviewing, setReviewing] = useState<number>();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await workspacesApi.overview(workspace.id));
      setErr(undefined);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [workspace.id]);
  useEffect(() => {
    void load();
  }, [load]);

  // Execution sessions of this workspace, grouped by issue. A bot is an execution only when issueLoop carries a
  // sourceBotId; discussions and review/manual sessions are never listed here.
  const executionsByIssue = useMemo(() => {
    const map = new Map<number, BotSummary[]>();
    for (const b of bots) {
      if (b.workspaceId !== workspace.id || !b.issueLoop?.sourceBotId || !b.issueLoop.issue) continue;
      const list = map.get(b.issueLoop.issue) ?? [];
      list.push(b);
      map.set(b.issueLoop.issue, list);
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

  const row = "flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-[13px] text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-overview">
      {!railOpen && (
        <div className="flex h-14 shrink-0 items-center border-b border-line px-4">
          <button
            type="button"
            aria-label="Expand sidebar"
            title="Expand sidebar"
            onClick={onExpandRail}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Icon name="sidebar" className="size-4" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-fg">{workspace.name}</h2>
              <p className="mt-0.5 text-xs text-fg-muted">
                {workspace.repo} · {STATUS_LABEL[workspace.status]}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover disabled:opacity-40"
            >
              {loading ? "加载中…" : "刷新"}
            </button>
          </div>

          {err && (
            <p role="alert" className="text-sm text-bad">
              {err}
            </p>
          )}
          {loading && !data && !err && <p className="text-sm text-fg-muted">加载中…</p>}

          {data && (
            <>
              <section aria-label="Issues">
                <h3 className="pb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">Issues</h3>
                {data.issues.length === 0 ? (
                  <p className="text-sm text-fg-muted">没有未解决的 issue。</p>
                ) : (
                  <ul className="space-y-1">
                    {data.issues.map((issue) => {
                      const executions = executionsByIssue.get(issue.number) ?? [];
                      return (
                        <li key={issue.number}>
                          <button type="button" onClick={() => void openIssue(issue.number)} disabled={opening !== undefined} className={`${row} disabled:opacity-50`}>
                            <span className="shrink-0 font-mono text-xs text-fg-muted">#{issue.number}</span>
                            <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                            {opening === issue.number && <span className="shrink-0 text-[11px] text-fg-muted">打开中…</span>}
                            {issue.discussionBotId && opening !== issue.number && <span className="shrink-0 text-[11px] text-fg-faint">已有讨论</span>}
                          </button>
                          {executions.length > 0 && (
                            <ul className="ml-4 mt-1 space-y-1" aria-label={`issue #${issue.number} 执行结果`}>
                              {executions.map((exec) => {
                                const result = exec.executionResult;
                                const st = defaultSessionStatus(exec);
                                return (
                                  <li key={exec.id} className="rounded-lg border border-line px-3 py-2 text-[13px]" data-testid={`exec-card-${exec.id}`}>
                                    <div className="flex items-center gap-2">
                                      <button type="button" onClick={() => onOpenSession(exec.id)} className="min-w-0 flex-1 truncate text-left font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-accent">
                                        {exec.name}
                                      </button>
                                      {/* Business status; 待确认 is a pending human decision, not an approval state. */}
                                      <span className="shrink-0 text-[11px] text-fg-muted">{SESSION_STATUS_LABEL[st]}</span>
                                    </div>
                                    <p className="mt-1 text-fg-dim">{result?.summary ?? "未记录"}</p>
                                    <p className="mt-0.5 text-xs text-fg-muted">
                                      {result?.testsReportedByHuman ? <>测试记录（人工填写）: {result.testsReportedByHuman}</> : "测试记录: 未记录"}
                                    </p>
                                    {result?.pull && (
                                      <a href={result.pull.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-xs text-accent underline">
                                        #{result.pull.number} {result.pull.title}
                                        {result.pull.state && <span className="ml-1 text-fg-muted no-underline">{result.pull.state}</span>}
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
              </section>

              <section aria-label="Pull requests">
                <h3 className="pb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">Pull requests</h3>
                {data.pulls.length === 0 ? (
                  <p className="text-sm text-fg-muted">没有开放的 PR。</p>
                ) : (
                  <ul className="space-y-1">
                    {data.pulls.map((pr) => (
                      <li key={pr.number} className="flex items-center gap-2">
                        <a href={pr.url} target="_blank" rel="noreferrer" className={row}>
                          <span className="shrink-0 font-mono text-xs text-fg-muted">#{pr.number}</span>
                          <span className="min-w-0 flex-1 truncate">{pr.title ?? ""}</span>
                          {pr.headRef && <span className="shrink-0 truncate font-mono text-[11px] text-fg-faint">{pr.headRef}</span>}
                        </a>
                        <button
                          type="button"
                          onClick={() => void startReview(pr.number)}
                          disabled={reviewing !== undefined}
                          className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          {reviewing === pr.number ? "Review 中…" : "Review"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App({ email, onLoggedOut }: { email?: string; onLoggedOut?: () => void } = {}) {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(() => globalThis.localStorage?.getItem("pca.workspace") ?? undefined);
  /** Session picked inside the selected workspace. undefined = the primary session; null = the workspace overview
   * (explicit state, so picking the workspace entry is never overridden by the primary-session fallback). */
  const [pickedBotId, setPickedBotId] = useState<string | null>();
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string>();
  // Issue-loop publish-task form: open only on a discussion session; the human writes the task explicitly.
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const approvals = useApprovals();
  const [forkAt, setForkAt] = useState<number | string>();
  const rail = useRailState();
  const panels = usePanelState(PANELS[0]?.id);
  // Workspaces created in this tab; kept until a list response contains them (see mergeWorkspaceList).
  const localWorkspaces = useRef(new Map<string, LocalWorkspace>());

  const refresh = useCallback(async () => {
    const [botsResult, wsResult] = await Promise.allSettled([api.listBots(), workspacesApi.list()]);
    if (botsResult.status === "fulfilled") setBots(botsResult.value);
    else setError(botsResult.reason instanceof Error ? botsResult.reason.message : String(botsResult.reason));
    if (wsResult.status === "fulfilled") {
      setWorkspaces(mergeWorkspaceList(wsResult.value, localWorkspaces.current));
      setWorkspacesLoaded(true);
    } else {
      setError(describeError(wsResult.reason));
      setWorkspacesLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Keep the workspace selection valid: default to the first one.
  useEffect(() => {
    if (workspaces.length === 0) return;
    if (!selectedWorkspaceId || !workspaces.some((w) => w.id === selectedWorkspaceId)) setSelectedWorkspaceId(workspaces[0].id);
  }, [workspaces, selectedWorkspaceId]);

  useEffect(() => {
    if (selectedWorkspaceId) globalThis.localStorage?.setItem("pca.workspace", selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  const workspace = useMemo(() => workspaces.find((w) => w.id === selectedWorkspaceId), [workspaces, selectedWorkspaceId]);
  const botWorkspace = useMemo(() => mapBotsToWorkspaces(bots, workspaces), [bots, workspaces]);
  /** True while the user is looking at the workspace overview instead of a session. */
  const overviewOpen = Boolean(workspace) && pickedBotId === null;
  const bot = useMemo(() => {
    if (!workspace || pickedBotId === null) return undefined;
    const mine = bots.filter((b) => botWorkspace.get(b.id) === workspace.id);
    return mine.find((b) => b.id === pickedBotId) ?? mine.find((b) => b.id === workspace.botId) ?? mine[0];
  }, [bots, botWorkspace, workspace, pickedBotId]);
  const selectedId = bot?.id;
  const { vm, status } = useBotStream(selectedId);

  const onUpdateWorkspace = useCallback((ws: Workspace) => setWorkspaces((list) => upsertWorkspace(list, ws)), []);
  useWorkspacePoll(workspace?.id, workspace?.status === "preparing", onUpdateWorkspace);

  const workspaceCtx = useMemo<WorkspaceContextValue>(
    () => ({ workspace, loading: !workspacesLoaded, onUpdate: onUpdateWorkspace, onChanged: () => void refresh() }),
    [workspace, workspacesLoaded, onUpdateWorkspace, refresh],
  );

  const guard = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  const onWorkspaceCreated = (ws: Workspace) => {
    localWorkspaces.current.set(ws.id, { workspace: ws, at: Date.now() });
    setWorkspaces((list) => upsertWorkspace(list, ws));
    setSelectedWorkspaceId(ws.id);
    setPickedBotId(undefined);
    void refresh();
  };

  const selectWorkspace = (id: string) => {
    setSelectedWorkspaceId(id);
    // null = open the workspace overview, not the primary session.
    setPickedBotId(null);
  };

  /** Click an issue row: reuse the existing discussion session when there is one, else POST the discuss flow and
   * open the session it created (same workspace, discussion only — executions never match server-side). */
  const onOpenIssue = useCallback(
    async (wsId: string, issueNo: number) => {
      setError(undefined);
      try {
        const { discussion } = await workspacesApi.issueLoopDiscuss(wsId, { issue: issueNo });
        await refresh();
        setPickedBotId(discussion.botId);
      } catch (e) {
        setError(describeError(e));
      }
    },
    [refresh],
  );

  /** PR row Review button: create/reuse the review session via the workspace route, refresh so it appears in the
   * session list, then select this workspace and open the review session. */
  const onReview = useCallback(
    async (wsId: string, pr: number) => {
      setError(undefined);
      try {
        const { review } = await workspacesApi.reviewPr(wsId, { pr });
        await refresh();
        setSelectedWorkspaceId(wsId);
        setPickedBotId(review.botId);
      } catch (e) {
        setError(describeError(e));
      }
    },
    [refresh],
  );

  const onFork = async (input: ForkInput) => {
    const created = await api.forkBot(bot!.id, input);
    await refresh();
    setPickedBotId(created.id);
  };

  const onResolveApproval = async (taskId: string, approved: boolean) => {
    await api.resolveApproval(taskId, approved);
  };

  // Approvals carry the conversation id; map them to Bots.
  const botByConversation = useMemo(() => new Map(bots.map((b) => [String(b.conversationId), b.id])), [bots]);
  const pendingByBot = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of approvals) {
      const id = a.conversationId === undefined ? undefined : botByConversation.get(a.conversationId);
      if (id) counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }, [approvals, botByConversation]);
  const botApprovals = useMemo(
    () => (bot ? approvals.filter((a) => a.conversationId === String(bot.conversationId)) : []),
    [approvals, bot],
  );
  const otherPending = Object.entries(pendingByBot).filter(([id]) => id !== selectedId).reduce((n, [, c]) => n + c, 0);

  const onSend = (text: string, mode: SendMode) =>
    guard(() => api.sendInput(bot!.id, text, mode === "send" ? {} : { whenBusy: mode }));

  // Discussion sessions (issueLoop metadata, no execution branch) expose an explicit 发布任务 action.
  const isDiscussion = Boolean(bot?.issueLoop && !bot.issueLoop.branch && !bot.issueLoop.sourceBotId);
  const onPublish = async (task: string) => {
    if (!workspace || !bot) return;
    setPublishBusy(true);
    setPublishError(undefined);
    try {
      const { execution } = await workspacesApi.issueLoopPublish(workspace.id, { botId: bot.id, task });
      setPublishOpen(false);
      await refresh();
      setPickedBotId(execution.botId); // open the new execution session
    } catch (e) {
      setPublishError(describeError(e));
    } finally {
      setPublishBusy(false);
    }
  };

  const model = vm.agent.modelId ? `${vm.agent.provider ?? ""}/${vm.agent.modelId}` : bot ? `${bot.model.provider}/${bot.model.modelId}` : "";

  // SPIKE-review-loop: the session status is a human-set business label persisted on the Bot record.
  const onSetStatus = async (status: SessionStatus) => {
    if (!workspace || !bot) return;
    try {
      await workspacesApi.setSessionStatus(workspace.id, bot.id, status);
      setBots((list) => list.map((b) => (b.id === bot.id ? { ...b, status } : b)));
    } catch (e) {
      setError(describeError(e));
    }
  };

  const onCompact = () => void guard(() => api.compact(bot!.id)).catch(() => {});
  const onReset = () => {
    if (window.confirm("Reset this bot's context? History before the reset is no longer sent to the model.")) {
      void guard(() => api.reset(bot!.id)).catch(() => {});
    }
  };

  const railNode = (
    <>
      <RailHeader onCollapse={rail.close} />
      <div className="min-h-0 flex-1">
        <BotList
          workspaces={workspaces}
          bots={bots}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedBotId={selectedId}
          onSelectWorkspace={selectWorkspace}
          onSelectBot={setPickedBotId}
          onNewWorkspace={() => setShowNew(true)}
          pendingApprovals={pendingByBot}
          loading={!workspacesLoaded}
          onSessionAdded={(workspaceId, botId) => {
            // SPIKE-add-session: select the workspace and the new blank session, then refresh the list so it shows
            setSelectedWorkspaceId(workspaceId);
            setPickedBotId(botId);
            void refresh();
          }}
        />
      </div>
      <RailFooter email={email} onLoggedOut={onLoggedOut} />
    </>
  );

  const mainNode = (
    <>
      {!overviewOpen && (
        <SessionHeader
          bot={bot}
          vm={vm}
          status={status}
          workspace={workspace}
          bots={bots}
          onSelectBot={setPickedBotId}
          railOpen={rail.open}
          panelOpen={panels.open}
          onExpandRail={rail.show}
          onTogglePanel={panels.toggle}
          onCompact={onCompact}
          onReset={onReset}
          onSetStatus={onSetStatus}
        />
      )}

      {!overviewOpen && <ApprovalBar items={botApprovals} onResolve={onResolveApproval} />}
      {!overviewOpen && otherPending > 0 && (
        <p className="border-b border-warn/30 bg-warn/10 px-4 py-1 text-xs text-warn">
          {otherPending} approval{otherPending === 1 ? "" : "s"} pending on other bots
        </p>
      )}

      {error && (
        <div role="alert" className="flex items-center justify-between bg-bad/10 px-4 py-1.5 text-xs text-bad">
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)} className="underline focus-visible:outline-2 focus-visible:outline-accent">
            Dismiss
          </button>
        </div>
      )}

      {overviewOpen && workspace ? (
        // Keyed by workspace.id: switching workspaces remounts it, so stale rows of the previous repo can't linger.
        <WorkspaceOverview key={workspace.id} workspace={workspace} railOpen={rail.open} bots={bots} onExpandRail={rail.show} onOpenIssue={onOpenIssue} onOpenSession={setPickedBotId} onReview={onReview} />
      ) : bot ? (
        <>
          <MessageList
            messages={vm.messages}
            busy={vm.busy}
            onFork={setForkAt}
            onOpenDiff={(turnKey, path) => panels.openPanel("diff", { turnKey, path })}
          />
          {workspace && workspace.status !== "ready" && <WorkspaceStatus workspace={workspace} onUpdate={onUpdateWorkspace} variant="banner" />}
          {isDiscussion && !publishOpen && (
            <div className="mx-auto w-full max-w-[720px] px-[18px] pb-1.5">
              <button
                type="button"
                onClick={() => setPublishOpen(true)}
                data-testid="open-publish-task"
                className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                发布任务
              </button>
            </div>
          )}
          {isDiscussion && publishOpen && <PublishTaskForm busy={publishBusy} error={publishError} onPublish={onPublish} onCancel={() => setPublishOpen(false)} />}
          <Composer
            busy={vm.busy}
            disabled={workspace?.status !== "ready"}
            model={model}
            queued={vm.inbox.length}
            onSend={onSend}
            onAbort={() => void guard(() => api.abort(bot.id)).catch(() => {})}
            status={<StatusLine busy={vm.busy} queued={vm.inbox.length} status={status} />}
          />
        </>
      ) : workspace ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-xl space-y-3">
            <h2 className="text-base font-semibold text-fg">{workspace.name}</h2>
            <p className="text-sm text-fg-muted">
              {workspace.status === "ready" ? "工作区已就绪，会话正在加载。" : "工作区还没有可用的会话。准备完成后会自动出现，输入框此前保持禁用。"}
            </p>
            <WorkspaceStatus workspace={workspace} onUpdate={onUpdateWorkspace} />
            <button type="button" onClick={() => setPickedBotId(null)} className="text-xs text-fg-muted underline focus-visible:outline-2 focus-visible:outline-accent">
              打开工作区总览
            </button>
          </div>
        </div>
      ) : (
        <div className="m-auto max-w-sm space-y-3 p-6 text-center">
          <p className="text-sm text-fg-muted">{workspacesLoaded ? "还没有工作区。新建一个工作区，选择仓库并描述需求，Agent 会在独立的云环境里开始工作。" : "加载中…"}</p>
          {workspacesLoaded && (
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              新建工作区
            </button>
          )}
        </div>
      )}
    </>
  );

  return (
    <WorkspaceContext.Provider value={workspaceCtx}>
      <WorkspaceShell
        railOpen={rail.open}
        panelOpen={panels.open && !overviewOpen}
        rail={railNode}
        main={mainNode}
        panel={
          // The right session panel belongs to a session; it stays closed while the workspace overview is open.
          !overviewOpen && (
            <PanelHost
              panels={PANELS}
              active={panels.active}
              onSelect={panels.select}
              onClose={panels.close}
              ctx={{ bot, bots, vm }}
              focus={panels.focus}
            />
          )
        }
      />
      {bot && forkAt !== undefined && (
        <ForkDialog
          parentName={bot.name}
          entryId={forkAt}
          defaultModelId={bot.model.modelId}
          onSubmit={onFork}
          onClose={() => setForkAt(undefined)}
        />
      )}
      {showNew && <NewWorkspaceDialog onCreated={onWorkspaceCreated} onClose={() => setShowNew(false)} />}
    </WorkspaceContext.Provider>
  );
}
