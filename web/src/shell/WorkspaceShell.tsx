// Pure layout: rail | main | panel. No business imports (docs/UI-PLAN.md U-D5).
import type { ReactNode } from "react";

export interface WorkspaceShellProps {
  railOpen: boolean;
  panelOpen: boolean;
  rail: ReactNode;
  main: ReactNode;
  panel: ReactNode;
  /** AMP13-collaboration: the rail closes when the scrim below md is tapped. Optional so pure layout tests stay
   * unaffected; App always passes it. */
  onCloseRail?: () => void;
}

export function WorkspaceShell({ railOpen, panelOpen, rail, main, panel, onCloseRail }: WorkspaceShellProps) {
  return (
    <div className="relative flex h-dvh overflow-hidden bg-surface text-fg">
      {railOpen && (
        <>
          {/* Below md the rail is a drawer: it overlays the conversation instead of squeezing it (390px phones
           * keep the chat reachable and nothing overflows horizontally). md+ keeps the inline column. */}
          <button
            type="button"
            aria-label="关闭侧边栏"
            onClick={onCloseRail}
            className="absolute inset-0 z-40 bg-black/50 md:hidden"
          />
          <aside className="absolute inset-y-0 left-0 z-50 flex w-[min(272px,85vw)] shrink-0 flex-col border-r border-line bg-rail md:static md:z-auto md:w-[272px]">
            {rail}
          </aside>
        </>
      )}
      <main className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
        {main}
      </main>
      {/* Below xl the panel overlays the conversation as a drawer instead of squeezing it; below md it covers the
       * full width so controls stay reachable on 390px screens. */}
      {panelOpen && (
        <aside className="flex w-[min(560px,45vw)] shrink-0 flex-col border-l border-line bg-surface max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:w-[min(560px,90vw)] max-xl:shadow-2xl max-xl:shadow-black/60 max-md:w-full max-md:border-l-0">
          {panel}
        </aside>
      )}
    </div>
  );
}
