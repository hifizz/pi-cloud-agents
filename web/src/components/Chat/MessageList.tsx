import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../types";
import { MessageItem } from "./MessageItem";

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

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      {messages.length === 0 && <p className="mt-10 text-center text-sm text-zinc-500">No messages yet. Give this bot a task below.</p>}
      {messages.map((m) => (
        <MessageItem key={m.id} message={m} onFork={onFork} />
      ))}
      {busy && !messages.some((m) => m.pending) && <p className="my-2 text-xs text-zinc-500">Working…</p>}
    </div>
  );
}
