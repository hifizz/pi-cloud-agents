import { useState } from "react";
import { splitLines } from "../../../lib/format";
import { cx } from "../../../lib/cx";

const MAX_LINES = 200;

/** Monospace output panel with line truncation ("Show all N lines"). */
export function Output({ text, label, tone = "default", header, className }: { text: string; label: string; tone?: "default" | "error"; /** Rendered above the text in the same box, e.g. `$ command`. */ header?: string; className?: string }) {
  const [showAll, setShowAll] = useState(false);
  const { shown, total, truncated } = splitLines(text, showAll ? Number.POSITIVE_INFINITY : MAX_LINES);
  return (
    <div className={cx("overflow-hidden rounded-lg border border-zinc-800 bg-black/30", className)}>
      {header && (
        <pre className={cx("overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.8px] leading-[1.65] text-zinc-200", text && "border-b border-zinc-800")}>
          <span className="select-none text-zinc-600">$ </span>
          {header}
        </pre>
      )}
      {text && <pre
        aria-label={label}
        tabIndex={0}
        className={cx(
          "max-h-96 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.8px] leading-[1.65] focus-visible:outline-2 focus-visible:outline-sky-400",
          tone === "error" ? "text-red-300/90" : "text-zinc-400",
        )}
      >
        {shown}
      </pre>}
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full border-t border-zinc-800 px-3 py-1 text-left text-xs text-sky-400 hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-400"
        >
          Show all {total} lines
        </button>
      )}
    </div>
  );
}
