import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import { Icon } from "./primitives/Icon";

export type SendMode = "send" | "steer" | "followUp";

export interface ComposerProps {
  busy: boolean;
  disabled?: boolean;
  /** Shown as a chip in the toolbar (e.g. "tokenrouter/glm-5.3"). */
  model?: string;
  /** Messages waiting in the bot's inbox. */
  queued?: number;
  onSend: (text: string, mode: SendMode) => void | Promise<void>;
  onAbort: () => void | Promise<void>;
  /** Strip attached under the input card (reference "worktree" strip: sandbox, cwd, …). Content owned by the caller. */
  context?: ReactNode;
  /** One-line status under the strip (reference "statusline"). Content owned by the caller. */
  status?: ReactNode;
}

const MAX_HEIGHT = 200;

/** Two-letter badge for the model chip: "tokenrouter/glm-5.3" → "GL". */
const abbr = (model: string) => (model.split("/").pop() ?? model).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "M";

export function Composer({ busy, disabled, model, queued = 0, onSend, onAbort, context, status }: ComposerProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const empty = text.trim().length === 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  }, [text]);

  const submit = async (mode: SendMode) => {
    const value = text.trim();
    if (!value || disabled) return;
    setText("");
    try {
      await onSend(value, mode);
    } catch {
      setText(value); // keep the draft if submission failed
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts a newline; ignore Enter while an IME is composing.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(busy ? "steer" : "send");
    }
  };

  return (
    <div className="bg-gradient-to-t from-background via-background to-transparent px-[18px] pb-4 pt-6">
      <div className="mx-auto max-w-[720px]">
        <InputGroup className="h-auto flex-col rounded-2xl shadow-lg shadow-black/30">
          <label htmlFor="composer-input" className="sr-only">
            Message
          </label>
          <InputGroupTextarea
            id="composer-input"
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={disabled}
            placeholder={busy ? "Bot is working — Enter to steer, or queue a follow-up" : "Ask for changes, send follow-ups…"}
            className="max-h-[200px] min-h-14 w-full px-4 pb-1 pt-3.5 text-[14.5px]"
          />
          <InputGroupAddon align="block-end" className="gap-2 px-2.5 pb-2.5 pt-1">
            {model && (
              <InputGroupText className="h-7 max-w-[45%] gap-1.5 rounded-md px-2 text-[13px]" title={model}>
                <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-[8px] font-semibold text-foreground">
                  {abbr(model)}
                </span>
                <span className="truncate">{model}</span>
              </InputGroupText>
            )}
            {queued > 0 && (
              <InputGroupText className="gap-1 text-[11px]">
                <Icon name="clock" className="size-3" />
                {queued} queued
              </InputGroupText>
            )}
            <span className="hidden flex-1 text-right text-[11px] text-muted-foreground/70 sm:block">{busy ? "Enter steers" : "Enter sends · Shift+Enter newline"}</span>
            <span className="flex-1 sm:hidden" />
            {busy && (
              <>
                <InputGroupButton type="button" variant="destructive" size="xs" onClick={() => void onAbort()}>
                  <Icon name="stop" className="size-3" />
                  Abort
                </InputGroupButton>
                <InputGroupButton type="button" variant="outline" size="xs" disabled={empty || disabled} onClick={() => void submit("followUp")}>
                  Queue
                </InputGroupButton>
              </>
            )}
            <InputGroupButton
              type="button"
              variant="secondary"
              disabled={empty || disabled}
              onClick={() => void submit(busy ? "steer" : "send")}
              aria-label={busy ? "Steer" : "Send"}
              title={busy ? "Steer the running bot" : "Send"}
              className={cn("rounded-full", busy ? "h-[30px] px-3 text-xs" : "size-[30px]")}
            >
              <Icon name="arrowUp" className="size-4" />
              {busy && "Steer"}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {context}
        {status}
      </div>
    </div>
  );
}
