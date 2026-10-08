import { useState, type KeyboardEvent } from "react";

export type SendMode = "send" | "steer" | "followUp";

export interface ComposerProps {
  busy: boolean;
  disabled?: boolean;
  onSend: (text: string, mode: SendMode) => void | Promise<void>;
  onAbort: () => void | Promise<void>;
}

const btn =
  "rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-40";

export function Composer({ busy, disabled, onSend, onAbort }: ComposerProps) {
  const [text, setText] = useState("");
  const empty = text.trim().length === 0;

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
    <div className="border-t border-zinc-800 p-3">
      <label htmlFor="composer-input" className="sr-only">
        Message
      </label>
      <textarea
        id="composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        disabled={disabled}
        placeholder={busy ? "Bot is working — Enter to steer, or queue a follow-up" : "Message the bot (Enter to send, Shift+Enter for newline)"}
        className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:outline-2 focus-visible:outline-sky-400"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        {busy && (
          <>
            <button type="button" onClick={onAbort} className={`${btn} border border-red-700 text-red-300 hover:bg-red-950`}>
              Abort
            </button>
            <button type="button" disabled={empty || disabled} onClick={() => void submit("followUp")} className={`${btn} border border-zinc-600 text-zinc-200 hover:bg-zinc-800`}>
              Queue
            </button>
          </>
        )}
        <button
          type="button"
          disabled={empty || disabled}
          onClick={() => void submit(busy ? "steer" : "send")}
          className={`${btn} bg-sky-600 text-white hover:bg-sky-500`}
        >
          {busy ? "Steer" : "Send"}
        </button>
      </div>
    </div>
  );
}
