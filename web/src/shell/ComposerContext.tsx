// Slots under the Composer card (reference `.worktree` strip and `.statusline`).
import { Icon } from "../components/Chat/primitives/Icon";
import type { SpaceInfo, StreamStatus } from "../types";

const SPRITE_WORKDIR = "/home/sprite/workspace";

export function WorktreeStrip({ space, cwd }: { space?: SpaceInfo; cwd?: string }) {
  if (!space) return null;
  const label = `${space.sandbox === "e2b" ? "E2B" : space.sandbox === "instabox" ? "InstaBox" : "Sprite"} ${space.name ?? "(未配置)"}`;
  const dir = cwd ?? space.cwd ?? SPRITE_WORKDIR;
  return (
    <div className="mx-2.5 flex h-[34px] items-center justify-between gap-3 rounded-b-[10px] border border-t-0 border-[#222] bg-[#101010] px-3 text-[11.5px] text-fg-faint">
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon name="box" className="size-3" />
        <span className="truncate">{label}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5" title={dir}>
        <Icon name="folder" className="size-3" />
        <span className="truncate font-mono">{dir}</span>
      </span>
    </div>
  );
}

export function StatusLine({ busy, queued, status }: { busy: boolean; queued: number; status: StreamStatus }) {
  let text: string;
  let color = "bg-fg-faint";
  if (status !== "open") {
    text = status === "reconnecting" ? "Reconnecting…" : status === "connecting" ? "Connecting…" : "Disconnected";
    color = "bg-warn";
  } else if (busy) {
    text = "Working…";
    color = "bg-warn animate-pulse";
  } else if (queued > 0) {
    text = `${queued} queued`;
  } else {
    text = "Idle";
    color = "bg-[#8fb98f]";
  }
  return (
    <div className="flex items-center gap-1.5 px-3.5 pt-2 text-[11.5px] text-fg-faint">
      <span className={`size-1.5 rounded-full ${color}`} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
