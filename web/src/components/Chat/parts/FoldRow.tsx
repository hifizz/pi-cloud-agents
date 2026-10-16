import { cx } from "../../../lib/cx";
import { Icon } from "../primitives/Icon";

/** "Worked for 42s · 5 steps" — toggles the folded middle of a settled turn. */
export function FoldRow({ label, steps, open, onToggle }: { label: string; steps: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="group/fold flex w-full items-center gap-2 text-left text-sm text-fg-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <Icon name="chevron" className={cx("transition-transform", open && "rotate-90")} />
      <span>{label}</span>
      {steps > 0 && (
        <span className="text-fg-muted">
          · {steps} step{steps === 1 ? "" : "s"}
        </span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-line group-hover/fold:bg-line-strong" />
      {!open && <Icon name="chevron" className="size-3 text-[#5a5a5a]" />}
    </button>
  );
}
