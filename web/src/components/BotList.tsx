import { useState, type FormEvent } from "react";
import type { BotSummary, NewBotInput } from "../types";

export const MODEL_OPTIONS = ["glm-5.3-flash", "glm-5.3", "claude-sonnet-5-5", "gpt-5.6-terra"];

export interface BotListProps {
  bots: BotSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: (input: NewBotInput) => Promise<void>;
  /** Pending approval count per Bot id; shown as a badge. */
  pendingApprovals?: Record<string, number>;
}

const field =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:outline-2 focus-visible:outline-sky-400";

export function BotList({ bots, selectedId, onSelect, onCreate, pendingApprovals = {} }: BotListProps) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState(MODEL_OPTIONS[0]);
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onCreate({ name: name.trim(), modelId, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) });
      setName("");
      setInstructions("");
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <nav aria-label="Bots" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Bots</h2>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          aria-expanded={showForm}
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-sky-400"
        >
          {showForm ? "Cancel" : "New bot"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="space-y-2 border-y border-zinc-800 px-3 py-3" aria-label="New bot">
          <div>
            <label htmlFor="bot-name" className="mb-1 block text-xs text-zinc-400">
              Name
            </label>
            <input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} required className={field} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="bot-model" className="mb-1 block text-xs text-zinc-400">
              Model
            </label>
            <select id="bot-model" value={modelId} onChange={(e) => setModelId(e.target.value)} className={field}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bot-instructions" className="mb-1 block text-xs text-zinc-400">
              Instructions (optional)
            </label>
            <textarea id="bot-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} className={field} />
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-40"
          >
            Create
          </button>
        </form>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {bots.length === 0 && <li className="px-3 py-4 text-sm text-zinc-500">No bots yet.</li>}
        {bots.map((bot) => {
          const selected = bot.id === selectedId;
          const pending = pendingApprovals[bot.id] ?? 0;
          const parentName = bot.parent ? (bots.find((b) => b.id === bot.parent?.botId)?.name ?? "unknown") : undefined;
          return (
            <li key={bot.id}>
              <button
                type="button"
                onClick={() => onSelect(bot.id)}
                aria-current={selected ? "true" : undefined}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-400 ${
                  selected ? "bg-zinc-800 text-white" : "text-zinc-300 hover:bg-zinc-900"
                }`}
              >
                <span
                  role="img"
                  aria-label={bot.busy ? "busy" : "idle"}
                  className={`h-2 w-2 shrink-0 rounded-full ${bot.busy ? "animate-pulse bg-sky-400" : "bg-zinc-600"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{bot.name}</span>
                  <span className="block truncate text-xs text-zinc-500">{bot.model?.modelId}</span>
                  {parentName && (
                    <span className="block truncate text-xs text-zinc-500" title={`Forked from ${parentName}`}>
                      ↳ {parentName}
                    </span>
                  )}
                </span>
                {pending > 0 && (
                  <span
                    role="status"
                    aria-label={`${pending} pending approval${pending === 1 ? "" : "s"}`}
                    className="rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-zinc-950"
                  >
                    {pending}
                  </span>
                )}
                {bot.queued > 0 && <span className="rounded bg-zinc-700 px-1.5 text-xs text-zinc-200">{bot.queued} queued</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
