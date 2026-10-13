import { useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api } from "../lib/api";
import type { SpaceInfo } from "../types";

/** Fixed by the server in sprites mode (config.spaceCwd). */
const SPRITE_WORKDIR = "/home/sprite/workspace";

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
  const [sprite, setSprite] = useState<SpaceInfo>();
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .space()
      .then((s: SpaceInfo) => {
        if (!alive) return;
        if (s?.sandbox === "sprites") setSprite(s);
        else if (s?.viewerUrl) setViewerUrl(s.viewerUrl);
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

  const label = sprite ? "Environment" : "Desktop";

  if (collapsed) {
    return (
      <aside aria-label={label} className="flex w-10 shrink-0 flex-col items-center border-l border-zinc-800 py-3">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label={sprite ? "Show environment" : "Show desktop"}
          className="rounded border border-zinc-700 px-1.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-sky-400"
        >
          ◂
        </button>
      </aside>
    );
  }

  return (
    <aside aria-label={label} className="relative flex shrink-0 border-l border-zinc-800" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={sprite ? "Resize environment pane" : "Resize desktop pane"}
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
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{label}</h2>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-sky-400"
          >
            Hide
          </button>
        </div>
        {sprite ? (
          <dl className="m-3 space-y-2 rounded border border-zinc-800 bg-zinc-900/50 p-3 text-sm" data-testid="sprite-card">
            <div>
              <dt className="text-xs text-zinc-500">执行环境</dt>
              <dd className="text-zinc-200">
                Sprite <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">{sprite.name ?? "(未配置)"}</code>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">工作目录</dt>
              <dd>
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-200">{SPRITE_WORKDIR}</code>
              </dd>
            </div>
          </dl>
        ) : viewerUrl ? (
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
