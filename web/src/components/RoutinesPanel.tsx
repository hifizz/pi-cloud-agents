import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { BotSummary, RoutineItem } from "../types";

const POLL_MS = 10_000;

export function formatInterval(r: Pick<RoutineItem, "everyMs" | "atTimes">): string {
  if (r.atTimes?.length) return `daily at ${r.atTimes.join(", ")}`;
  const ms = r.everyMs ?? 0;
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) return `every ${ms / 3_600_000} h`;
  if (ms % 60_000 === 0 && ms >= 60_000) return `every ${ms / 60_000} min`;
  if (ms % 1000 === 0) return `every ${ms / 1000} s`;
  return `every ${ms} ms`;
}

export function formatNext(nextAt: number | undefined): string {
  if (typeof nextAt !== "number" || !Number.isFinite(nextAt)) return "—";
  return new Date(nextAt).toLocaleString();
}

const field =
  "w-full rounded-md border border-line-strong bg-field px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-accent";

/** `embedded`: rendered as a panel body — no collapsible header, loads and polls from mount. */
export function RoutinesPanel({ bots, embedded = false }: { bots: BotSummary[]; embedded?: boolean }) {
  const [expanded, setOpen] = useState(false);
  const open = embedded || expanded;
  const [routines, setRoutines] = useState<RoutineItem[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [botId, setBotId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setRoutines(await api.listRoutines());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [open, load]);

  const chosenBot = bots.some((b) => b.id === botId) ? botId : (bots[0]?.id ?? "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const mins = Number(minutes);
    if (!chosenBot || !prompt.trim() || !Number.isFinite(mins) || mins <= 0) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await api.createRoutine({ bot: chosenBot, prompt: prompt.trim(), everyMs: Math.round(mins * 60_000) });
      setPrompt("");
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (id: string) => {
    setError(undefined);
    try {
      await api.cancelRoutine(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const active = routines.filter((r) => r.enabled);

  const outlineBtn =
    "rounded-md border border-line-strong px-2 py-0.5 text-xs text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

  return (
    <section aria-label="Routines" className={embedded ? undefined : "border-t border-line"}>
      {!embedded && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <span>Routines{open && active.length > 0 ? ` (${active.length})` : ""}</span>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
      )}

      {open && (
        <div className={embedded ? "space-y-3 p-4" : "max-h-72 space-y-2 overflow-y-auto px-3 pb-3"}>
          {error && (
            <p role="alert" className="text-xs text-bad">
              {error}
            </p>
          )}
          {active.length === 0 && <p className="text-xs text-fg-muted">No routines.</p>}
          <ul className="space-y-2">
            {active.map((r) => (
              <li key={r.id} data-testid="routine-item" className="rounded-lg border border-line bg-raised p-3 text-xs">
                <p className="break-words text-fg">{r.prompt}</p>
                <p className="mt-1 text-fg-muted">
                  {r.bot ?? "unknown bot"} · {formatInterval(r)}
                </p>
                <p className="text-fg-muted">Next: {formatNext(r.nextAt)}</p>
                <button type="button" onClick={() => void cancel(r.id)} aria-label={`Cancel routine: ${r.prompt}`} className={`mt-2 ${outlineBtn}`}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>

          {showForm ? (
            <form onSubmit={submit} aria-label="New routine" className="space-y-2">
              <div>
                <label htmlFor="routine-bot" className="mb-1 block text-xs text-fg-muted">
                  Bot
                </label>
                <select id="routine-bot" value={chosenBot} onChange={(e) => setBotId(e.target.value)} className={field}>
                  {bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="routine-prompt" className="mb-1 block text-xs text-fg-muted">
                  Prompt
                </label>
                <textarea id="routine-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} required className={field} />
              </div>
              <div>
                <label htmlFor="routine-minutes" className="mb-1 block text-xs text-fg-muted">
                  Every (minutes)
                </label>
                <input id="routine-minutes" type="number" min={1} step="any" value={minutes} onChange={(e) => setMinutes(e.target.value)} required className={field} />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={submitting || !chosenBot || !prompt.trim()}
                  className="flex-1 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                >
                  Create routine
                </button>
                <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-fg-dim hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
                  Close
                </button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => setShowForm(true)} disabled={bots.length === 0} className={`${outlineBtn} disabled:opacity-40`}>
              New routine
            </button>
          )}
        </div>
      )}
    </section>
  );
}
