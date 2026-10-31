// Loops list for one workspace (Issue14 Phase1): name, trigger summary, enabled switch, latest run state.
import { useCallback, useEffect, useState } from "react";
import { describeError } from "../lib/workspaces";
import { RUN_STATUS_LABEL, loopsApi, triggerLabel, type Loop } from "../lib/loops";

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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Loops</h3>
        <button
          type="button"
          onClick={() => onEdit(undefined)}
          className="rounded-md border border-line-strong px-2 py-0.5 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          新建 Loop
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      {loops === undefined && !error && <p className="text-sm text-fg-muted">加载中…</p>}
      {loops?.length === 0 && <p className="text-sm text-fg-muted">还没有 Loop。新建一个，让它按定时或 Webhook 自动运行。</p>}
      <ul className="space-y-1">
        {(loops ?? []).map((loop) => (
          <li key={loop.id} className="rounded-lg border border-line px-3 py-2 text-[13px]" data-testid={`loop-${loop.id}`}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onEdit(loop.id)}
                className="min-w-0 flex-1 truncate text-left font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {loop.name}
              </button>
              <span className="shrink-0 text-[11px] text-fg-muted" title={JSON.stringify(loop.trigger)}>
                {triggerLabel(loop.trigger)}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={loop.enabled}
                aria-label={`${loop.name} 启用开关`}
                onClick={() => void toggle(loop)}
                disabled={busy === loop.id}
                className={`relative h-4 w-7 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 ${
                  loop.enabled ? "bg-brand" : "bg-line-strong"
                }`}
              >
                <span
                  className={`absolute top-0.5 size-3 rounded-full bg-white transition-transform ${loop.enabled ? "translate-x-3.5" : "translate-x-0.5"}`}
                />
              </button>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-muted">
              <button
                type="button"
                onClick={() => onShowRuns(loop.id)}
                className="hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`loop-runs-${loop.id}`}
              >
                运行历史
              </button>
              <span aria-hidden="true">·</span>
              <span data-testid={`loop-last-${loop.id}`}>
                {loop.latestRun ? `${RUN_STATUS_LABEL[loop.latestRun.status]}${loop.latestRun.status === "queued" ? ` #${loop.latestRun.position ?? "?"}` : ""}` : "从未运行"}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => void runNow(loop)}
                disabled={!loop.enabled || runningNow === loop.id}
                className="rounded border border-line-strong px-1.5 py-0.5 font-medium text-fg-dim hover:bg-hover hover:text-fg disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`loop-run-${loop.id}`}
              >
                {runningNow === loop.id ? "排队中…" : "Run now"}
              </button>
              <button
                type="button"
                onClick={() => void remove(loop)}
                disabled={busy === loop.id}
                className={`rounded border px-1.5 py-0.5 font-medium disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent ${
                  confirmDelete === loop.id ? "border-bad text-bad hover:bg-bad/10" : "border-line-strong text-fg-dim hover:bg-hover hover:text-fg"
                }`}
                data-testid={`loop-delete-${loop.id}`}
              >
                {confirmDelete === loop.id ? "确认删除？" : "删除"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
