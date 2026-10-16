import { useCallback, useState } from "react";

const KEY = "pca.rail";

function load(): boolean {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null") as { open?: unknown } | null;
    return typeof v?.open === "boolean" ? v.open : true;
  } catch {
    return true;
  }
}

export function useRailState() {
  const [open, setOpen] = useState(load);
  const set = useCallback((next: boolean | ((o: boolean) => boolean)) => {
    setOpen((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify({ open: value }));
      } catch {
        /* storage unavailable */
      }
      return value;
    });
  }, []);
  return {
    open,
    toggle: useCallback(() => set((o) => !o), [set]),
    close: useCallback(() => set(false), [set]),
    show: useCallback(() => set(true), [set]),
  };
}
