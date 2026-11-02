"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { HugeiconsIcon } from "@hugeicons/react"
import { SidebarLeftIcon } from "@hugeicons/core-free-icons"

const SIDEBAR_WIDTH = "272px"
const MOBILE_BREAKPOINT = 768

const SidebarContext = React.createContext<{
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
} | null>(null)

function useSidebar() {
  const ctx = React.useContext(SidebarContext)
  if (!ctx) throw new Error("useSidebar must be used within a SidebarProvider.")
  return ctx
}

function SidebarProvider({
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean) => {
      _setOpen(value)
      onOpenChange?.(value)
    },
    [onOpenChange],
  )
  const toggleSidebar = React.useCallback(() => setOpen(!open), [open, setOpen])
  const state: "expanded" | "collapsed" = open ? "expanded" : "collapsed"
  const isMobile = useIsMobile()
  const value = React.useMemo(
    () => ({ state, open, setOpen, isMobile, toggleSidebar }),
    [state, open, setOpen, isMobile, toggleSidebar],
  )
  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": SIDEBAR_WIDTH, ...style } as React.CSSProperties}
        className={cn("group/sidebar-wrapper flex min-h-svh w-full", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false)
  React.useEffect(() => {
    const mql = globalThis.matchMedia?.(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    if (!mql) return // no matchMedia (jsdom, SSR): stay on the desktop layout
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  return isMobile
}

/** Below md the sidebar renders as a Sheet drawer (only place its content mounts on mobile); md+ it is an
 * inline column. The two never exist in the DOM at once, so children keep a single identity. */
function Sidebar({ className, children, ...props }: React.ComponentProps<"aside">) {
  const { open, setOpen, isMobile } = useSidebar()
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className={cn("w-[min(272px,85vw)] gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground", className)}
        >
          <SheetTitle className="sr-only">Sidebar</SheetTitle>
          {children}
        </SheetContent>
      </Sheet>
    )
  }
  return (
    <aside
      data-slot="sidebar"
      data-state={open ? "expanded" : "collapsed"}
      hidden={!open}
      className={cn(
        "flex h-full w-(--sidebar-width) shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        className,
      )}
      {...props}
    >
      {open ? children : null}
    </aside>
  )
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={className}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) toggleSidebar()
      }}
      {...props}
    >
      <HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={1.8} />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border px-3", className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("flex shrink-0 items-center gap-2 border-t border-sidebar-border p-2.5", className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2", className)}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="sidebar-group"
      className={cn("relative flex w-full min-w-0 flex-col", className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="sidebar-group-label"
      className={cn(
        "flex items-center gap-1.5 truncate px-2 pb-1 text-xs font-medium text-sidebar-foreground/60 [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group-content" className={cn("w-full", className)} {...props} />
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("relative", className)} {...props} />
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button group/menu-button flex w-full min-w-0 items-center gap-2 rounded-lg p-2 text-left text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:bg-sidebar-accent data-[active]:bg-sidebar-accent data-[active]:font-medium data-[active]:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&>span:last-child]:truncate",
  {
    variants: {
      variant: {
        default: "",
        outline: "border border-sidebar-border bg-sidebar",
      },
      size: {
        default: "h-8",
        sm: "h-7 text-xs",
        lg: "h-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function SidebarMenuButton({
  className,
  variant,
  size,
  isActive,
  tooltip,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof sidebarMenuButtonVariants> & {
    isActive?: boolean
    tooltip?: string | React.ComponentProps<typeof TooltipContent>
  }) {
  const button = (
    <button
      type="button"
      data-slot="sidebar-menu-button"
      data-active={isActive || undefined}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  )
  if (!tooltip) return button
  const tipProps = typeof tooltip === "string" ? { children: tooltip } : tooltip
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right" {...tipProps} />
    </Tooltip>
  )
}

function SidebarMenuAction({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="sidebar-menu-action"
      className={cn(
        "absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/60 opacity-0 outline-none transition-opacity group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[popup-open]:opacity-100 data-open:opacity-100 [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  )
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="sidebar-menu-badge"
      className={cn(
        "ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-medium text-sidebar-foreground/70",
        className,
      )}
      {...props}
    />
  )
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      className={cn(
        "mt-0.5 mb-1 ml-4 flex min-w-0 flex-col gap-0.5 border-l border-sidebar-border pl-2.5",
        className,
      )}
      {...props}
    />
  )
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-sub-item" className={cn("relative", className)} {...props} />
}

function SidebarMenuSubButton({
  className,
  size = "sm",
  isActive,
  ...props
}: React.ComponentProps<"button"> & {
  size?: "sm" | "md"
  isActive?: boolean
}) {
  return (
    <button
      type="button"
      data-slot="sidebar-menu-sub-button"
      data-active={isActive || undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active]:bg-sidebar-accent data-[active]:font-medium data-[active]:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 [&>span:last-child]:truncate",
        size === "sm" ? "h-7 text-xs [&_svg]:size-3.5" : "h-8 text-sm [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function SidebarMenuSkeleton({
  className,
  showIcon,
  ...props
}: React.ComponentProps<"div"> & { showIcon?: boolean }) {
  return (
    <div
      data-slot="sidebar-menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-lg px-2", className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" />}
      <Skeleton className="h-4 max-w-(--skeleton-width) flex-1" />
    </div>
  )
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      className={cn("mx-2 w-auto bg-sidebar-border", className)}
      {...props}
    />
  )
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      className={cn("h-8 bg-sidebar shadow-none", className)}
      {...props}
    />
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn("relative flex min-w-0 flex-1 flex-col bg-background", className)}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
}
