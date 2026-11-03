// Pure layout: rail | main | panel. No business imports (docs/UI-PLAN.md U-D5).
// One resizable group is always mounted with rail / main / panel in fixed positions, so every column
// keeps a single mount identity across the md (768px) and xl (1280px) breakpoints.
// Open/close still mounts/unmounts that column's Panel; unaffected siblings keep their state.
// Breakpoints never change the tree: they only flip a column's
// min/max size and whether its content sits inline or escapes as a fixed overlay drawer.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import type { Layout, LayoutChangedMeta } from "../components/ui/resizable";
import { useGroupRef } from "react-resizable-panels";
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
// Each sidebar gets its own pixel cap so dragging one can't squeeze main to nothing and then start
// pushing the other sidebar — a handle only ever resizes the column directly beside it.
const RAIL_MAX_PX = 480;
const PANEL_DEFAULT_PX = 480;
const PANEL_MIN_PX = 320;
// Panel's max isn't a static cap — it's whatever is left once main hits its floor. Computed per
// render from the live group width so a wide monitor can stretch the panel arbitrarily.
const MAIN_MIN_PX = 360;

interface PersistedLayout {
  rail: number;
  panel: number;
  /** Drawer width for md..xl where the panel is a fixed overlay (not an inline column). Distinct
   * from `panel` so the inline drag and the drawer drag don't overwrite each other. */
  panelDrawer: number;
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
    const v = JSON.parse(raw) as { rail?: unknown; panel?: unknown; panelDrawer?: unknown } | null;
    if (!isFiniteNumber(v?.rail) || !isFiniteNumber(v?.panel)) return null;
    // Clamp persisted widths into the live min/max so an old out-of-range value can't reopen past
    // a column's cap. Panel has no static ceiling — its cap is enforced against MAIN_MIN_PX at
    // render time from the live group width.
    return {
      rail: Math.min(Math.max(v.rail, RAIL_MIN_PX), RAIL_MAX_PX),
      panel: Math.max(v.panel, PANEL_MIN_PX),
      panelDrawer: isFiniteNumber(v.panelDrawer) ? Math.max(v.panelDrawer, PANEL_MIN_PX) : PANEL_DEFAULT_PX,
    };
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
  const groupRef = useGroupRef();
  // Last good persisted widths, seeded once from localStorage. A column that is closed or below its
  // inline breakpoint is absent from the live layout (size ~0), so it keeps this value instead of
  // being overwritten with ~0; `persist` updates it on each completed user resize.
  const [initialWidths] = useState<PersistedLayout>(() => loadLayout() ?? { rail: RAIL_DEFAULT_PX, panel: PANEL_DEFAULT_PX, panelDrawer: PANEL_DEFAULT_PX });
  const widths = useRef<PersistedLayout>(initialWidths);
  // Bump to rerender when widths.current changes outside the group's onLayoutChanged (e.g. dragging
  // the drawer handle below xl, where the library isn't driving the column width).
  const [, setWidthsVersion] = useState(0);
  // Panel's live max in pixels: group width minus rail minus main's floor. Falls back to the
  // viewport width on the first render before the ref attaches.
  const groupWidth = groupElRef.current?.getBoundingClientRect().width ?? globalThis.innerWidth ?? 0;
  const railNow = railOpen ? widths.current.rail : 0;
  const panelMaxPx = Math.max(PANEL_MIN_PX, groupWidth - railNow - MAIN_MIN_PX);
  // Drawer's effective width for md..xl: its own persisted width, capped so main still has
  // MAIN_MIN_PX. Independent of the inline panel's width so an xl+ drag doesn't blow up the drawer.
  const drawerCap = Math.min(Math.round(groupWidth * 0.9), Math.max(PANEL_MIN_PX, groupWidth - railNow - MAIN_MIN_PX));
  const drawerWidth = Math.min(Math.max(widths.current.panelDrawer, PANEL_MIN_PX), drawerCap);

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

  // When a column's open state changes, the group's default realloc splits the freed share
  // proportionally across all survivors — visible as the rail growing to its max when the panel
  // closes. Re-normalize: restore each open column to its last persisted pixel width (from
  // `widths`, which only changes on a completed user drag), give main the remainder.
  useEffect(() => {
    // Wait a frame so any newly-mounted panel has registered with the group before we normalize.
    const t = setTimeout(() => {
      const g = groupRef.current;
      if (!g) return;
      const groupWidth = groupElRef.current?.getBoundingClientRect().width || 1;
      const pct = (px: number) => (px / groupWidth) * 100;
      const next: Layout = {
        [RAIL_ID]: railOpen && railInline ? pct(widths.current.rail) : 0,
        [MAIN_ID]: 0,
        [PANEL_ID]: panelOpen && panelInline ? pct(widths.current.panel) : 0,
      };
      next[MAIN_ID] = Math.max(0, 100 - next[RAIL_ID] - next[PANEL_ID]);
      g.setLayout(next);
    }, 0);
    return () => clearTimeout(t);
  }, [railOpen, railInline, panelOpen, panelInline, groupRef]);

