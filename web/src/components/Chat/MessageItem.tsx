import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, Part } from "../../types";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./ToolCard";

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function PartView({ part, streaming }: { part: Part; streaming: boolean }) {
  switch (part.type) {
    case "text":
      return part.text ? <Markdown text={part.text} /> : null;
    case "thinking":
      return <ThinkingBlock text={part.text} streaming={streaming} />;
    case "tool":
      return <ToolCard tool={part} />;
    case "image":
      return <img src={`data:${part.mimeType};base64,${part.data}`} alt="Attached" className="my-1 max-h-64 rounded border border-zinc-700" />;
  }
}

export const MessageItem = memo(function MessageItem({ message, onFork }: { message: ChatMessage; onFork?: (entryId: number | string) => void }) {
  if (message.role === "system") {
    return (
      <div role="note" className="my-3 text-center text-xs text-zinc-500">
        {message.parts.map((p, i) => (p.type === "text" ? <span key={i} className="whitespace-pre-wrap">{p.text}</span> : null))}
      </div>
    );
  }

  if (message.role === "compaction") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return (
      <details className="my-3 rounded-md border border-dashed border-zinc-700 px-3 py-2 text-xs text-zinc-400">
        <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-sky-400">Context compacted — summary</summary>
        <div className="mt-2">
          <Markdown text={text} />
        </div>
      </details>
    );
  }

  const isUser = message.role === "user";
  const canFork = !!onFork && message.entryId !== undefined && !message.pending;
  return (
    <div className={`group my-3 flex ${isUser ? "justify-end" : "justify-start"}`} data-role={message.role}>
      <div
        className={`relative max-w-[88%] rounded-lg px-3.5 py-2 text-sm ${isUser ? "bg-sky-900/60 text-zinc-50" : "bg-zinc-900 text-zinc-100"}`}
      >
        {canFork && (
          <button
            type="button"
            onClick={() => onFork(message.entryId!)}
            className={`absolute -top-3 ${isUser ? "right-2" : "left-2"} rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-300 opacity-0 hover:bg-zinc-800 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-sky-400 group-hover:opacity-100`}
          >
            Fork from here
          </button>
        )}
        {message.parts.map((part, i) => (
          <PartView key={part.type === "tool" ? part.id : i} part={part} streaming={!!message.pending} />
        ))}
        {message.pending && message.parts.length === 0 && <span className="text-zinc-500">…</span>}
        {message.error && <p className="mt-1 text-xs text-red-400">Error: {message.error}</p>}
        {message.stopReason === "aborted" && <p className="mt-1 text-xs text-amber-400">Aborted</p>}
      </div>
    </div>
  );
});
