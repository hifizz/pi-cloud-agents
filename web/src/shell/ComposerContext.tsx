// Slot under the Composer card (reference `.statusline`).
import type { StreamStatus } from "../types";

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
