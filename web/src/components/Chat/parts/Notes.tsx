import type { ChatMessage } from "../../../types";
import { cx } from "../../../lib/cx";
import { Icon } from "../primitives/Icon";
import { Markdown } from "../primitives/Markdown";

const textOf = (m: ChatMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");

/** Centered system line: context resets, failed background tasks. */
export function SystemNote({ message }: { message: ChatMessage }) {
  const error = message.tone === "error";
  return (
    <div role="note" className={cx("flex items-start justify-center gap-1.5 text-center text-xs", error ? "text-red-400" : "text-zinc-500")}>
      {error && <Icon name="alert" className="mt-0.5" />}
      <span className="whitespace-pre-wrap">{textOf(message)}</span>
    </div>
  );
}

/** Collapsed summary left behind by a context compaction. */
export function CompactionNote({ message }: { message: ChatMessage }) {
  return (
    <details className="rounded-lg border border-dashed border-zinc-800 px-3 py-2 text-xs text-zinc-500">
      <summary className="cursor-pointer select-none hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-sky-400">Context compacted — summary</summary>
      <div className="mt-2 text-zinc-400">
        <Markdown text={textOf(message)} />
      </div>
    </details>
  );
}

/** Error / abort footer of an assistant message. */
export function TurnNotice({ message }: { message: ChatMessage }) {
  if (message.error)
    return (
      <p role="alert" className="flex items-start gap-1.5 text-xs text-red-400">
        <Icon name="alert" className="mt-0.5" />
        <span>Error: {message.error}</span>
      </p>
    );
  return (
    <p className="flex items-center gap-1.5 text-xs text-amber-400">
      <Icon name="stop" className="size-3" />
      Aborted
    </p>
  );
}
