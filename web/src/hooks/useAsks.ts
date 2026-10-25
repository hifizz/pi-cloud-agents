import { useEffect, useState } from "react";
import { AsksStream } from "../lib/asks";
import type { AskItem } from "../types";

/** All open ask_user questions across Bots, kept live over WS /api/asks/stream. */
export function useAsks(): AskItem[] {
  const [items, setItems] = useState<AskItem[]>([]);
  useEffect(() => {
    const stream = new AsksStream(setItems);
    stream.start();
    return () => stream.stop();
  }, []);
  return items;
}
