import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type ContextStripItem = {
  icon?: React.ReactNode;
  label: string;
  /** 悬停提示（如完整路径）。 */
  title?: string;
  /** 悬停时显示的 shadcn Tooltip 内容（如 cwd 的完整路径）。 */
  tooltip?: string;
};

/** 面板底部的上下文条：目录 / 分支等只读信息项；trailing 渲染在右端（Sprite 条目、状态行等）。 */
export function ContextStrip({
  items,
  trailing,
  className = "",
}: {
  items: ContextStripItem[];
  /** 右端插槽（ml-auto），与 items 同排。 */
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-h-6 items-center gap-3 px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground ${className}`}>
      {items.map((item) => {
        const inner = (
          <>
            {item.icon && <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-full">{item.icon}</span>}
            <span className="truncate">{item.label}</span>
          </>
        );
        return item.tooltip ? (
          <Tooltip key={item.label}>
            <TooltipTrigger render={<span title={item.title} className="flex min-w-0 items-center gap-1.5">{inner}</span>} />
            <TooltipContent>{item.tooltip}</TooltipContent>
          </Tooltip>
        ) : (
          <span key={item.label} title={item.title} className="flex min-w-0 items-center gap-1.5">
            {inner}
          </span>
        );
      })}
      {trailing && <span className="ml-auto flex min-w-0 items-center gap-3">{trailing}</span>}
    </div>
  );
}
