import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelContext } from "../types";
import { DiffFileCard } from "./DiffFileCard";
import { DiffToolbar } from "./DiffToolbar";
import { EmptyState } from "./EmptyState";
import { FileChips } from "./FileChips";
import { conversationSource, type DiffSource } from "./source";

export function DiffPanel({ source = conversationSource, ...ctx }: PanelContext & { source?: DiffSource }) {
  const { turns, loading, error } = source.useTurns(ctx);
  const [picked, setPicked] = useState<string>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const [wrap, setWrap] = useState(false);
  const [pendingScroll, setPendingScroll] = useState<string>();
  const list = useRef<HTMLDivElement>(null);

  const turn = turns.find((t) => t.key === picked) ?? turns[turns.length - 1];
  const files = turn?.files ?? [];

  const pick = useCallback((key: string) => {
    setPicked(key);
    setCollapsed(new Set());
    setSelected(undefined);
  }, []);

  // Focus requests: depend on seq only so a repeated request for the same target still applies.
  const focus = ctx.focus;
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  useEffect(() => {
    if (!focus) return;
    const target = turnsRef.current.find((t) => t.key === focus.turnKey);
    if (target) {
      setPicked(target.key);
      setCollapsed(new Set());
    }
    const path = focus.path;
    if (path) {
      setSelected(path);
      setPendingScroll(path);
    } else if (target) setSelected(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  const scrollTo = useCallback((path: string) => {
    const el = [...(list.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].find((e) => e.dataset.path === path);
    el?.scrollIntoView?.({ block: "start" });
  }, []);

  useEffect(() => {
    if (!pendingScroll) return;
    scrollTo(pendingScroll);
    setPendingScroll(undefined);
  }, [pendingScroll, scrollTo, turn?.key]);

  const allCollapsed = files.length > 0 && files.every((f) => collapsed.has(f.path));
  const toggle = (path: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (!n.delete(path)) n.add(path);
      return n;
    });

  return (
    <div className="flex h-full flex-col bg-surface">
      <DiffToolbar
        turns={turns}
        turn={turn}
        onTurn={pick}
        wrap={wrap}
        onWrap={() => setWrap((w) => !w)}
        allCollapsed={allCollapsed}
        onToggleAll={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map((f) => f.path)))}
      />
      {error && <p role="alert" className="px-4 py-2 text-xs text-bad">{error}</p>}
      {!turn ? (
        loading ? <p className="p-4 text-sm text-fg-muted">Loading…</p> : <EmptyState />
      ) : (
        <>
          <FileChips
            files={files}
            selected={selected}
            onSelect={(p) => {
              setSelected(p);
              setCollapsed((c) => {
                const n = new Set(c);
                n.delete(p);
                return n;
              });
              setPendingScroll(p);
            }}
          />
          <div ref={list} className="flex-1 overflow-auto">
            {files.map((f) => (
              <DiffFileCard key={f.path} file={f} collapsed={collapsed.has(f.path)} wrap={wrap} selected={selected === f.path} onToggle={() => toggle(f.path)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
