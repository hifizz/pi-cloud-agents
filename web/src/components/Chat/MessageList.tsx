import { useMemo, useState } from "react";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { deriveFeed } from "../../lib/turns";
import type { ChatMessage } from "../../types";
import { FeedRowList } from "./FeedRow";
import { Icon } from "./primitives/Icon";
import { Spinner } from "./primitives/Spinner";

// use-stick-to-bottom (inside Conversation) needs ResizeObserver, which jsdom lacks.
// Every real browser has it, so this only fills the gap in test environments.
if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

export function MessageList({
  messages,
  busy,
  onFork,
  onOpenDiff,
}: {
  messages: ChatMessage[];
  busy: boolean;
  /** When given, messages with an entry id show a "Fork from here" button. */
  onFork?: (entryId: number | string) => void;
  /** When given, changed-files cards show an "Open diff" button. */
  onOpenDiff?: (turnKey: string, path?: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(() => deriveFeed(messages, { busy, expanded }), [messages, busy, expanded]);
  const handlers = useMemo(
    () => ({
      onFork,
      onOpenDiff,
      onToggleTurn: (key: string) =>
        setExpanded((prev) => {
          const next = new Set(prev);
          if (!next.delete(key)) next.add(key);
          return next;
        }),
    }),
    [onFork, onOpenDiff],
  );

  const working = busy && !messages.some((m) => m.pending);

  return (
    <Conversation className="min-h-0 overflow-y-auto overflow-x-hidden" aria-live="polite" aria-label="Conversation">
      <ConversationContent className="mx-auto w-full max-w-[720px] gap-0 px-[18px] pb-24 pt-[26px]">
        {rows.length === 0 && (
          <div className="mt-10 text-center">
            <Icon name="sparkle" className="mx-auto size-5 text-muted-foreground/60" />
            <p className="mt-3 text-sm text-muted-foreground">No messages yet. Give this bot a task below.</p>
          </div>
        )}
        <FeedRowList rows={rows} handlers={handlers} />
        {working && (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            Working…
          </p>
        )}
      </ConversationContent>
      <ConversationScrollButton className="h-auto gap-1.5 border-border bg-card px-3 py-1 text-xs text-muted-foreground shadow-lg shadow-black/50 hover:text-foreground [&_svg]:size-3">
        Jump to latest
      </ConversationScrollButton>
    </Conversation>
  );
}
