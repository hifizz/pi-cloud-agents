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
import type { ApprovalPolicy, ContextStripItem } from "./components/composer";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiCloudIcon, FolderIcon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { WorkspaceShell } from "./shell/WorkspaceShell";
import { PanelHost } from "./shell/PanelHost";
import { SessionHeader } from "./shell/SessionHeader";
import { StatusLine } from "./shell/ComposerContext";
import { RailFooter, RailHeader } from "./shell/rail";
import { usePanelState } from "./shell/usePanelState";
import { useRailState } from "./shell/useRailState";
import { useSessionLink, copySessionLink, readSessionLink, readWorkspaceLink, readLoopsLink, type LoopsLink } from "./hooks/useSessionLink";
import { useSessionNotifications } from "./hooks/useSessionNotifications";
import { PANELS } from "./panels";
import {
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
} from "./lib/workspaces";
import { type BotSummary, type ForkInput, type SessionStatus } from "./types";
import { LoopsList } from "./components/LoopsList";
import { LoopEditor } from "./components/LoopEditor";
import { LoopRuns } from "./components/LoopRuns";
import { loopsApi, type Loop } from "./lib/loops";
import { WorkspaceHome, type HomeDrawer } from "./home/WorkspaceHome";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import { Textarea } from "./components/ui/textarea";

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
      <div className="rounded-lg border border-border bg-card p-3">
        <Label className="block text-xs text-muted-foreground" htmlFor="publish-task-input">
          发布任务（逐字作为新执行会话的首条消息；不会带入本讨论的内容）
        </Label>
        <Textarea
          id="publish-task-input"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="写下要执行的任务…"
          rows={3}
          className="mt-2"
        />
        {error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy || !task.trim()}>
            {busy ? "发布中…" : "确认发布"}
          </Button>
        </div>
      </div>
    </form>
  );
}


/** URL encoding of the loops surface: list / new / <loopId> (runs), edit=1 marks the editor of an existing loop. */
function loopsLinkOf(view: { mode: "list" | "edit" | "runs"; loopId?: string } | undefined): LoopsLink | undefined {
  if (!view) return undefined;
  if (view.mode === "list") return { mode: "list" };
  if (view.mode === "edit") return view.loopId ? { mode: "edit", loopId: view.loopId } : { mode: "new" };
  return { mode: "runs", loopId: view.loopId! };
}

function loopsViewOf(link: LoopsLink | undefined): { mode: "list" | "edit" | "runs"; loopId?: string } | undefined {
  if (!link) return undefined;
  if (link.mode === "list") return { mode: "list" };
  if (link.mode === "new") return { mode: "edit" };
  return { mode: link.mode, loopId: link.loopId };
}

