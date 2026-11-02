/** Agent 运行状态：一个带缺口的旋转圆环。 */
export function StatusIndicator({ active = true }: { active?: boolean }) {
  if (!active) return null;
  return (
    <span role="status" aria-label="Agent 运行中" className="flex size-7 shrink-0 items-center justify-center">
      <svg width="14" height="14" viewBox="0 0 16 16" className="animate-spin text-muted-foreground" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeDasharray="30 11"
        />
      </svg>
    </span>
  );
}
