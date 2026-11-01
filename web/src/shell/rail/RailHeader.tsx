import { Button } from "../../components/ui/button";
import { Icon } from "../../components/Chat/primitives/Icon";

export function RailHeader({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border bg-gradient-to-b from-[#0b1a33] to-sidebar px-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-[11px] font-bold tracking-wide text-white">PI</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">pi-cloud-agents</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Collapse sidebar"
        title="Collapse sidebar"
        onClick={onCollapse}
        className="shrink-0"
      >
        <Icon name="sidebar" className="size-4" />
      </Button>
    </div>
  );
}
