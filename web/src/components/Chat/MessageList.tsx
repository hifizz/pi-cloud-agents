import { useEffect, useMemo, useRef, useState } from "react";
import { deriveFeed } from "../../lib/turns";
import type { ChatMessage } from "../../types";
import { FeedRowList } from "./FeedRow";
import { Icon } from "./primitives/Icon";
import { Spinner } from "./primitives/Spinner";

export function MessageList({
  messages,
  busy,
  onFork,
}: {
  messages: ChatMessage[];
  busy: boolean;
  /** When given, messages with an entry id show a "Fork from here" button. */
  onFork?: (entryId: number | string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(() => deriveFeed(messages, { busy, expanded }), [messages, busy, expanded]);
  const handlers = useMemo(
    () => ({
      onFork,
      onToggleTurn: (key: string) =>
        setExpanded((prev) => {
          const next = new Set(prev);
          if (!next.delete(key)) next.add(key);
          return next;
        }),
    }),
    [onFork],
  );

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const working = busy && !messages.some((m) => m.pending);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          setAway(!near);
        }}
        className="h-full overflow-y-auto px-4"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        <div className="mx-auto flex max-w-3xl flex-col py-6">
          {rows.length === 0 && (
            <div className="mt-10 text-center">
              <Icon name="sparkle" className="mx-auto size-5 text-zinc-700" />
              <p className="mt-3 text-sm text-zinc-500">No messages yet. Give this bot a task below.</p>
            </div>
          )}
          <FeedRowList rows={rows} handlers={handlers} />
          {working && (
            <p className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
              <Spinner />
              Working…
            </p>
          )}
        </div>
      </div>
      {away && (
        <button
          type="button"
          onClick={() => {
            const el = ref.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1 text-xs text-zinc-300 shadow-lg hover:bg-zinc-800 hover:text-white focus-visible:outline-2 focus-visible:outline-sky-400"
        >
          <Icon name="arrowDown" className="size-3" />
          Jump to latest
        </button>
      )}
    </div>
  );
}
