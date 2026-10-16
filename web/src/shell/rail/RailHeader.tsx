import { Icon } from "../../components/Chat/primitives/Icon";

export function RailHeader({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line bg-gradient-to-b from-[#0b1a33] to-rail px-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-[11px] font-bold tracking-wide text-white">PI</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">pi-cloud-agents</span>
      <button
        type="button"
        aria-label="Collapse sidebar"
        title="Collapse sidebar"
        onClick={onCollapse}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-white/5 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Icon name="sidebar" className="size-4" />
      </button>
    </div>
  );
}
