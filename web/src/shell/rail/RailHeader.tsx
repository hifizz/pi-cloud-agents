import { SidebarHeader, SidebarTrigger } from "../../components/ui/sidebar";

export function RailHeader({ onCollapse }: { onCollapse?: () => void }) {
  return (
    <SidebarHeader>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-[11px] font-bold tracking-wide text-white">PI</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">pi-cloud-agents</span>
      <SidebarTrigger onClick={onCollapse} />
    </SidebarHeader>
  );
}
