import type { ComponentProps } from "react";

/** 外层灰面板：包住输入卡和上下文条（vendored from playground devin-composer, dark tokens）。 */
export function ComposerFrame({ className = "", ...props }: ComponentProps<"div">) {
  return (
    <div
      className={`flex w-full flex-col rounded-2xl bg-muted px-1.5 pt-1.5 pb-1 ${className}`}
      {...props}
    />
  );
}
