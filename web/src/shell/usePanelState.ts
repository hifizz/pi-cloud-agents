// Open/active state of the right-hand panel, persisted in localStorage["pca.panel"].
import { useCallback, useState } from "react";
import type { PanelFocus } from "../panels/types";

const KEY = "pca.panel";

interface Persisted {
  open: boolean;
  active: string | undefined;
}

function load(): Persisted {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null") as { open?: unknown; active?: unknown } | null;
    return {
      open: typeof v?.open === "boolean" ? v.open : true,
      active: typeof v?.active === "string" ? v.active : undefined,
    };
  } catch {
    return { open: true, active: undefined };
  }
}

function save(p: Persisted) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

export interface PanelTarget {
  turnKey?: string;
  path?: string;
}

/**
 * `defaultActive` is the id used when nothing valid is stored (the first panel). An unknown stored id is
 * resolved by PanelHost (falls back to its first panel), so the hook doesn't need the panel list.
 */
export function usePanelState(defaultActive?: string) {
  const [state, setState] = useState<Persisted>(load);
  const [request, setRequest] = useState<{ panel: string; focus: PanelFocus }>();

  const update = useCallback((fn: (p: Persisted) => Persisted) => {
    setState((prev) => {
      const next = fn(prev);
      save(next);
      return next;
    });
  }, []);

  const active = state.active ?? defaultActive ?? "";

  const openPanel = useCallback(
    (id: string, target?: PanelTarget) => {
      update((p) => ({ ...p, open: true, active: id }));
      if (target) setRequest((prev) => ({ panel: id, focus: { ...target, seq: (prev?.focus.seq ?? 0) + 1 } }));
    },
    [update],
  );
  const select = useCallback((id: string) => update((p) => ({ ...p, active: id })), [update]);
  const toggle = useCallback(() => update((p) => ({ ...p, open: !p.open })), [update]);
  const close = useCallback(() => update((p) => ({ ...p, open: false })), [update]);

  /** The focus request, only while the panel it targets is the active one. */
  const focus = request && request.panel === active ? request.focus : undefined;

  return { open: state.open, active, focus, openPanel, select, toggle, close };
}