export default function App({ email, onLoggedOut }: { email?: string; onLoggedOut?: () => void } = {}) {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(() => readWorkspaceLink() ?? globalThis.localStorage?.getItem("pca.workspace") ?? undefined);
  /** Session picked inside the selected workspace. undefined = the primary session; null = the workspace overview
   * (explicit state, so picking the workspace entry is never overridden by the primary-session fallback). */
  const [pickedBotId, setPickedBotId] = useState<string | null | undefined>(() => readWorkspaceLink() && !readSessionLink() ? null : undefined);
  // Deep link: ?loopRun=<botId-or-runId> picks the session that owns the run (PR bodies link here).
  const [deepLinked, setDeepLinked] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string>();
  // Issue-loop publish-task form: open only on a discussion session; the human writes the task explicitly.
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const approvals = useApprovals();
  // Issue14: the Loops surface inside a workspace. list = the loops list, edit = editor, runs = run history.
  const [loopsView, setLoopsView] = useState<{ mode: "list" | "edit" | "runs"; loopId?: string } | undefined>();
  const [loopsViewLoop, setLoopsViewLoop] = useState<Loop>();
  // Workspace-home drawer (Events / Integrations / Routines / Issues / PRs / Settings detail surfaces).
  const [homeDrawer, setHomeDrawer] = useState<HomeDrawer | undefined>();
  const [forkAt, setForkAt] = useState<number | string>();
  const rail = useRailState();
  const panels = usePanelState(PANELS[0]?.id);
  // AMP13-collaboration: ?bot=<id> deep link; a copied link resolves to the same session for any signed-in member.
  const link = useSessionLink();
  const [shareMsg, setShareMsg] = useState<string>();
  /** Set once after the first workspace list arrived; the deep-link param is consumed only after this. */
  const linkHandled = useRef(false);
  /** Set once the ?loops= param of the initial URL has been applied (a ?bot= link wins over it). */
  const loopsRestored = useRef(false);
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
    if (workspaces.length === 0 || readWorkspaceLink()) return;
    if (!selectedWorkspaceId || !workspaces.some((w) => w.id === selectedWorkspaceId)) setSelectedWorkspaceId(workspaces[0].id);
  }, [workspaces, selectedWorkspaceId]);

  useEffect(() => {
    if (selectedWorkspaceId) globalThis.localStorage?.setItem("pca.workspace", selectedWorkspaceId);
    // Any workspace switch (rail click, deep link, popstate, auto-select) closes the home drawer so a detail
    // surface open for workspace A can never show workspace B's data.
    setHomeDrawer(undefined);
  }, [selectedWorkspaceId]);

  const workspace = useMemo(() => workspaces.find((w) => w.id === selectedWorkspaceId), [workspaces, selectedWorkspaceId]);
  // Deep link ?loopRun=<id>: the run's session may be keyed by bot id OR loop_run id — resolve to a bot.
  useEffect(() => {
    if (deepLinked || !workspace || bots.length === 0) return;
    const target = new URLSearchParams(globalThis.location.search).get("loopRun");
    if (!target) { setDeepLinked(true); return; }
    const hit = bots.find((b) => b.id === target || b.loopRun?.runId === target);
    if (hit) setPickedBotId(hit.id);
    setDeepLinked(true);
  }, [deepLinked, workspace, bots]);
  // Opening the Loops surface unmounts the home; clear the drawer so returning to the home starts closed.
  useEffect(() => {
    if (loopsView !== undefined) setHomeDrawer(undefined);
  }, [loopsView]);
  // Opening the loops surface keeps the picked session but replaces the main pane.
  const loopsOpen = Boolean(workspace) && loopsView !== undefined;
  const botWorkspace = useMemo(() => mapBotsToWorkspaces(bots, workspaces), [bots, workspaces]);

  // AMP13-collaboration: a ?bot=<id> deep link selects that session's workspace once the lists arrive. An unknown
  // id shows an explicit error instead of silently falling back; the URL keeps the param for transparency.
  useEffect(() => {
    if (!workspacesLoaded || linkHandled.current) return;
    linkHandled.current = true;
    const target = link.linkBot;
    if (!target) {
      const wsId = readWorkspaceLink();
      if (wsId && !workspaces.some((w) => w.id === wsId)) setError(`链接中的工作区不存在：${wsId}`);
      return;
    }
    const wsId = botWorkspace.get(target);
    if (wsId) {
      setSelectedWorkspaceId(wsId);
      setPickedBotId(target);
    } else {
      setError(`链接中的会话不存在：${target}`);
    }
    // The effect must run only once, when the first workspace list lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacesLoaded, botWorkspace]);

  /** True while the user is looking at the workspace overview instead of a session. */
  const overviewOpen = Boolean(workspace) && pickedBotId === null;
  const bot = useMemo(() => {
    if (!workspace || pickedBotId === null) return undefined;
    const mine = bots.filter((b) => botWorkspace.get(b.id) === workspace.id);
    return mine.find((b) => b.id === pickedBotId) ?? mine.find((b) => b.id === workspace.botId) ?? mine[0];
  }, [bots, botWorkspace, workspace, pickedBotId]);
  const selectedId = bot?.id;
  const { vm, status } = useBotStream(selectedId);
  const notifications = useSessionNotifications({ botId: selectedId, botName: bot?.name, busy: vm.busy });

  // Workspace-IA demo: ?workspace=…&loops=list|new|<loopId> restores the Loops surface on load (refresh / shared
  // link). Applied once the workspace is known and only when no ?bot= session link competes with it.
  useEffect(() => {
    if (!workspace || loopsRestored.current || readSessionLink()) return;
    loopsRestored.current = true;
    setLoopsView(loopsViewOf(readLoopsLink()));
  }, [workspace]);

  // AMP13-collaboration: keep the address bar pointing at the open session so a refresh (or a copied link) lands
  // back here; the workspace overview clears the param.
  useEffect(() => {
    if (!linkHandled.current) return;
    // Initial URL resolution may still be selecting a workspace in this render.
    if (pickedBotId === undefined && link.linkBot && botWorkspace.has(link.linkBot)) return;
    if (!workspace) return;
    // The loops surface (?workspace=…&loops=…) replaces the session param; the overview clears both.
    const want = loopsOpen || overviewOpen || !bot ? undefined : bot.id;
    const wantWorkspace = want ? undefined : workspace.id;
    const wantLoops = loopsOpen ? loopsLinkOf(loopsView) : undefined;
    if (want === readSessionLink() && wantWorkspace === readWorkspaceLink() && JSON.stringify(wantLoops) === JSON.stringify(readLoopsLink())) return;
    link.setLink(want, wantWorkspace, wantLoops);
  }, [selectedId, overviewOpen, pickedBotId, workspace, loopsOpen, loopsView]);

  useEffect(() => {
    const onPop = () => {
      const target = readSessionLink();
      setLoopsView(undefined);
      setError(undefined);
      if (!target) {
        const wsId = readWorkspaceLink();
        setSelectedWorkspaceId(wsId ?? workspaces[0]?.id);
        if (wsId && !workspaces.some((w) => w.id === wsId)) setError(`链接中的工作区不存在：${wsId}`);
        setPickedBotId(null);
        setLoopsView(loopsViewOf(readLoopsLink()));
        return;
      }
      const wsId = botWorkspace.get(target);
      if (!wsId) {
        setError(`链接中的会话不存在：${target}`);
        return;
      }
      setSelectedWorkspaceId(wsId);
      setPickedBotId(target);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [botWorkspace, workspaces]);

  const onShareLink = useCallback(() => {
    if (!bot) return;
    void copySessionLink(bot.id)
      .then(() => setShareMsg("已复制链接"))
      .catch((e: unknown) => setShareMsg(e instanceof Error ? e.message : "复制失败"));
  }, [bot]);
  useEffect(() => {
    if (!shareMsg) return;
    const t = setTimeout(() => setShareMsg(undefined), 3000);
    return () => clearTimeout(t);
  }, [shareMsg]);

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

  /** Narrow screens open with the rail closed exactly once (persisted state wins afterwards). */
  const narrowCollapsed = useRef(false);
  const isNarrow = useCallback(() => globalThis.matchMedia?.("(max-width: 767px)").matches ?? false, []);
  useEffect(() => {
    if (!isNarrow() || narrowCollapsed.current) return;
    narrowCollapsed.current = true;
    rail.close();
  }, [isNarrow, rail]);

  const selectWorkspace = (id: string) => {
    setError(undefined);
    setSelectedWorkspaceId(id);
    setLoopsView(undefined);
    setHomeDrawer(undefined);
    // null = open the workspace overview, not the primary session.
    setPickedBotId(null);
    // AMP13-collaboration: on phones the rail is an overlay; dismiss it after picking so the content is visible.
    if (isNarrow()) rail.close();
  };
  const pickBot = useCallback(
    (id: string) => {
      setLoopsView(undefined);
      setHomeDrawer(undefined);
      setPickedBotId(id);
      if (isNarrow()) rail.close();
    },
    [isNarrow, rail],
  );

  // Issue14: resolve the loop being edited / whose runs are shown.
  const openLoops = () => {
    setLoopsView({ mode: "list" });
    setPickedBotId(null);
  };
  useEffect(() => {
    if (loopsView?.mode !== "runs" || !loopsView.loopId) return;
    let dead = false;
    loopsApi
      .get(loopsView.loopId)
      .then((l) => !dead && setLoopsViewLoop(l))
      .catch(() => !dead && setLoopsViewLoop(undefined));
    return () => {
      dead = true;
    };
  }, [loopsView]);

  /** Click an issue row: reuse the existing discussion session when there is one, else POST the discuss flow and
   * open the session it created (same workspace, discussion only — executions never match server-side). */
  const onOpenIssue = useCallback(
    async (wsId: string, issueNo: number) => {
      setError(undefined);
      try {
        const { discussion } = await workspacesApi.issueLoopDiscuss(wsId, { issue: issueNo });
        await refresh();
        pickBot(discussion.botId);
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
        pickBot(review.botId);
      } catch (e) {
        setError(describeError(e));
      }
    },
    [refresh],
  );

  const onFork = async (input: ForkInput) => {
    const created = await api.forkBot(bot!.id, input);
    await refresh();
    pickBot(created.id);
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
      pickBot(execution.botId); // open the new execution session
    } catch (e) {
      setPublishError(describeError(e));
    } finally {
      setPublishBusy(false);
    }
  };

  const model = vm.agent.modelId ? `${vm.agent.provider ?? ""}/${vm.agent.modelId}` : bot ? `${bot.model.provider}/${bot.model.modelId}` : "";

  // Composer context strip: session cwd, cloud sandbox, and the session's own branch (detached sessions show no branch).
  const contextItems = useMemo<ContextStripItem[]>(() => {
    if (!workspace) return [];
    const items: ContextStripItem[] = [];
    const cwd = bot?.worktree?.dir ?? bot?.issueLoop?.dir ?? bot?.review?.dir ?? bot?.loopRun?.dir ?? vm.agent.cwd;
    if (cwd) items.push({ icon: <HugeiconsIcon icon={FolderIcon} className="size-3.5" strokeWidth={1.8} />, label: cwd, title: cwd });
    const branch = bot?.worktree?.branch ?? bot?.issueLoop?.branch ?? bot?.loopRun?.branch ?? null;
    if (branch) items.push({ icon: <HugeiconsIcon icon={GitBranchIcon} className="size-3.5" strokeWidth={1.8} />, label: branch, title: branch });
    return items;
  }, [workspace, bot, vm.agent.cwd]);

  // Right end of the context strip: [Idle 状态, Sprite 沙箱] together, Idle immediately left of Sprite.
  const spriteItem = useMemo(() => {
    if (!workspace) return null;
    const binding = workspace.binding;
    const label = workspace.status === "ready" ? `Sprite 就绪 · ${binding?.runtimeId ?? ""}` : `沙箱状态：${workspace.status}`;
    return (
      <span title={binding?.runtimeId} className="flex min-w-0 items-center gap-1.5">
        <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-full">
          <HugeiconsIcon icon={AiCloudIcon} className="size-3.5" strokeWidth={1.8} />
        </span>
        <span className="truncate whitespace-nowrap">{label}</span>
      </span>
    );
  }, [workspace]);

  const onApprovalPolicyChange = (policy: ApprovalPolicy) => {
    if (!bot) return;
    void guard(async () => {
      const { bot: updated } = await api.setApprovalPolicy(bot.id, policy);
      setBots((list) => list.map((b) => (b.id === updated.id ? { ...b, ...updated } : b)));
    }).catch(() => {});
  };

  const onModelChange = (modelId: string) => {
    if (!bot) return;
    void guard(async () => {
      const { bot: updated } = await api.setModel(bot.id, modelId);
      setBots((list) => list.map((b) => (b.id === updated.id ? { ...b, ...updated } : b)));
    }).catch(() => {});
  };

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
          onSelectBot={pickBot}
          onNewWorkspace={() => setShowNew(true)}
          pendingApprovals={pendingByBot}
          loading={!workspacesLoaded}
          onSessionAdded={(workspaceId, botId) => {
            // SPIKE-add-session: select the workspace and the new blank session, then refresh the list so it shows
            setSelectedWorkspaceId(workspaceId);
            pickBot(botId);
            void refresh();
          }}
        />
      </div>
      <RailFooter email={email} onLoggedOut={onLoggedOut} />
    </>
  );

  const mainNode = (
    <>
      {!overviewOpen && !loopsOpen && (
        <SessionHeader
          bot={bot}
          vm={vm}
          status={status}
          workspace={workspace}
          bots={bots}
          onSelectBot={pickBot}
          onOpenLoop={(loopId) => {
            setPickedBotId(null);
            setLoopsView({ mode: "runs", loopId });
          }}
          railOpen={rail.open}
          panelOpen={panels.open}
          onExpandRail={rail.show}
          onTogglePanel={panels.toggle}
          onCompact={onCompact}
          onReset={onReset}
          onSetStatus={onSetStatus}
          onShare={onShareLink}
          shareFeedback={shareMsg}
          notifications={notifications}
        />
      )}

      {!overviewOpen && !loopsOpen && <ApprovalBar items={botApprovals} onResolve={onResolveApproval} />}
      {!overviewOpen && !loopsOpen && otherPending > 0 && (
        <p className="border-b border-warn/30 bg-warn/10 px-4 py-1 text-xs text-warn">          {otherPending} approval{otherPending === 1 ? "" : "s"} pending on other bots
        </p>
      )}

      {error && (
        <div role="alert" className="flex items-center justify-between bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          <span>{error}</span>
          <Button type="button" variant="link" size="sm" onClick={() => setError(undefined)} className="h-auto p-0">
            Dismiss
          </Button>
        </div>
      )}

      {loopsOpen && workspace ? (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="loops-pane">
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            {!rail.open && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Expand sidebar"
                title="Expand sidebar"
                onClick={rail.show}
                className="shrink-0"
              >
                <Icon name="sidebar" className="size-4" />
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLoopsView(undefined)}
              data-testid="loops-back"
            >
              ← 返回工作区
            </Button>
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">Loops · {workspace.name}</h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="mx-auto max-w-2xl">
              {loopsView?.mode === "list" && (
                <LoopsList
                  workspaceId={workspace.id}
                  onEdit={(loopId) => setLoopsView({ mode: "edit", loopId })}
                  onShowRuns={(loopId) => setLoopsView({ mode: "runs", loopId })}
                />
              )}
              {loopsView?.mode === "edit" && (
                <LoopEditor
                  workspaceId={workspace.id}
                  loopId={loopsView.loopId}
                  onSaved={(loop) => {
                    setLoopsView({ mode: "runs", loopId: loop.id });
                    void refresh();
                  }}
                  onCancel={() => setLoopsView({ mode: "list" })}
                />
              )}
              {loopsView?.mode === "runs" && loopsViewLoop && (
                <LoopRuns
                  loop={loopsViewLoop}
                  onOpenSession={(botId) => {
                    setLoopsView(undefined);
                    setPickedBotId(botId);
                  }}
                  onBack={() => setLoopsView({ mode: "list" })}
                />
              )}
            </div>
          </div>
        </div>
      ) : overviewOpen && workspace ? (
        // Keyed by workspace.id: switching workspaces remounts it, so stale rows of the previous repo can't linger.
        <WorkspaceHome
          key={workspace.id}
          workspace={workspace}
          railOpen={rail.open}
          bots={bots}
          onExpandRail={rail.show}
          onOpenIssue={onOpenIssue}
          onOpenSession={pickBot}
          onReview={onReview}
          onOpenLoops={openLoops}
          onOpenLoopRuns={(loopId) => {
            setPickedBotId(null);
            setLoopsView({ mode: "runs", loopId });
          }}
          drawer={homeDrawer}
          onDrawerChange={setHomeDrawer}
        />
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPublishOpen(true)}
                data-testid="open-publish-task"
              >
                发布任务
              </Button>
            </div>
          )}
          {isDiscussion && publishOpen && <PublishTaskForm busy={publishBusy} error={publishError} onPublish={onPublish} onCancel={() => setPublishOpen(false)} />}
          <Composer
            busy={vm.busy}
            disabled={workspace?.status !== "ready"}
            model={model}
            modelId={bot.model.modelId}
            onModelChange={onModelChange}
            queued={vm.inbox.length}
            onSend={onSend}
            onAbort={() => void guard(() => api.abort(bot.id)).catch(() => {})}
            approvalPolicy={bot.approvalPolicy ?? "ask"}
            onApprovalPolicyChange={onApprovalPolicyChange}
            contextItems={contextItems}
            status={
              <>
                <StatusLine busy={vm.busy} queued={vm.inbox.length} status={status} />
                {spriteItem}
              </>
            }
          />
        </>
      ) : workspace ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-xl space-y-3">
            <h2 className="text-base font-semibold text-foreground">{workspace.name}</h2>
            <p className="text-sm text-muted-foreground">
              {workspace.status === "ready" ? "工作区已就绪，会话正在加载。" : "工作区还没有可用的会话。准备完成后会自动出现，输入框此前保持禁用。"}
            </p>
            <WorkspaceStatus workspace={workspace} onUpdate={onUpdateWorkspace} />
            <Button type="button" variant="link" size="sm" onClick={() => setPickedBotId(null)} className="h-auto p-0">
              打开工作区总览
            </Button>
          </div>
        </div>
      ) : (
        <div className="m-auto max-w-sm space-y-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">{workspacesLoaded ? readWorkspaceLink() ? "链接中的工作区不可用，请从左侧选择工作区。" : "还没有工作区。新建一个工作区，选择仓库并描述需求，Agent 会在独立的云环境里开始工作。" : "加载中…"}</p>
          {workspacesLoaded && (
            <Button
              type="button"
              onClick={() => setShowNew(true)}
            >
              新建工作区
            </Button>
          )}
        </div>
      )}
    </>
  );

  return (
    <WorkspaceContext.Provider value={workspaceCtx}>
      <WorkspaceShell
        railOpen={rail.open}
        panelOpen={panels.open && !overviewOpen && !loopsOpen}
        rail={railNode}
        main={mainNode}
        onCloseRail={rail.close}
        panel={
          // The right session panel belongs to a session; it stays closed while the workspace overview or the
          // Loops surface is open.
          !overviewOpen && !loopsOpen && (
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
