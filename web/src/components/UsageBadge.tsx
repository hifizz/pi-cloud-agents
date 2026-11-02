import { usageLabel } from "../lib/format";
import type { Usage } from "../types";
import { Badge } from "./ui/badge";

export function UsageBadge({ usage }: { usage: Usage }) {
  return (
    <Badge
      variant="outline"
      className="shrink-0 whitespace-nowrap rounded-full px-2.5 font-mono max-md:hidden"
      title={`in ${usage.input} · out ${usage.output} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite}`}
      aria-label={`Usage: ${usageLabel(usage)}`}
    >
      {usageLabel(usage)}
    </Badge>
  );
}
