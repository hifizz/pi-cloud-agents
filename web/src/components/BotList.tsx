import { useState, type FormEvent } from "react";
import type { BotSummary, NewBotInput } from "../types";
import { Icon } from "./Chat/primitives/Icon";

export const MODEL_OPTIONS = ["swe-2", "glm-5.3-flash", "glm-5.3", "claude-sonnet-5-5", "gpt-5.6-terra"];

export interface BotListProps {
  bots: BotSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: (input: NewBotInput) => Promise<void>;
  /** Pending approval count per Bot id; shown as a badge. */
  pendingApprovals?: Record<string, number>;
}

const field =
  "w-full rounded-md border border-line-strong bg-field px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-accent";

/** Compact age like "5m", "2h", "3d"; undefined when the timestamp is missing or invalid. */
export function relativeTime(value: string | number | undefined, now = Date.now()): string | undefined {
  if (value === undefined) return undefined;
  const t = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(t)) return undefined;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / (86_400 * 30))}mo`;
}

export function BotList({ bots, selectedId, onSelect, onCreate, pendingApprovals = {} }: BotListProps) {
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
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

  const q = query.trim().toLowerCase();
  const visible = q ? bots.filter((b) => b.name.toLowerCase().includes(q)) : bots;

  return (
    <nav aria-label="Bots" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-field px-2 text-fg-muted focus-within:border-line-strong">
          <Icon name="search" className="size-3.5" />
          <input
            type="search"
            aria-label="Search bots"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-fg-faint focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          aria-expanded={showForm}
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-line-strong px-2.5 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          {!showForm && <Icon name="plus" className="size-3" />}
          {showForm ? "Cancel" : "New bot"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="space-y-2 border-y border-line px-3 py-3" aria-label="New bot">
          <div>
            <label htmlFor="bot-name" className="mb-1 block text-xs text-fg-muted">
              Name
            </label>
            <input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} required className={field} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="bot-model" className="mb-1 block text-xs text-fg-muted">
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
            <label htmlFor="bot-instructions" className="mb-1 block text-xs text-fg-muted">
              Instructions (optional)
            </label>
            <textarea id="bot-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} className={field} />
          </div>
          {error && (
            <p role="alert" className="text-xs text-bad">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="w-full rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            Create
          </button>
        </form>
      )}

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {bots.length === 0 && <li className="px-2 py-4 text-sm text-fg-muted">No bots yet.</li>}
        {bots.length > 0 && visible.length === 0 && <li className="px-2 py-4 text-sm text-fg-muted">No matching bots.</li>}
        {visible.map((bot) => {
          const selected = bot.id === selectedId;
          const pending = pendingApprovals[bot.id] ?? 0;
          const parentName = bot.parent ? (bots.find((b) => b.id === bot.parent?.botId)?.name ?? "unknown") : undefined;
          const age = relativeTime(bot.createdAt);
          return (
            <li key={bot.id}>
              <button
                type="button"
                onClick={() => onSelect(bot.id)}
                aria-current={selected ? "true" : undefined}
                className={`flex w-full flex-col gap-0.5 rounded-[10px] border px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                  selected ? "border-[#262626] bg-selected" : "border-transparent hover:bg-hover"
                }`}
              >
                <span className="flex items-center justify-between gap-2 font-mono text-[11px] text-fg-muted">
                  <span className="truncate">{bot.model?.modelId}</span>
                  {age && <span className="shrink-0">{age}</span>}
                </span>
                <span className={`block truncate text-[13px] font-medium ${selected ? "text-white" : "text-fg"}`}>{bot.name}</span>
                <span className="flex items-center gap-2 text-[11.5px] text-fg-muted">
                  <span className="min-w-0 flex-1 truncate">
                    {parentName && (
                      <span title={`Forked from ${parentName}`}>↳ {parentName}</span>
                    )}
                    {parentName && bot.queued > 0 && " · "}
                    {bot.queued > 0 && <span>{bot.queued} queued</span>}
                  </span>
                  {pending > 0 && (
                    <span
                      role="status"
                      aria-label={`${pending} pending approval${pending === 1 ? "" : "s"}`}
                      className="rounded-full bg-warn px-1.5 text-[11px] font-semibold text-black"
                    >
                      {pending}
                    </span>
                  )}
                  <span
                    role="img"
                    aria-label={bot.busy ? "busy" : "idle"}
                    className={`size-2 shrink-0 rounded-full ${bot.busy ? "animate-pulse bg-warn" : "bg-fg-faint"}`}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
