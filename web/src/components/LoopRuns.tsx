// Loop run history + live queue view (Issue14 Phase1).
// queued runs show their FIFO position "排队中 #n"; running runs show "运行中". Runs can be canceled; a finished run
// with a botId opens the Session it created.
import { useCallback, useEffect, useState } from "react";
import { describeError, formatTime } from "../lib/workspaces";
import { RUN_STATUS_LABEL, loopsApi, type Loop, type LoopQueueView, type LoopRun } from "../lib/loops";

export interface LoopRunsProps {
  loop: Loop;
  /** Open the Session a run created (botId). */
  onOpenSession: (botId: string) => void;
  onBack: () => void;
}

const ACTIVE = new Set(["queued", "starting", "running", "needs_approval"]);

export function LoopRuns({ loop, onOpenSession, onBack }: LoopRunsProps) {
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [queue, setQueue] = useState<LoopQueueView>();
  const [error, setError] = useState<string>();
  const [canceling, setCanceling] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [r, q] = await Promise.all([loopsApi.runs(loop.id), loopsApi.queue()]);
      setRuns(r);
      setQueue(q);
      setError(undefined);
    } catch (e) {
      setError(describeError(e));
    }
  }, [loop.id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  const cancel = async (run: LoopRun) => {
    if (canceling) return;
    setCanceling(run.id);
    setError(undefined);
    try {
      await loopsApi.cancelRun(run.id);
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCanceling(undefined);
    }
  };

  const positionOf = (run: LoopRun) => queue?.queued.find((q) => q.id === run.id)?.position;
  const [publishing, setPublishing] = useState<string>();

  const publish = async (run: LoopRun) => {
    if (publishing) return;
    setPublishing(run.id);
    setError(undefined);
    try {
      const { execution } = await loopsApi.publishRun(run.id);
      onOpenSession(execution.botId);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setPublishing(undefined);
    }
  };

  const statusLabel = (run: LoopRun) => {
    if (run.status === "queued") return `排队中 #${positionOf(run) ?? "?"}`;
    if (run.status === "running" || run.status === "starting") return "运行中";
    return RUN_STATUS_LABEL[run.status];
  };

  return (
    <section aria-label={`Loop ${loop.name} 运行历史`} data-testid="loop-runs" className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-md border border-line-strong px-2 py-0.5 text-xs text-fg-dim hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
          ← 返回
        </button>
        <h3 className="truncate text-sm font-semibold text-fg">{loop.name} · 运行历史</h3>
        <span className="text-[11px] text-fg-muted">并发上限 {queue?.maxConcurrent ?? "?"}</span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      {runs.length === 0 && <p className="text-sm text-fg-muted">还没有运行记录。</p>}
      <ul className="space-y-1">
        {runs.map((run) => (
          <li key={run.id} className="rounded-lg border border-line px-3 py-2 text-[13px]" data-testid={`run-${run.id}`}>
            <div className="flex items-center gap-2">
              <span className={`shrink-0 text-xs font-medium ${ACTIVE.has(run.status) ? "text-warn" : run.status === "failed" ? "text-bad" : "text-fg-muted"}`} data-testid={`run-status-${run.id}`}>
                {statusLabel(run)}
              </span>
              <span className="shrink-0 text-[11px] text-fg-muted">{run.triggerKind}</span>
              <span className="shrink-0 text-[11px] text-fg-faint">{formatTime(run.enqueuedAt)}</span>
              <span className="flex-1" />
              {ACTIVE.has(run.status) && (
                <button
                  type="button"
                  onClick={() => void cancel(run)}
                  disabled={canceling === run.id}
                  className="rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-dim hover:bg-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`run-cancel-${run.id}`}
                >
                  {canceling === run.id ? "取消中…" : "取消"}
                </button>
              )}
              {run.botId && (
                <button
                  type="button"
                  onClick={() => onOpenSession(run.botId!)}
                  className="rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-dim hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`run-open-${run.id}`}
                >
                  打开会话
                </button>
              )}
            </div>
            {run.error && <p className="mt-1 text-[11px] text-bad">{run.error}</p>}
            {run.branch && <p className="mt-0.5 font-mono text-[11px] text-fg-muted">{run.branch}</p>}
            {(run.payload?.pr?.url || run.prNumber) && (
              <p className="mt-0.5 text-[11px]">
                <a href={run.payload?.pr?.url ?? "#"} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  PR #{run.payload?.pr?.number ?? run.prNumber}
                </a>
              </p>
            )}
            {run.payload?.suggestedTask?.task && run.status === "succeeded" && (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[11px] text-fg-muted">建议任务：{run.payload.suggestedTask.task.slice(0, 80)}</span>
                <button
                  type="button"
                  onClick={() => void publish(run)}
                  disabled={publishing === run.id}
                  className="rounded border border-accent px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`run-publish-${run.id}`}
                >
                  {publishing === run.id ? "发布中…" : "发布任务"}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
