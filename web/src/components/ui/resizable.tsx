"use client"

import { Group, Panel, Separator } from "react-resizable-panels"
import type { GroupProps, PanelProps, SeparatorProps } from "react-resizable-panels"
import { cn } from "cn"

// react-resizable-panels v4 names: Group / Panel / Separator. Panel sizes accept pixels (number or
// "Npx"), percentages ("N%"), and em/rem/vh/vw strings; the Group layout is a map of panel id to
// percentage (0..100) reported via onLayoutChanged.

function ResizablePanelGroup({ className, ...props }: GroupProps) {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full", className)}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: PanelProps) {
  return <Panel data-slot="resizable-panel" {...props} />
}

// The library draws the separator as a zero-width hit target (no visible line). This wrapper keeps
// the existing border between columns as the visual line and styles the hit target: it covers the
// border and extends a few pixels past it for easier grabbing. Hover/focus/active highlight uses
// the library's data-separator state attribute ("inactive" | "hover" | "focus" | "active").
function ResizableHandle({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "relative w-0 cursor-col-resize outline-none",
        "after:absolute after:inset-y-0 after:-left-1 after:w-[9px]",
        "after:transition-colors after:duration-100",
        "hover:after:bg-border data-[separator=hover]:after:bg-border data-[separator=focus]:after:bg-border data-[separator=active]:after:bg-primary",
        className
      )}
      {...props}
    />
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
export type { GroupProps, Layout, LayoutChangedMeta, PanelProps, SeparatorProps } from "react-resizable-panels"
