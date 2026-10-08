import { useState } from "react";

export function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded-md border border-zinc-800 bg-zinc-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-sky-400"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span>{streaming ? "Thinking…" : "Thought"}</span>
      </button>
      {open && <div className="whitespace-pre-wrap border-t border-zinc-800 px-3 py-2 text-xs italic text-zinc-400">{text}</div>}
    </div>
  );
}
