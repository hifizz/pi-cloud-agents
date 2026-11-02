import { formatCost, formatTokens } from "@/lib/format";
import type { Usage } from "@/types";

/** Session token usage pill for the composer toolbar. Mono, hover shows the full breakdown. */
export function ComposerUsagePill({ usage }: { usage: Usage }) {
  const breakdown = `输入 ${formatTokens(usage.input)} · 输出 ${formatTokens(usage.output)} · 缓存读 ${formatTokens(
    usage.cacheRead,
  )} · 缓存写 ${formatTokens(usage.cacheWrite)} · 费用 ${formatCost(usage.cost)}`;
  return (
    <span
      className="flex shrink-0 items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
      title={breakdown}
      aria-label={`本会话用量：${formatTokens(usage.totalTokens)} tokens，${formatCost(usage.cost)}`}
    >
      {formatTokens(usage.totalTokens)} tok · {formatCost(usage.cost)}
    </span>
  );
}
