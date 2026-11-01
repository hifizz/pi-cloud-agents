// Loop run history + live queue view (Issue14 Phase1).
// queued runs show their FIFO position "排队中 #n"; running runs show "运行中". Runs can be canceled; a finished run
// with a botId opens the Session it created.
import { useCallback, useEffect, useState } from "react";
import { describeError, formatTime } from "../lib/workspaces";
import { RUN_STATUS_LABEL, loopsApi, type Loop, type LoopQueueView, type LoopRun } from "../lib/loops";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

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

  const statusVariant = (run: LoopRun): "default" | "secondary" | "destructive" | "outline" =>
    ACTIVE.has(run.status) ? "secondary" : run.status === "failed" ? "destructive" : "outline";

  return (
    <section aria-label={`Loop ${loop.name} 运行历史`} data-testid="loop-runs" className="space-y-3">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="xs" onClick={onBack}>
          ← 返回
        </Button>
        <h3 className="truncate text-sm font-semibold text-foreground">{loop.name} · 运行历史</h3>
        <span className="text-[11px] text-muted-foreground">并发上限 {queue?.maxConcurrent ?? "?"}</span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {runs.length === 0 && <p className="text-sm text-muted-foreground">还没有运行记录。</p>}
      <ul className="space-y-1">
        {runs.map((run) => (
          <li key={run.id} className="rounded-lg border border-border px-3 py-2 text-[13px]" data-testid={`run-${run.id}`}>
            <div className="flex items-center gap-2">
              <Badge variant={statusVariant(run)} className="shrink-0 text-xs" data-testid={`run-status-${run.id}`}>
                {statusLabel(run)}
              </Badge>
              <span className="shrink-0 text-[11px] text-muted-foreground">{run.triggerKind}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground/70">{formatTime(run.enqueuedAt)}</span>
              <span className="flex-1" />
              {ACTIVE.has(run.status) && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void cancel(run)}
                  disabled={canceling === run.id}
                  data-testid={`run-cancel-${run.id}`}
                >
                  {canceling === run.id ? "取消中…" : "取消"}
                </Button>
              )}
              {run.botId && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onOpenSession(run.botId!)}
                  data-testid={`run-open-${run.id}`}
                >
                  打开会话
                </Button>
              )}
            </div>
            {run.error && <p className="mt-1 text-[11px] text-destructive">{run.error}</p>}
            {run.branch && <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{run.branch}</p>}
            {(run.payload?.pr?.url || run.prNumber) && (
              <p className="mt-0.5 text-[11px]">
                <a href={run.payload?.pr?.url ?? "#"} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  PR #{run.payload?.pr?.number ?? run.prNumber}
                </a>
              </p>
            )}
            {run.payload?.suggestedTask?.task && run.status === "succeeded" && (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">建议任务：{run.payload.suggestedTask.task.slice(0, 80)}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void publish(run)}
                  disabled={publishing === run.id}
                  data-testid={`run-publish-${run.id}`}
                >
                  {publishing === run.id ? "发布中…" : "发布任务"}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
