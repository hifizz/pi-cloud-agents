// Loops list for one workspace (Issue14 Phase1): name, trigger summary, enabled switch, latest run state.
import { useCallback, useEffect, useState } from "react";
import { describeError } from "../lib/workspaces";
import { RUN_STATUS_LABEL, loopsApi, triggerLabel, type Loop } from "../lib/loops";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

export interface LoopsListProps {
  workspaceId: string;
  /** Open the editor (existing loop) or the create form (loopId undefined). */
  onEdit: (loopId?: string) => void;
  /** Open the run history of a loop. */
  onShowRuns: (loopId: string) => void;
}

export function LoopsList({ workspaceId, onEdit, onShowRuns }: LoopsListProps) {
  const [loops, setLoops] = useState<Loop[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>(); // loop id with a request in flight
  const [runningNow, setRunningNow] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<string>(); // loop id awaiting a second click to delete

  const load = useCallback(async () => {
    try {
      setLoops(await loopsApi.list(workspaceId));
      setError(undefined);
    } catch (e) {
      setError(describeError(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    setLoops(undefined);
    void load();
  }, [load]);

  const toggle = async (loop: Loop) => {
    if (busy) return;
    setBusy(loop.id);
    try {
      await loopsApi.setEnabled(loop.id, !loop.enabled);
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (loop: Loop) => {
    // Two-step confirm: first click arms, second click deletes. Arming expires on the next load.
    if (confirmDelete !== loop.id) {
      setConfirmDelete(loop.id);
      return;
    }
    setConfirmDelete(undefined);
    if (busy) return;
    setBusy(loop.id);
    setError(undefined);
    try {
      await loopsApi.remove(loop.id);
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(undefined);
    }
  };

  const runNow = async (loop: Loop) => {
    if (runningNow) return;
    setRunningNow(loop.id);
    setError(undefined);
    try {
      await loopsApi.run(loop.id);
      await load();
      onShowRuns(loop.id);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRunningNow(undefined);
    }
  };

  return (
    <section aria-label="Loops" data-testid="loops-list" className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Loops</h3>
        <Button type="button" variant="outline" size="xs" onClick={() => onEdit(undefined)}>
          新建 Loop
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {loops === undefined && !error && <p className="text-sm text-muted-foreground">加载中…</p>}
      {loops?.length === 0 && <p className="text-sm text-muted-foreground">还没有 Loop。新建一个，让它按定时或 Webhook 自动运行。</p>}
      <ul className="space-y-1">
        {(loops ?? []).map((loop) => (
          <li key={loop.id} className="rounded-lg border border-border px-3 py-2 text-[13px]" data-testid={`loop-${loop.id}`}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onEdit(loop.id)}
                className="min-w-0 flex-1 truncate text-left font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {loop.name}
              </button>
              <Badge variant="secondary" className="shrink-0 text-[11px] font-normal" title={JSON.stringify(loop.trigger)}>
                {triggerLabel(loop.trigger)}
              </Badge>
              <Switch
                size="sm"
                checked={loop.enabled}
                onCheckedChange={() => void toggle(loop)}
                disabled={busy === loop.id}
                aria-label={`${loop.name} 启用开关`}
              />
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <button
                type="button"
                onClick={() => onShowRuns(loop.id)}
                className="hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                data-testid={`loop-runs-${loop.id}`}
              >
                运行历史
              </button>
              <span aria-hidden="true">·</span>
              <span data-testid={`loop-last-${loop.id}`}>
                {loop.latestRun ? `${RUN_STATUS_LABEL[loop.latestRun.status]}${loop.latestRun.status === "queued" ? ` #${loop.latestRun.position ?? "?"}` : ""}` : "从未运行"}
              </span>
              <span className="flex-1" />
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void runNow(loop)}
                disabled={!loop.enabled || runningNow === loop.id}
                data-testid={`loop-run-${loop.id}`}
              >
                {runningNow === loop.id ? "排队中…" : "Run now"}
              </Button>
              <Button
                type="button"
                variant={confirmDelete === loop.id ? "destructive" : "outline"}
                size="xs"
                onClick={() => void remove(loop)}
                disabled={busy === loop.id}
                data-testid={`loop-delete-${loop.id}`}
              >
                {confirmDelete === loop.id ? "确认删除？" : "删除"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
