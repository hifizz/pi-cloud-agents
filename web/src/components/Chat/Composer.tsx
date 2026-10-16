import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../lib/cx";
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
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const ghost = `flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${focus}`;

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
    <div className="bg-gradient-to-t from-surface via-surface to-transparent px-[18px] pb-4 pt-6">
      <div className="mx-auto max-w-[720px]">
        <div className="rounded-[14px] border border-[#262626] bg-field shadow-lg shadow-black/30 transition-colors focus-within:border-[#3a3a3a]">
          <label htmlFor="composer-input" className="sr-only">
            Message
          </label>
          <textarea
            id="composer-input"
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={disabled}
            placeholder={busy ? "Bot is working — Enter to steer, or queue a follow-up" : "Ask for changes, send follow-ups…"}
            className="block max-h-[200px] min-h-14 w-full resize-none border-0 bg-transparent px-4 pb-1 pt-3.5 text-[14.5px] leading-normal text-fg placeholder:text-fg-muted focus:outline-none"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
            {model && (
              <span className="flex h-7 max-w-[45%] items-center gap-1.5 rounded-[7px] px-2 text-[13px] text-fg-dim" title={model}>
                <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-selected text-[8px] font-semibold text-fg">
                  {abbr(model)}
                </span>
                <span className="truncate">{model}</span>
              </span>
            )}
            {queued > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-fg-muted">
                <Icon name="clock" className="size-3" />
                {queued} queued
              </span>
            )}
            <span className="hidden flex-1 text-right text-[11px] text-fg-faint sm:block">{busy ? "Enter steers" : "Enter sends · Shift+Enter newline"}</span>
            <span className="flex-1 sm:hidden" />
            {busy && (
              <>
                <button type="button" onClick={onAbort} className={cx(ghost, "border border-bad/40 text-bad hover:bg-bad/10")}>
                  <Icon name="stop" className="size-3" />
                  Abort
                </button>
                <button type="button" disabled={empty || disabled} onClick={() => void submit("followUp")} className={cx(ghost, "border border-line-strong text-fg-dim hover:bg-hover hover:text-fg")}>
                  Queue
                </button>
              </>
            )}
            <button
              type="button"
              disabled={empty || disabled}
              onClick={() => void submit(busy ? "steer" : "send")}
              aria-label={busy ? "Steer" : "Send"}
              title={busy ? "Steer the running bot" : "Send"}
              className={cx(
                "flex h-[30px] items-center justify-center gap-1.5 rounded-full bg-[#2c2c2c] text-fg hover:bg-[#383838] disabled:cursor-not-allowed disabled:text-fg-faint disabled:hover:bg-[#2c2c2c]",
                focus,
                busy ? "px-3 text-xs font-medium" : "size-[30px]",
              )}
            >
              <Icon name="arrowUp" className="size-4" />
              {busy && "Steer"}
            </button>
          </div>
        </div>
        {context}
        {status}
      </div>
    </div>
  );
}
