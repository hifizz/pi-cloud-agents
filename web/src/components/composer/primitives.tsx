import type { ComponentProps } from "react";

const TONES = {
  default: "text-foreground/80",
  muted: "text-muted-foreground",
} as const;

/** 工具栏图标按钮的公共底座。 */
export function IconButton({ className = "", children, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color,transform] duration-100 hover:bg-accent active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/** 工具栏文字选择器：图标 + 文案，权限 / 模型等共用。 */
export function SelectPill({
  icon,
  label,
  tone = "default",
  className = "",
  ...props
}: ComponentProps<"button"> & {
  icon?: React.ReactNode;
  label: React.ReactNode;
  tone?: keyof typeof TONES;
}) {
  return (
    <button
      type="button"
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] whitespace-nowrap transition-colors duration-100 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TONES[tone]} ${className}`}
      {...props}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
