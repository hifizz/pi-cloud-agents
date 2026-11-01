import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Tick02Icon } from "@hugeicons/core-free-icons"

import { cn } from "cn"

type MenuSize = "sm" | "default"

/** 菜单容器的尺寸：外边距与圆角随 size 变化。 */
function PopoverMenu({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: MenuSize }) {
  return (
    <div
      data-slot="popover-menu"
      data-size={size}
      className={cn(
        "flex flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-xl",
        "data-[size=default]:p-1 data-[size=sm]:p-1",
        className
      )}
      {...props}
    />
  )
}

/** 菜单标题（如 Order by）。 */
function PopoverMenuLabel({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"p"> & { size?: MenuSize }) {
  return (
    <p
      data-slot="popover-menu-label"
      data-size={size}
      className={cn(
        "font-medium text-popover-foreground",
        "data-[size=default]:px-2 data-[size=default]:pb-1 data-[size=default]:text-[12px] data-[size=default]:leading-4",
        "data-[size=sm]:px-1.5 data-[size=sm]:pb-0.5 data-[size=sm]:text-[11px] data-[size=sm]:leading-3.5",
        className
      )}
      {...props}
    />
  )
}

/**
 * 菜单项。`size` 控制高度（default 32px / sm 26px）、内边距与字号。
 * `selected` 显示勾选图标与选中底色。
 */
function PopoverMenuItem({
  className,
  size = "default",
  selected = false,
  icon,
  description,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  size?: MenuSize
  selected?: boolean
  /** 左侧图标 */
  icon?: React.ReactNode
  /** 标题下方的说明文字（两行布局） */
  description?: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-slot="popover-menu-item"
      data-size={size}
      data-selected={selected || undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md text-left text-popover-foreground transition-colors",
        "hover:bg-accent data-[selected]:bg-accent/70",
        "data-[size=default]:px-2 data-[size=default]:py-1.5 data-[size=default]:text-[13px] data-[size=default]:leading-5",
        "data-[size=sm]:px-1.5 data-[size=sm]:py-1 data-[size=sm]:text-[12px] data-[size=sm]:leading-4",
        className
      )}
      {...props}
    >
      {icon && (
        <span
          data-slot="popover-menu-item-icon"
          className={cn("flex shrink-0 items-center justify-center text-muted-foreground", size === "sm" ? "size-3.5" : "size-4")}
        >
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{children}</span>
        {description && (
          <span
            data-slot="popover-menu-item-description"
            className="text-[12px] leading-4 whitespace-normal text-muted-foreground"
          >
            {description}
          </span>
        )}
      </span>
      {selected && (
        <HugeiconsIcon
          icon={Tick02Icon}
          data-slot="popover-menu-item-check"
          strokeWidth={1.8}
          className={cn("shrink-0", size === "sm" ? "size-3" : "size-3.5")}
        />
      )}
    </button>
  )
}

/** 菜单分隔线。 */
function PopoverMenuSeparator({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"hr"> & { size?: MenuSize }) {
  return (
    <hr
      data-slot="popover-menu-separator"
      data-size={size}
      className={cn(
        "border-border",
        "data-[size=default]:my-1 data-[size=sm]:my-0.5",
        className
      )}
      {...props}
    />
  )
}

export { PopoverMenu, PopoverMenuLabel, PopoverMenuItem, PopoverMenuSeparator }
