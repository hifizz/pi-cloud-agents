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
import type { BotSummary, ForkInput } from "./types";

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

export default function App({ email, onLoggedOut }: { email?: string; onLoggedOut?: () => void } = {}) {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(() => globalThis.localStorage?.getItem("pca.workspace") ?? undefined);
  /** Session picked inside the selected workspace; undefined = the workspace's primary session. */
  const [pickedBotId, setPickedBotId] = useState<string>();
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
  const bot = useMemo(() => {
    if (!workspace) return undefined;
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
    setPickedBotId(undefined);
  };

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
      />

      <ApprovalBar items={botApprovals} onResolve={onResolveApproval} />
      {otherPending > 0 && (
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

      {bot ? (
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
        panelOpen={panels.open}
        rail={railNode}
        main={mainNode}
        panel={
          <PanelHost
            panels={PANELS}
            active={panels.active}
            onSelect={panels.select}
            onClose={panels.close}
            ctx={{ bot, bots, vm }}
            focus={panels.focus}
          />
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
