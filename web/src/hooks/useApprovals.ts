import { useEffect, useState } from "react";
import { ApprovalsStream } from "../lib/approvals";
import type { ApprovalItem } from "../types";

/** All pending approvals across Bots, kept live over WS /api/approvals/stream. */
export function useApprovals(): ApprovalItem[] {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  useEffect(() => {
    const stream = new ApprovalsStream({ onItems: setItems });
    stream.start();
    return () => stream.stop();
  }, []);
  return items;
}
