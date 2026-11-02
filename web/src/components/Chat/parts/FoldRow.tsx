import { cx } from "../../../lib/cx";
import { Icon } from "../primitives/Icon";

/** "Worked for 42s · 5 steps" — toggles the folded middle of a settled turn. */
export function FoldRow({ label, steps, open, onToggle }: { label: string; steps: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="group/fold flex w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Icon name="chevron" className={cx("transition-transform", open && "rotate-90")} />
      <span>{label}</span>
      {steps > 0 && (
        <span className="text-muted-foreground">
          · {steps} step{steps === 1 ? "" : "s"}
        </span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-border group-hover/fold:bg-input" />
      {!open && <Icon name="chevron" className="size-3 text-muted-foreground/70" />}
    </button>
  );
}
