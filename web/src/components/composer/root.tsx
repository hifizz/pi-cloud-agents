import type { ComponentProps } from "react";

/** 输入卡：内部自上而下排 Input / Toolbar。 */
export function ComposerRoot({ className = "", ...props }: ComponentProps<"div">) {
  return (
    <div
      className={`w-full rounded-xl bg-card shadow-lg shadow-black/30 ${className}`}
      {...props}
    />
  );
}
