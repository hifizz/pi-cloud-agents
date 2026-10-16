import { usageLabel } from "../lib/format";
import type { Usage } from "../types";

export function UsageBadge({ usage }: { usage: Usage }) {
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded-full border border-line-strong bg-field px-2.5 py-0.5 font-mono text-xs text-fg-dim max-md:hidden"
      title={`in ${usage.input} · out ${usage.output} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite}`}
      aria-label={`Usage: ${usageLabel(usage)}`}
    >
      {usageLabel(usage)}
    </span>
  );
}
