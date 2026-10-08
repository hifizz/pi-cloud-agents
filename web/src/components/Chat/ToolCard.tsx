import { useState } from "react";
import { splitLines, summarizeArgs } from "../../lib/format";
import type { ToolPart, ToolStatus } from "../../types";

const MAX_LINES = 200;

const BADGE: Record<ToolStatus, { label: string; cls: string }> = {
  running: { label: "running", cls: "border-sky-700 bg-sky-950 text-sky-300" },
  done: { label: "done", cls: "border-emerald-700 bg-emerald-950 text-emerald-300" },
  error: { label: "error", cls: "border-red-700 bg-red-950 text-red-300" },
  interrupted: { label: "interrupted", cls: "border-amber-700 bg-amber-950 text-amber-300" },
};

export function ToolCard({ tool }: { tool: ToolPart }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [zoom, setZoom] = useState<string | undefined>();
  const badge = BADGE[tool.status];
  const summary = summarizeArgs(tool.args);
  const { shown, total, truncated } = splitLines(tool.output, showAll ? Number.POSITIVE_INFINITY : MAX_LINES);

  return (
    <div className="my-1.5 rounded-md border border-zinc-800 bg-zinc-900" data-testid="tool-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-800/60 focus-visible:outline-2 focus-visible:outline-sky-400"
      >
        <span aria-hidden="true" className="text-zinc-500">
          {open ? "▾" : "▸"}
        </span>
        <span className="font-mono font-semibold text-zinc-100">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{summary}</span>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${badge.cls}`}>{badge.label}</span>
      </button>

      {!open && tool.images && tool.images.length > 0 && (
        <div className="flex gap-2 px-3 pb-2">
          {tool.images.map((img, i) => (
            <Thumb key={i} src={`data:${img.mimeType};base64,${img.data}`} onZoom={setZoom} />
          ))}
        </div>
      )}

      {open && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2">
          <pre className="max-h-40 overflow-auto rounded bg-zinc-950 p-2 font-mono text-xs text-zinc-400">
            {JSON.stringify(tool.args, null, 2)}
          </pre>
          {tool.output && (
            <div>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 font-mono text-xs text-zinc-200" aria-label={`${tool.name} output`}>
                {shown}
              </pre>
              {truncated && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mt-1 text-xs text-sky-400 hover:underline focus-visible:outline-2 focus-visible:outline-sky-400"
                >
                  Show all {total} lines
                </button>
              )}
            </div>
          )}
          {tool.diagnostics?.map((d, i) => (
            <p key={i} className="text-xs text-amber-400">
              {d}
            </p>
          ))}
          {tool.images && tool.images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {tool.images.map((img, i) => (
                <Thumb key={i} src={`data:${img.mimeType};base64,${img.data}`} onZoom={setZoom} />
              ))}
            </div>
          )}
        </div>
      )}

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setZoom(undefined)}
          onKeyDown={(e) => e.key === "Escape" && setZoom(undefined)}
        >
          <img src={zoom} alt="Tool result full size" className="max-h-full max-w-full rounded" />
          <button
            type="button"
            autoFocus
            onClick={() => setZoom(undefined)}
            className="absolute right-4 top-4 rounded bg-zinc-800 px-3 py-1 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-400"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}

function Thumb({ src, onZoom }: { src: string; onZoom: (src: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onZoom(src)}
      aria-label="Enlarge image"
      className="overflow-hidden rounded border border-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-400"
    >
      <img src={src} alt="Tool result thumbnail" className="h-20 w-auto object-cover" />
    </button>
  );
}
