import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./lib/api";
import { useBotStream } from "./hooks/useBotStream";
import { BotList } from "./components/BotList";
import { DesktopPane } from "./components/DesktopPane";
import { UsageBadge } from "./components/UsageBadge";
import { ApprovalBar } from "./components/ApprovalBar";
import { ForkDialog } from "./components/ForkDialog";
import { RoutinesPanel } from "./components/RoutinesPanel";
import { useApprovals } from "./hooks/useApprovals";
import { MessageList } from "./components/Chat/MessageList";
import { Composer, type SendMode } from "./components/Chat/Composer";
import type { BotSummary, ForkInput, NewBotInput } from "./types";

const headerBtn =
  "rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-40";

export default function App() {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => globalThis.localStorage?.getItem("tarsbot.bot") ?? undefined);
  const [error, setError] = useState<string>();
  const { vm, status } = useBotStream(selectedId);
  const approvals = useApprovals();
  const [forkAt, setForkAt] = useState<number | string>();

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
  const otherPending = Object.entries(pendingByBot).filter(([id]) => id !== selectedId).reduce((n, [, c]) => n + c, 0);

  const onSend = (text: string, mode: SendMode) =>
    guard(() => api.sendInput(bot!.id, text, mode === "send" ? {} : { whenBusy: mode }));

  const model = vm.agent.modelId ? `${vm.agent.provider ?? ""}/${vm.agent.modelId}` : bot ? `${bot.model.provider}/${bot.model.modelId}` : "";

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <div className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="min-h-0 flex-1">
          <BotList bots={bots} selectedId={selectedId} onSelect={setSelectedId} onCreate={onCreate} pendingApprovals={pendingByBot} />
        </div>
        <RoutinesPanel bots={bots} />
      </div>

      <main className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
        <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{bot ? bot.name : "TARSBot"}</h1>
            {bot && <p className="truncate font-mono text-xs text-zinc-500">{model}</p>}
          </div>
          {status !== "open" && bot && (
            <span role="status" className="text-xs text-amber-400">
              {status === "reconnecting" ? "Reconnecting…" : status === "connecting" ? "Connecting…" : "Disconnected"}
            </span>
          )}
          {vm.compacting > 0 && <span className="text-xs text-zinc-400">Compacting…</span>}
          <UsageBadge usage={vm.usage} />
          <button type="button" className={headerBtn} disabled={!bot || vm.busy} onClick={() => void guard(() => api.compact(bot!.id)).catch(() => {})}>
            Compact
          </button>
          <button
            type="button"
            className={headerBtn}
            disabled={!bot}
            onClick={() => {
              if (window.confirm("Reset this bot's context? History before the reset is no longer sent to the model.")) {
                void guard(() => api.reset(bot!.id)).catch(() => {});
              }
            }}
          >
            Reset
          </button>
        </header>

        <ApprovalBar items={botApprovals} onResolve={onResolveApproval} />
        {otherPending > 0 && (
          <p className="border-b border-amber-700/40 bg-amber-950/20 px-4 py-1 text-xs text-amber-300">
            {otherPending} approval{otherPending === 1 ? "" : "s"} pending on other bots
          </p>
        )}

        {error && (
          <div role="alert" className="flex items-center justify-between bg-red-950 px-4 py-1.5 text-xs text-red-200">
            <span>{error}</span>
            <button type="button" onClick={() => setError(undefined)} className="underline focus-visible:outline-2 focus-visible:outline-sky-400">
              Dismiss
            </button>
          </div>
        )}

        {bot ? (
          <>
            <MessageList messages={vm.messages} busy={vm.busy} onFork={setForkAt} />
            <Composer
              busy={vm.busy}
              model={model}
              queued={vm.inbox.length}
              onSend={onSend}
              onAbort={() => void guard(() => api.abort(bot.id)).catch(() => {})}
            />
          </>
        ) : (
          <p className="m-auto text-sm text-zinc-500">Create or select a bot to start.</p>
        )}
      </main>

      <DesktopPane />

      {bot && forkAt !== undefined && (
        <ForkDialog
          parentName={bot.name}
          entryId={forkAt}
          defaultModelId={bot.model.modelId}
          onSubmit={onFork}
          onClose={() => setForkAt(undefined)}
        />
      )}
    </div>
  );
}
