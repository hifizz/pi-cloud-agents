export type ContextStripItem = {
  icon?: React.ReactNode;
  label: string;
  /** 悬停提示（如完整路径）。 */
  title?: string;
};

/** 面板底部的上下文条：目录 / 云沙箱 / 分支等只读信息项。 */
export function ContextStrip({
  items,
  className = "",
}: {
  items: ContextStripItem[];
  className?: string;
}) {
  return (
    <div className={`mt-1 flex h-6 items-center gap-4 px-2 text-[13px] text-muted-foreground ${className}`}>
      {items.map((item) => (
        <span key={item.label} title={item.title} className="flex min-w-0 items-center gap-1.5">
          {item.icon}
          <span className="truncate">{item.label}</span>
        </span>
      ))}
    </div>
  );
}
