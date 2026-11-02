import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpIcon } from "@hugeicons/core-free-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** 发送按钮：idle 时发送，busy 时 steer。可访问名随状态切换（Send / Steer）。 */
export function SendButton({
  disabled = false,
  busy = false,
  onSend,
}: {
  disabled?: boolean;
  busy?: boolean;
  onSend?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={busy ? "Steer" : "Send"}
            title={busy ? "Steer the running bot" : "Send"}
            disabled={disabled}
            onClick={onSend}
            className={`flex h-7 shrink-0 items-center justify-center gap-1 rounded-full bg-muted text-muted-foreground transition-[background-color,transform] duration-100 enabled:bg-primary enabled:text-primary-foreground enabled:hover:bg-primary/90 enabled:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${busy ? "px-2.5 text-[12px]" : "size-7"}`}
          >
            <HugeiconsIcon icon={ArrowUpIcon} className="size-3.5" strokeWidth={2} />
            {busy && "Steer"}
          </button>
        }
      />
      <TooltipContent>{busy ? "Enter steer · Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行"}</TooltipContent>
    </Tooltip>
  );
}
