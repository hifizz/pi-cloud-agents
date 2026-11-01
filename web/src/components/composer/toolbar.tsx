/** 工具栏行：left 靠左，right 推到右端。两组都是自由插槽。 */
export function ComposerToolbar({
  left,
  right,
  className = "",
}: {
  left?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center px-2 pb-2 ${className}`}>
      <div className="flex min-w-0 items-center gap-0">{left}</div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">{right}</div>
    </div>
  );
}
