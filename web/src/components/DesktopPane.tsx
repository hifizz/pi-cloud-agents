import { useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api } from "../lib/api";

const MIN = 280;
const MAX = 1400;
const KEY = "tarsbot.desktop.width";

function initialWidth(): number {
  const saved = Number(globalThis.localStorage?.getItem(KEY));
  return Number.isFinite(saved) && saved >= MIN ? Math.min(saved, MAX) : 520;
}

export function DesktopPane() {
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(initialWidth);
  const [viewerUrl, setViewerUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .space()
      .then((s) => {
        if (!alive) return;
        if (s?.viewerUrl) setViewerUrl(s.viewerUrl);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const resize = (next: number) => {
    const w = Math.max(MIN, Math.min(MAX, next));
    setWidth(w);
    try {
      globalThis.localStorage?.setItem(KEY, String(w));
    } catch {
      /* storage unavailable */
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) resize(window.innerWidth - e.clientX);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") resize(width + 24);
    else if (e.key === "ArrowRight") resize(width - 24);
  };

  if (collapsed) {
    return (
      <aside aria-label="Desktop" className="flex w-10 shrink-0 flex-col items-center border-l border-zinc-800 py-3">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Show desktop"
          className="rounded border border-zinc-700 px-1.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-sky-400"
        >
          ◂
        </button>
      </aside>
    );
  }

  return (
    <aside aria-label="Desktop" className="relative flex shrink-0 border-l border-zinc-800" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize desktop pane"
        aria-valuenow={width}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onKeyDown={onKeyDown}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-sky-500/40 focus-visible:bg-sky-500/60 focus-visible:outline-none"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Desktop</h2>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-sky-400"
          >
            Hide
          </button>
        </div>
        {viewerUrl ? (
          <iframe
            title="Bot desktop"
            src={viewerUrl}
            className="min-h-0 flex-1 bg-black"
            style={dragging ? { pointerEvents: "none" } : undefined}
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <p className="p-4 text-sm text-zinc-500">
            {failed ? "Desktop viewer unavailable: GET /api/space did not return a viewerUrl." : "Loading desktop…"}
          </p>
        )}
      </div>
    </aside>
  );
}
