import type { ComponentProps } from "react";

const VARIANTS = {
  ghost: "text-muted-foreground hover:bg-accent",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
  primary: "bg-primary font-medium text-primary-foreground hover:bg-primary/90",
  destructive: "bg-destructive/15 text-destructive hover:bg-destructive/25",
} as const;

/** 工具栏操作按钮：ghost / secondary / primary / destructive。 */
export function ActionButton({
  variant = "secondary",
  icon,
  className = "",
  children,
  ...props
}: ComponentProps<"button"> & {
  variant?: keyof typeof VARIANTS;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`flex h-7 items-center gap-1 rounded-md px-2 text-[13px] whitespace-nowrap transition-[background-color,transform] duration-100 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}
