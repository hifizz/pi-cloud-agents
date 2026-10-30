import { useState } from "react";
import type { ApprovalItem } from "../types";

export interface ApprovalBarProps {
  /** Pending approvals belonging to the current Bot. */
  items: ApprovalItem[];
  /** Resolve one approval; may reject (the bar shows the message and keeps the item). */
  onResolve: (taskId: string, approved: boolean) => Promise<unknown> | void;
}

const MAX_SUMMARY = 300;

/** One-line summary of a tool call's arguments: the command for bash, compact JSON otherwise. */
export function summarizeArgs(toolName: string, args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return clip(args);
  if (typeof args === "object") {
    const rec = args as Record<string, unknown>;
    if (typeof rec.command === "string" && (toolName === "bash" || toolName.endsWith("bash") || Object.keys(rec).length === 1)) {
      return clip(rec.command);
    }
    try {
      return clip(JSON.stringify(args));
    } catch {
      return "";
    }
  }
  return clip(String(args));
}

function clip(s: string): string {
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY)}…` : s;
}

const btn =
  "rounded-md px-3 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40";

export function ApprovalBar({ items, onResolve }: ApprovalBarProps) {
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();

  if (items.length === 0) return null;

  const resolve = async (taskId: string, approved: boolean) => {
    setBusyId(taskId);
    setError(undefined);
    try {
      await onResolve(taskId, approved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <section aria-label="Pending approvals" className="border-b border-warn/40 bg-warn/10">
      <ul>
        {items.map((item) => {
          const summary = summarizeArgs(item.toolName, item.args);
          return (
            <li key={item.taskId} data-testid="approval-item" className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="text-fg">
                  <span className="font-semibold">Approval needed:</span> <span className="font-mono">{item.toolName}</span>
                  {item.parent && (
                    <span className="ml-2 rounded border border-line px-1 py-0.5 text-[10px] text-fg-muted" title={`Nested call of ${item.parent.callId}`}>
                      in script
                    </span>
                  )}
                </p>
                {summary && <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-fg-dim">{summary}</pre>}
                {item.reason && <p className="mt-0.5 text-xs text-warn">Reason: {item.reason}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className={`${btn} bg-ok/90 text-black hover:bg-ok`}
                  disabled={busyId === item.taskId}
                  onClick={() => void resolve(item.taskId, true)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className={`${btn} border border-bad/70 text-bad hover:bg-bad/10`}
                  disabled={busyId === item.taskId}
                  onClick={() => void resolve(item.taskId, false)}
                >
                  Deny
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="px-4 pb-2 text-xs text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
