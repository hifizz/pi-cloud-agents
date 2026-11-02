// Session status rendered at the trailing end of the Composer's ContextStrip.
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { StreamStatus } from "../types";

export function StatusLine({ busy, queued, status }: { busy: boolean; queued: number; status: StreamStatus }) {
  let text: string;
  let tip: string;
  let color = "bg-muted-foreground/50";
  if (status !== "open") {
    text = status === "reconnecting" ? "Reconnecting…" : status === "connecting" ? "Connecting…" : "Disconnected";
    tip = status === "reconnecting" ? "连接中断，正在重连" : status === "connecting" ? "正在建立连接" : "连接已断开";
    color = "bg-warn";
  } else if (busy) {
    text = "Working…";
    tip = "Agent 正在执行任务";
    color = "bg-warn animate-pulse";
  } else if (queued > 0) {
    text = `${queued} queued`;
    tip = `${queued} 条消息排队中`;
  } else {
    text = "Idle";
    tip = "会话空闲，等待下一条指令";
    color = "bg-[#8fb98f]";
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex min-w-0 cursor-default items-center gap-1.5 text-[13px] text-muted-foreground/70">
            <span className={`size-1.5 shrink-0 rounded-full ${color}`} aria-hidden="true" />
            <span className="whitespace-nowrap">{text}</span>
          </span>
        }
      />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
