import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./lib/api";
import { useBotStream } from "./hooks/useBotStream";
import { BotList } from "./components/BotList";
import { ApprovalBar } from "./components/ApprovalBar";
import { AskBar } from "./components/AskBar";
import { ForkDialog } from "./components/ForkDialog";
import { useApprovals } from "./hooks/useApprovals";
import { useAsks } from "./hooks/useAsks";
import { useSpace } from "./hooks/useSpace";
import { MessageList } from "./components/Chat/MessageList";
import { Composer, type SendMode } from "./components/Chat/Composer";
import { WorkspaceShell } from "./shell/WorkspaceShell";
import { PanelHost } from "./shell/PanelHost";
import { SessionHeader } from "./shell/SessionHeader";
import { StatusLine, WorktreeStrip } from "./shell/ComposerContext";
import { RailFooter, RailHeader } from "./shell/rail";
import { usePanelState } from "./shell/usePanelState";
import { useRailState } from "./shell/useRailState";
import { PANELS } from "./panels";
import type { BotSummary, ForkInput, NewBotInput } from "./types";

export default function App({ email, onLoggedOut }: { email?: string; onLoggedOut?: () => void } = {}) {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => globalThis.localStorage?.getItem("tarsbot.bot") ?? undefined);
  const [error, setError] = useState<string>();
  const { vm, status } = useBotStream(selectedId);
  const approvals = useApprovals();
  const asks = useAsks();
  const [forkAt, setForkAt] = useState<number | string>();
  const rail = useRailState();
  const panels = usePanelState(PANELS[0]?.id);
  const { space, failed: spaceFailed } = useSpace();

  const refresh = useCallback(async () => {
    try {
      setBots(await api.listBots());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Keep the selection valid: default to the first bot.
  useEffect(() => {
    if (bots.length === 0) return;
    if (!selectedId || !bots.some((b) => b.id === selectedId)) setSelectedId(bots[0].id);
  }, [bots, selectedId]);

  useEffect(() => {
    if (selectedId) globalThis.localStorage?.setItem("tarsbot.bot", selectedId);
  }, [selectedId]);

  const bot = useMemo(() => bots.find((b) => b.id === selectedId), [bots, selectedId]);

  const guard = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  const onCreate = async (input: NewBotInput) => {
    const created = await api.createBot(input);
    await refresh();
    setSelectedId(created.id);
  };

  const onFork = async (input: ForkInput) => {
    const created = await api.forkBot(bot!.id, input);
    await refresh();
    setSelectedId(created.id);
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
  const botAsks = useMemo(
    () => (bot ? asks.filter((a) => a.conversationId === String(bot.conversationId)) : []),
    [asks, bot],
  );
  const otherPending = Object.entries(pendingByBot).filter(([id]) => id !== selectedId).reduce((n, [, c]) => n + c, 0);

  const onSend = (text: string, mode: SendMode) =>
    guard(() => api.sendInput(bot!.id, text, mode === "send" ? {} : { whenBusy: mode }));

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
        <BotList bots={bots} selectedId={selectedId} onSelect={setSelectedId} onCreate={onCreate} pendingApprovals={pendingByBot} />
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
        space={space}
        railOpen={rail.open}
        panelOpen={panels.open}
        onExpandRail={rail.show}
        onTogglePanel={panels.toggle}
        onCompact={onCompact}
        onReset={onReset}
      />

      <ApprovalBar items={botApprovals} onResolve={onResolveApproval} />
      <AskBar items={botAsks} onAnswer={(id, answer) => api.answerAsk(id, answer)} />
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
          <Composer
            busy={vm.busy}
            model={model}
            queued={vm.inbox.length}
            onSend={onSend}
            onAbort={() => void guard(() => api.abort(bot.id)).catch(() => {})}
            context={<WorktreeStrip space={space} cwd={vm.agent.cwd} />}
            status={<StatusLine busy={vm.busy} queued={vm.inbox.length} status={status} />}
          />
        </>
      ) : (
        <p className="m-auto text-sm text-fg-muted">Create or select a bot to start.</p>
      )}
    </>
  );

  return (
    <>
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
            ctx={{ bot, bots, vm, space, spaceFailed }}
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
    </>
  );
}
