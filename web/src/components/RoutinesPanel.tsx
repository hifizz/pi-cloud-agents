import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { BotSummary, RoutineItem } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

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

// Native <select> stays: the shadcn Select is not a form control tests can drive with selectOptions.
const field = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/** `embedded`: rendered as a panel body — no collapsible header, loads and polls from mount.
 * `botIds`: when given, BOTH the routine list and the new-routine Bot select are scoped to these ids (workspace
 * home passes this workspace's sessions, so foreign routines are never shown, cancellable, or selectable).
 * Omitting it keeps the global view; the scope is enforced inside the component, not by what callers pass in `bots`. */
export function RoutinesPanel({ bots, embedded = false, botIds }: { bots: BotSummary[]; embedded?: boolean; botIds?: Set<string> }) {
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

  const scopedBots = botIds ? bots.filter((b) => botIds.has(b.id)) : bots;
  const chosenBot = scopedBots.some((b) => b.id === botId) ? botId : (scopedBots[0]?.id ?? "");
  const active = routines.filter((r) => r.enabled && (!botIds || (r.botId !== null && botIds.has(r.botId))));

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

  return (
    <section aria-label="Routines" className={embedded ? undefined : "border-t border-border"}>
      {!embedded && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <span>Routines{open && active.length > 0 ? ` (${active.length})` : ""}</span>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
      )}

      {open && (
        <div className={embedded ? "space-y-3 p-4" : "max-h-72 space-y-2 overflow-y-auto px-3 pb-3"}>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {active.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {botIds ? (scopedBots.length === 0 ? "此工作区还没有可挂 routine 的会话。" : "本工作区的会话没有 routine。") : "No routines."}
            </p>
          )}
          <ul className="space-y-2">
            {active.map((r) => (
              <li key={r.id} data-testid="routine-item" className="rounded-lg border border-border bg-card p-3 text-xs">
                <p className="break-words text-foreground">{r.prompt}</p>
                <p className="mt-1 text-muted-foreground">
                  {r.bot ?? "unknown bot"} · {formatInterval(r)}
                </p>
                <p className="text-muted-foreground">Next: {formatNext(r.nextAt)}</p>
                <Button type="button" variant="outline" size="xs" onClick={() => void cancel(r.id)} aria-label={`Cancel routine: ${r.prompt}`} className="mt-2">
                  Cancel
                </Button>
              </li>
            ))}
          </ul>

          {showForm ? (
            <form onSubmit={submit} aria-label="New routine" className="space-y-2">
              <div>
                <Label htmlFor="routine-bot" className="mb-1 text-xs text-muted-foreground">
                  Bot
                </Label>
                <select id="routine-bot" value={chosenBot} onChange={(e) => setBotId(e.target.value)} className={field}>
                  {scopedBots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="routine-prompt" className="mb-1 text-xs text-muted-foreground">
                  Prompt
                </Label>
                <Textarea id="routine-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} required className="min-h-0" />
              </div>
              <div>
                <Label htmlFor="routine-minutes" className="mb-1 text-xs text-muted-foreground">
                  Every (minutes)
                </Label>
                <Input id="routine-minutes" type="number" min={1} step="any" value={minutes} onChange={(e) => setMinutes(e.target.value)} required />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={submitting || !chosenBot || !prompt.trim()} className="flex-1">
                  Create routine
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Close
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="outline" size="xs" onClick={() => setShowForm(true)} disabled={scopedBots.length === 0}>
              New routine
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
