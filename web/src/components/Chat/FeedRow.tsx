import { gapBefore, type FeedRow as Row } from "../../lib/turns";
import { AssistantText } from "./parts/AssistantText";
import { FilesChanged } from "./parts/FilesChanged";
import { FoldRow } from "./parts/FoldRow";
import { CompactionNote, SystemNote, TurnNotice } from "./parts/Notes";
import { Thinking } from "./parts/Thinking";
import { UserMessage } from "./parts/UserMessage";
import { Collapse } from "./primitives/Collapse";
import { ImageStrip } from "./primitives/Images";
import { Icon } from "./primitives/Icon";
import { ToolCall } from "./tools/ToolCall";

export interface FeedRowHandlers {
  onToggleTurn: (turnKey: string) => void;
  onFork?: (entryId: number | string) => void;
}

function PartView({ row }: { row: Extract<Row, { type: "part" }> }) {
  const { part, streaming } = row;
  switch (part.type) {
    case "text":
      return <AssistantText text={part.text} streaming={streaming} />;
    case "thinking":
      return <Thinking text={part.text} streaming={streaming} />;
    case "tool":
      return <ToolCall tool={part} />;
    case "image":
      return <ImageStrip images={[part]} size="lg" alt="Attached image" />;
  }
}

function ForkButton({ entryId, onFork, className }: { entryId: number | string; onFork: (id: number | string) => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => onFork(entryId)}
      className={`flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-400 opacity-0 shadow-sm hover:bg-zinc-900 hover:text-zinc-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-sky-400 group-hover/row:opacity-100 ${className ?? ""}`}
    >
      <Icon name="fork" className="size-3" />
      Fork from here
    </button>
  );
}

/** Dispatch one derived feed row to its component. This is the only switch over row types. */
export function FeedRowView({ row, handlers }: { row: Row; handlers: FeedRowHandlers }) {
  switch (row.type) {
    case "fold":
      return (
        <>
          <FoldRow label={row.label} steps={row.steps} open={row.open} onToggle={() => handlers.onToggleTurn(row.turnKey)} />
          <Collapse open={row.open}>
            {/* -mx/px leaves room for focus outlines while the collapse clips. */}
            <div className="-mx-1 px-1">
              <FeedRowList rows={row.rows} handlers={handlers} before={row} />
            </div>
          </Collapse>
        </>
      );
    case "files":
      return <FilesChanged files={row.files} />;
    case "notice":
      return <TurnNotice message={row.message} />;
    case "message": {
      const m = row.message;
      if (m.role === "system") return <SystemNote message={m} />;
      if (m.role === "compaction") return <CompactionNote message={m} />;
      return (
        <div className="group/row flex items-center justify-end gap-2">
          {handlers.onFork && m.entryId !== undefined && !m.pending && <ForkButton entryId={m.entryId} onFork={handlers.onFork} />}
          <UserMessage message={m} />
        </div>
      );
    }
    case "part":
      return (
        <div className="group/row relative">
          {row.fork && handlers.onFork && row.message.entryId !== undefined && <ForkButton entryId={row.message.entryId} onFork={handlers.onFork} className="absolute -top-2.5 right-0" />}
          <PartView row={row} />
        </div>
      );
  }
}

/** A run of rows with neighbour-based spacing. `before` is the row directly above the first one (fold parents). */
export function FeedRowList({ rows, handlers, before }: { rows: Row[]; handlers: FeedRowHandlers; before?: Row }) {
  return (
    <>
      {rows.map((row, i) => (
        <div key={row.key} className={gapBefore(i === 0 ? before : rows[i - 1], row)}>
          <FeedRowView row={row} handlers={handlers} />
        </div>
      ))}
    </>
  );
}
