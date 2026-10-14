import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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
}

const MAX_HEIGHT = 200;
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400";
const ghost = `flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${focus}`;

export function Composer({ busy, disabled, model, queued = 0, onSend, onAbort }: ComposerProps) {
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
    <div className="bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent px-4 pb-4 pt-2">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 shadow-lg shadow-black/30 transition-colors focus-within:border-zinc-600">
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
            placeholder={busy ? "Bot is working — Enter to steer, or queue a follow-up" : "Message the bot…"}
            className="block max-h-[200px] min-h-14 w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14.5px] leading-normal text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
            {model && <span className="max-w-[45%] truncate rounded-md bg-zinc-800/70 px-2 py-1 font-mono text-[11px] text-zinc-400">{model}</span>}
            {queued > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-zinc-500">
                <Icon name="clock" className="size-3" />
                {queued} queued
              </span>
            )}
            <span className="hidden flex-1 text-right text-[11px] text-zinc-600 sm:block">{busy ? "Enter steers" : "Enter sends · Shift+Enter newline"}</span>
            <span className="flex-1 sm:hidden" />
            {busy && (
              <>
                <button type="button" onClick={onAbort} className={cx(ghost, "border border-red-900 text-red-300 hover:bg-red-950/60")}>
                  <Icon name="stop" className="size-3" />
                  Abort
                </button>
                <button type="button" disabled={empty || disabled} onClick={() => void submit("followUp")} className={cx(ghost, "border border-zinc-700 text-zinc-200 hover:bg-zinc-800")}>
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
                "flex h-8 items-center justify-center gap-1.5 rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500",
                focus,
                busy ? "px-3 text-xs font-medium" : "w-8",
              )}
            >
              <Icon name="arrowUp" className="size-4" />
              {busy && "Steer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
