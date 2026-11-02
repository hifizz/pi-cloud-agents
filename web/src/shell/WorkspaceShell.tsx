// Pure layout: rail | main | panel. No business imports (docs/UI-PLAN.md U-D5).
// One resizable group is always mounted with rail / main / panel in fixed positions, so every column
// keeps a single mount identity across the md (768px) and xl (1280px) breakpoints.
// Open/close still mounts/unmounts that column's Panel; unaffected siblings keep their state.
// Breakpoints never change the tree: they only flip a column's
// min/max size and whether its content sits inline or escapes as a fixed overlay drawer.
import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import type { Layout, LayoutChangedMeta } from "../components/ui/resizable";
import { Sidebar, SidebarProvider } from "../components/ui/sidebar";
import { useMediaQuery } from "./useMediaQuery";

const LAYOUT_KEY = "pca.shell.layout.v1";

// Pixel constraints for the three desktop columns. The rail keeps its old 272px default; the panel
// gets a slightly narrower default now that it is resizable. Widths persist in pixels (not the
// library's percentage layout) so a re-opened column returns to its previous pixel width instead of
// re-absorbing freed space proportionally.
const RAIL_ID = "shell-rail";
const MAIN_ID = "shell-main";
const PANEL_ID = "shell-panel";
const RAIL_DEFAULT_PX = 272;
const RAIL_MIN_PX = 220;
const MAIN_MIN_PX = 300;
const PANEL_DEFAULT_PX = 480;
const PANEL_MIN_PX = 320;

interface PersistedLayout {
  rail: number;
  panel: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Reads the persisted pixel widths; null on absent/corrupt storage so callers use defaults. Invoked
 * once via a lazy useState initializer to seed the widths ref.
 */
function loadLayout(): PersistedLayout | null {
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { rail?: unknown; panel?: unknown } | null;
    return isFiniteNumber(v?.rail) && isFiniteNumber(v?.panel) ? { rail: v.rail, panel: v.panel } : null;
  } catch {
    return null;
  }
}

function saveLayout(l: PersistedLayout) {
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    /* storage unavailable */
  }
}

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
  // Breakpoints: the rail is an inline resizable column at md+, and the panel at xl+. Below those
  // breakpoints the same column (still mounted) collapses to a zero-width slot whose content escapes
  // as a fixed overlay drawer, so it overlays main instead of squeezing it.
  const md = useMediaQuery("(min-width: 768px)");
  const xl = useMediaQuery("(min-width: 1280px)");
  const railInline = railOpen && md;
  const panelInline = panelOpen && xl;

  const groupElRef = useRef<HTMLDivElement | null>(null);
  // Last good persisted widths, seeded once from localStorage. A column that is closed or below its
  // inline breakpoint is absent from the live layout (size ~0), so it keeps this value instead of
  // being overwritten with ~0; `persist` updates it on each completed user resize.
  const [initialWidths] = useState<PersistedLayout>(() => loadLayout() ?? { rail: RAIL_DEFAULT_PX, panel: PANEL_DEFAULT_PX });
  const widths = useRef<PersistedLayout>(initialWidths);

  const persist = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      // Write once per completed user drag/keyboard resize, never per pointer move. Remounts and
      // constraint recomputes also fire this callback but arrive with isUserInteraction=false.
      if (!meta.isUserInteraction) return;
      // Basis is the group's measured width, not a captured innerWidth that can go stale.
      const groupWidth = groupElRef.current?.getBoundingClientRect().width || globalThis.innerWidth || 1;
      const px = (id: string) => ((layout[id] ?? 0) * groupWidth) / 100;
      const next: PersistedLayout = { ...widths.current };
      // Only update a column's stored width when it is actually inline and present in the layout;
      // a closed or overlay column (size ~0) keeps its previous value.
      if (railInline && layout[RAIL_ID] !== undefined) next.rail = px(RAIL_ID);
      if (panelInline && layout[PANEL_ID] !== undefined) next.panel = px(PANEL_ID);
      widths.current = next;
      saveLayout(next);
    },
    [railInline, panelInline],
  );

  return (
    <SidebarProvider open={railOpen} onOpenChange={onOpenRail}>
      <div className="relative h-dvh overflow-hidden bg-background text-foreground">
        {/* The rail's own content decides drawer vs column: the shadcn Sidebar renders a Sheet drawer
         * below md (useIsMobile) and an inline column at md+. This ResizablePanel supplies the column
         * slot at md+; below md it collapses to zero width while the Sheet mounts the rail content in
         * a portal, so nothing here needs a scrim or a fixed overlay. */}
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex h-full w-full"
          elementRef={groupElRef}
          onLayoutChanged={persist}
        >
          {railOpen && (
            <ResizablePanel
              id={RAIL_ID}
              defaultSize={widths.current.rail}
              minSize={railInline ? RAIL_MIN_PX : 0}
              maxSize={railInline ? "100%" : 0}
              disabled={!railInline}
              groupResizeBehavior="preserve-pixel-size"
              className="h-full min-h-0 flex-col bg-sidebar"
              style={{ overflow: "visible" }}
            >
              {/* w-full: the ResizablePanel is the width authority here; Sidebar's own
               * --sidebar-width would leave a gap whenever the resized column is wider. */}
              <Sidebar className="h-full w-full border-r border-border bg-sidebar max-md:w-[min(272px,85vw)]">{rail}</Sidebar>
            </ResizablePanel>
          )}
          {railOpen && <ResizableHandle aria-label="调整侧边栏宽度" disabled={!railInline} className="max-md:hidden" />}

          <ResizablePanel id={MAIN_ID} minSize={md ? MAIN_MIN_PX : 0} className="h-full min-h-0 flex-col overflow-hidden">
            <main className="flex h-full min-h-0 w-full flex-col overflow-hidden" aria-label="Chat">
              {main}
            </main>
          </ResizablePanel>

          {panelOpen && <ResizableHandle aria-label="调整面板宽度" disabled={!panelInline} className="max-xl:hidden" />}
          {/* Panel: inline resizable at xl+; below xl it collapses to a zero-width slot and its content
           * escapes as a fixed right-edge drawer (md..xl) / full-width cover (<md). Stays mounted
           * across the xl breakpoint so the PTY keeps running. */}
          {panelOpen && (
            <ResizablePanel
              id={PANEL_ID}
              defaultSize={widths.current.panel}
              minSize={panelInline ? PANEL_MIN_PX : 0}
              maxSize={panelInline ? "100%" : 0}
              disabled={!panelInline}
              groupResizeBehavior="preserve-pixel-size"
              className="h-full min-h-0 flex-col bg-background"
              style={{ overflow: "visible" }}
            >
              <aside
                className={
                  "flex h-full min-h-0 flex-col overflow-hidden border-l border-border bg-background " +
                  "w-full max-md:border-l-0 " +
                  "max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:w-[min(560px,90vw)] max-xl:shadow-2xl max-xl:shadow-black/60 " +
                  // Below md the drawer covers the full width so controls stay reachable on phones.
                  "max-md:w-full"
                }
              >
                {panel}
              </aside>
            </ResizablePanel>
          )}
        </ResizablePanelGroup>
      </div>
    </SidebarProvider>
  );
}
