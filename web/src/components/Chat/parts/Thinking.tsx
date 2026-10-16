import { useState } from "react";
import { ActivityRow } from "../primitives/ActivityRow";
import { Spinner } from "../primitives/Spinner";

export function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <ActivityRow
      icon="bulb"
      title={streaming ? "Thinking…" : "Thought"}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      expandable={text.trim().length > 0}
      trailing={streaming ? <Spinner /> : undefined}
    >
      <div className="whitespace-pre-wrap text-[13.5px] italic leading-relaxed text-fg-muted">{text}</div>
    </ActivityRow>
  );
}
