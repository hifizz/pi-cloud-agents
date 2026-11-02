import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Toggle } from "../../components/ui/toggle";
import { Icon } from "../../components/Chat/primitives/Icon";
import { WorkspaceOpsBar } from "../../components/WorkspaceStatus";
import type { Workspace } from "../../lib/workspaces";
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
  /** Owning workspace; the create-PR / save-checkpoint ops render only when it resolves and is ready. */
  workspace?: Workspace;
}

export function DiffToolbar({ turns, turn, onTurn, wrap, onWrap, allCollapsed, onToggleAll, workspace }: Props) {
  return (
    <div className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border px-3">
      <TurnSelect turns={turns} value={turn?.key} onChange={onTurn} />
      {turn && (
        <span className="font-mono text-xs" aria-label="Turn totals">
          <Badge variant="outline" className="mr-1 border-0 px-1 font-mono text-ok">+{turn.add}</Badge>
          <Badge variant="outline" className="border-0 px-1 font-mono text-bad">−{turn.del}</Badge>
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {workspace && <WorkspaceOpsBar workspace={workspace} />}
        <Toggle type="button" pressed={wrap} onPressedChange={onWrap} size="sm" variant="outline" aria-pressed={wrap}>
          Wrap
        </Toggle>
        <Button type="button" variant="outline" size="sm" onClick={onToggleAll} disabled={!turn}>
          <Icon name="collapseAll" />
          {allCollapsed ? "Expand all" : "Collapse all"}
        </Button>
      </div>
    </div>
  );
}
