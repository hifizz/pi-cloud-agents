import { useSyncExternalStore } from "react";

/**
 * Tracks a `matchMedia` query and re-renders when the result flips (e.g. crossing the md/xl
 * breakpoints). Shell layout uses it so each column's content mounts exactly once: the resizable
 * group and the mobile drawer are never in the tree at the same time.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = globalThis.matchMedia?.(query);
      if (!mql) return () => {};
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => globalThis.matchMedia?.(query).matches ?? false,
    () => false,
  );
}
