import { useState } from "react";
import { splitLines } from "../../../lib/format";
import { cx } from "../../../lib/cx";

const MAX_LINES = 200;

/** Monospace output panel with line truncation ("Show all N lines"). */
export function Output({ text, label, tone = "default", header, className }: { text: string; label: string; tone?: "default" | "error"; /** Rendered above the text in the same box, e.g. `$ command`. */ header?: string; className?: string }) {
  const [showAll, setShowAll] = useState(false);
  const { shown, total, truncated } = splitLines(text, showAll ? Number.POSITIVE_INFINITY : MAX_LINES);
  return (
    <div className={cx("overflow-hidden rounded-lg border border-[#1d1d1d] bg-[#0b0b0b]", className)}>
      {header && (
        <pre className={cx("overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.8px] leading-[1.65] text-fg", text && "border-b border-[#1d1d1d]")}>
          <span className="select-none text-fg-faint">$ </span>
          {header}
        </pre>
      )}
      {text && <pre
        aria-label={label}
        tabIndex={0}
        className={cx(
          "max-h-[230px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.8px] leading-[1.65] focus-visible:outline-2 focus-visible:outline-accent",
          tone === "error" ? "text-bad" : "text-fg-dim",
        )}
      >
        {shown}
      </pre>}
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full border-t border-[#1d1d1d] px-3 py-1 text-left text-xs text-accent hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
        >
          Show all {total} lines
        </button>
      )}
    </div>
  );
}
