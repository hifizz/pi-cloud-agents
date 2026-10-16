// Pure layout: rail | main | panel. No business imports (docs/UI-PLAN.md U-D5).
import type { ReactNode } from "react";

export interface WorkspaceShellProps {
  railOpen: boolean;
  panelOpen: boolean;
  rail: ReactNode;
  main: ReactNode;
  panel: ReactNode;
}

export function WorkspaceShell({ railOpen, panelOpen, rail, main, panel }: WorkspaceShellProps) {
  return (
    <div className="relative flex h-dvh overflow-hidden bg-surface text-fg">
      {railOpen && <aside className="flex w-[272px] shrink-0 flex-col border-r border-line bg-rail">{rail}</aside>}
      <main className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
        {main}
      </main>
      {/* Below xl the panel overlays the conversation as a drawer instead of squeezing it. */}
      {panelOpen && (
        <aside className="flex w-[min(560px,45vw)] shrink-0 flex-col border-l border-line bg-surface max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:w-[min(560px,90vw)] max-xl:shadow-2xl max-xl:shadow-black/60">
          {panel}
        </aside>
      )}
    </div>
  );
}