  return (
    <SidebarProvider open={railOpen} onOpenChange={onOpenRail}>
      <div className="relative h-dvh w-full overflow-hidden bg-background text-foreground">
        {/* The rail's own content decides drawer vs column: the shadcn Sidebar renders a Sheet drawer
         * below md (useIsMobile) and an inline column at md+. This ResizablePanel supplies the column
         * slot at md+; below md it collapses to zero width while the Sheet mounts the rail content in
         * a portal, so nothing here needs a scrim or a fixed overlay. */}
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex h-full w-full"
          elementRef={groupElRef}
          groupRef={groupRef}
          onLayoutChanged={persist}
        >
          {/* Rail: always mounted (same reason as the panel — a stable column set keeps the group's
           * layout map consistent). Closed or below-md = zero-width slot; Sidebar's own content
           * decides whether to draw the column or escape into a Sheet drawer below md. */}
          <ResizablePanel
            id={RAIL_ID}
            defaultSize={railOpen ? widths.current.rail : 0}
            minSize={railInline ? RAIL_MIN_PX : 0}
            maxSize={railInline ? RAIL_MAX_PX : 0}
            disabled={!railInline}
            groupResizeBehavior="preserve-pixel-size"
            className="h-full min-h-0 flex-col bg-sidebar"
            style={{ overflow: "visible" }}
          >
            {railOpen && (
              /* w-full: the ResizablePanel is the width authority here; Sidebar's own
               * --sidebar-width would leave a gap whenever the resized column is wider. */
              <Sidebar className="h-full w-full border-r border-border bg-sidebar max-md:w-[min(272px,85vw)]">{rail}</Sidebar>
            )}
          </ResizablePanel>
          <ResizableHandle aria-label="调整侧边栏宽度" disabled={!railInline} className={railOpen ? "max-md:hidden" : "hidden"} />

          <ResizablePanel id={MAIN_ID} minSize={MAIN_MIN_PX} className="h-full min-h-0 flex-col overflow-hidden">
            <main className="flex h-full min-h-0 w-full flex-col overflow-hidden" aria-label="Chat">
              {main}
            </main>
          </ResizablePanel>

          {/* Handle only when panel is open and inline-interactive; hidden below xl (drawer mode). */}
          <ResizableHandle aria-label="调整面板宽度" disabled={!panelInline} className={panelOpen ? "max-xl:hidden" : "hidden"} />
          {/* Panel: always mounted so the group's layout map keeps a stable column set — unmounting
           * it would leave a stale % that main never re-absorbs, leaving a gap on the right. Closed
           * or below-xl = zero-width slot; content escapes as a fixed right-edge drawer (md..xl)
           * / full-width cover (<md). Mounted across xl keeps the PTY running. */}
          <ResizablePanel
            id={PANEL_ID}
            // defaultSize only applies at mount; use 0 when closed so the group doesn't allocate
            // the stored pixel width and then clamp it to 0, leaking it to siblings.
            defaultSize={panelOpen ? widths.current.panel : 0}
            minSize={panelInline ? PANEL_MIN_PX : 0}
            maxSize={panelInline ? panelMaxPx : 0}
            disabled={!panelInline}
            groupResizeBehavior="preserve-pixel-size"
            className="h-full min-h-0 flex-col bg-background"
            style={{ overflow: "visible" }}
          >
            {panelOpen && (
              <aside
                className={
                  "flex h-full min-h-0 flex-col overflow-hidden border-l border-border bg-background " +
                  "w-full max-md:border-l-0 " +
                  "max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:shadow-2xl max-xl:shadow-black/60 " +
                  // Below md the drawer covers the full width so controls stay reachable on phones.
                  "max-md:w-full"
                }
                // Drawer width uses its own persisted value (panelDrawer) so an xl+ inline drag
                // doesn't make the md..xl drawer huge. Below md it stays full-width (the class wins).
                style={md && !xl ? { width: drawerWidth } : undefined}
              >
                {/* Drag handle on the drawer's left edge (md..xl only): the ResizablePanel's own
                 * handle is hidden by `max-xl:hidden`, so we drive widths.current.panel by hand.
                 * Positioned inside the aside's border-box so overflow-hidden doesn't clip it. */}
                {md && !xl && (
                  <div
                    role="separator"
                    aria-label="调整面板宽度"
                    aria-orientation="vertical"
                    className="absolute inset-y-0 left-0 z-10 w-[9px] cursor-col-resize hover:bg-border"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      const startX = e.clientX;
                      const startW = widths.current.panelDrawer;
                      const onMove = (ev: PointerEvent) => {
                        const next = Math.min(Math.max(startW + (startX - ev.clientX), PANEL_MIN_PX), drawerCap);
                        if (next === widths.current.panelDrawer) return;
                        widths.current = { ...widths.current, panelDrawer: next };
                        setWidthsVersion((v) => v + 1);
                      };
                      const onUp = () => {
                        globalThis.removeEventListener("pointermove", onMove);
                        globalThis.removeEventListener("pointerup", onUp);
                        saveLayout(widths.current);
                      };
                      globalThis.addEventListener("pointermove", onMove);
                      globalThis.addEventListener("pointerup", onUp);
                    }}
                  />
                )}
                {panel}
              </aside>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </SidebarProvider>
  );
}
