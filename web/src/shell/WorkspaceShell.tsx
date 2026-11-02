// Pure layout: rail | main | panel. No business imports (docs/UI-PLAN.md U-D5).
import type { ReactNode } from "react";
import { Sidebar, SidebarProvider } from "../components/ui/sidebar";

export interface WorkspaceShellProps {
  railOpen: boolean;
  panelOpen: boolean;
  rail: ReactNode;
  main: ReactNode;
  panel: ReactNode;
  /** Feeds SidebarProvider.onOpenChange (Sheet scrim/Escape closes the rail on mobile, SidebarTrigger
   * toggles it). Optional so pure layout tests stay unaffected; App always passes it. */
  onOpenRail?: (open: boolean) => void;
}

export function WorkspaceShell({ railOpen, panelOpen, rail, main, panel, onOpenRail }: WorkspaceShellProps) {
  return (
    <SidebarProvider open={railOpen} onOpenChange={onOpenRail} className="h-dvh overflow-hidden bg-background text-foreground">
      {/* Below md the rail is a Sheet drawer overlaying the conversation; md+ it is an inline column
       * (see components/ui/sidebar). */}
      <Sidebar>{rail}</Sidebar>
      <main className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
        {main}
      </main>
      {/* Below xl the panel overlays the conversation as a drawer instead of squeezing it; below md it covers the
       * full width so controls stay reachable on 390px screens. */}
      {panelOpen && (
        <aside className="flex w-[min(560px,45vw)] shrink-0 flex-col border-l border-border bg-background max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:w-[min(560px,90vw)] max-xl:shadow-2xl max-xl:shadow-black/60 max-md:w-full max-md:border-l-0">
          {panel}
        </aside>
      )}
    </SidebarProvider>
  );
}
