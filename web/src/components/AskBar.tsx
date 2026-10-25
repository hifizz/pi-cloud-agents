import { useState } from "react";
import type { AskItem } from "../types";

export interface AskBarProps {
  /** Open questions belonging to the current Bot. */
  items: AskItem[];
  /** Answer one question; may reject (the bar shows the message and keeps the item). */
  onAnswer: (id: string, answer: string) => Promise<unknown> | void;
}

const btn = "rounded-md px-3 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40";

/** Clickable ask_user questions (idea 14), shown like the approval bar. */
export function AskBar({ items, onAnswer }: AskBarProps) {
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  if (items.length === 0) return null;

  const answer = async (id: string, text: string) => {
    setBusyId(id);
    setError(undefined);
    try {
      await onAnswer(id, text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <section aria-label="Bot questions" className="border-b border-accent/40 bg-accent/10">
      <ul>
        {items.map((item) => (
          <li key={item.id} data-testid="ask-item" className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="text-fg">
                <span className="font-semibold">Bot asks:</span> {item.question}
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                {item.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={`${btn} border border-accent/70 text-fg hover:bg-accent/20`}
                    disabled={busyId === item.id}
                    onClick={() => void answer(item.id, opt)}
                  >
                    {opt}
                  </button>
                ))}
                <span className="text-xs text-fg-dim">…or just type a reply in chat</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="px-4 pb-2 text-xs text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
