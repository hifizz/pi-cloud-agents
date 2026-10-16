import { Icon } from "../../components/Chat/primitives/Icon";
import { cx } from "../../lib/cx";
import type { TurnChange } from "../../lib/turns";
import { TurnSelect } from "./TurnSelect";

interface Props {
  turns: TurnChange[];
  turn?: TurnChange;
  onTurn: (key: string) => void;
  wrap: boolean;
  onWrap: () => void;
  allCollapsed: boolean;
  onToggleAll: () => void;
}

const btn = "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-hover";

export function DiffToolbar({ turns, turn, onTurn, wrap, onWrap, allCollapsed, onToggleAll }: Props) {
  return (
    <div className="flex h-[42px] shrink-0 items-center gap-3 border-b border-line px-3">
      <TurnSelect turns={turns} value={turn?.key} onChange={onTurn} />
      {turn && (
        <span className="font-mono text-xs" aria-label="Turn totals">
          <span className="text-ok">+{turn.add}</span> <span className="text-bad">−{turn.del}</span>
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button type="button" aria-pressed={wrap} onClick={onWrap} className={cx(btn, wrap ? "border-line-strong bg-selected text-fg" : "border-line text-fg-dim")}>
          Wrap
        </button>
        <button type="button" onClick={onToggleAll} disabled={!turn} className={cx(btn, "border-line text-fg-dim disabled:opacity-40")}>
          <Icon name="collapseAll" />
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
    </div>
  );
}
