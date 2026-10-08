import { usageLabel } from "../lib/format";
import type { Usage } from "../types";

export function UsageBadge({ usage }: { usage: Usage }) {
  return (
    <span
      className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-0.5 font-mono text-xs text-zinc-300"
      title={`in ${usage.input} · out ${usage.output} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite}`}
      aria-label={`Usage: ${usageLabel(usage)}`}
    >
      {usageLabel(usage)}
    </span>
  );
}
