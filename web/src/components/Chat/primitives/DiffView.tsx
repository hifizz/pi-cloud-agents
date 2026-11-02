import { cx } from "../../../lib/cx";
import type { DiffLine } from "../../../lib/diff";

const MAX_LINES = 400;

/** Unified diff rows with line-number gutter. Pure presentation: feed it `DiffLine[]`. */
export function DiffView({ lines, label = "Diff", className }: { lines: DiffLine[]; label?: string; className?: string }) {
  const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines;
  return (
    <div role="group" aria-label={label} className={cx("max-h-96 overflow-auto rounded-lg border border-border bg-background py-1 font-mono text-[11.8px] leading-[1.7]", className)}>
      {shown.map((l, i) =>
        l.kind === "gap" ? (
          <div key={i} className="select-none px-3 text-muted-foreground/60">
            ⋯
          </div>
        ) : (
          <div key={i} className={cx("flex", "border-l-2", l.kind === "add" ? "border-ok bg-diff-add" : l.kind === "del" ? "border-destructive bg-diff-del" : "border-transparent")}>
            <span className="w-11 shrink-0 select-none pr-2.5 text-right text-muted-foreground/60">{l.num ?? ""}</span>
            <span className={cx("w-4 shrink-0 select-none", l.kind === "add" && "text-ok", l.kind === "del" && "text-destructive")}>
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
            </span>
            <span className={cx("whitespace-pre-wrap break-all pr-3", l.kind === "add" ? "text-[#d7f5df]" : l.kind === "del" ? "text-[#f8d4d4]" : "text-muted-foreground")}>{l.text}</span>
          </div>
        ),
      )}
      {lines.length > MAX_LINES && <div className="px-3 pt-1 text-muted-foreground/60">… {lines.length - MAX_LINES} more lines</div>}
    </div>
  );
}

export function DiffStat({ add, del }: { add: number; del: number }) {
  return (
    <span className="font-mono">
      {add > 0 && <span className="text-ok">+{add}</span>}
      {add > 0 && del > 0 && " "}
      {del > 0 && <span className="text-destructive">−{del}</span>}
    </span>
  );
}
