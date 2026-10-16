import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import { clip } from "../../lib/format";
import type { TurnChange } from "../../lib/turns";

export function TurnSelect({ turns, value, onChange }: { turns: TurnChange[]; value?: string; onChange: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = turns.find((t) => t.key === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select turn"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 text-xs text-fg hover:bg-hover"
      >
        {current ? `Turn ${current.index}` : "No turns"}
        <span aria-hidden className="text-fg-muted">▾</span>
      </button>
      {open && (
        <div role="listbox" aria-label="Turns" className="absolute left-0 top-8 z-20 max-h-72 w-72 overflow-auto rounded-lg border border-line-strong bg-raised p-1 shadow-xl">
          {turns.map((t) => (
            <button
              key={t.key}
              type="button"
              role="option"
              aria-selected={t.key === value}
              onClick={() => {
                onChange(t.key);
                setOpen(false);
              }}
              className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover", t.key === value && "bg-selected")}
            >
              <span className="shrink-0 text-fg">Turn {t.index}</span>
              <span className="min-w-0 flex-1 truncate text-fg-muted">{t.title ? clip(t.title, 40) : ""}</span>
              <span className="shrink-0 font-mono text-ok">+{t.add}</span>
              <span className="shrink-0 font-mono text-bad">−{t.del}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
