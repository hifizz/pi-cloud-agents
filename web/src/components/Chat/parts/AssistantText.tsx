import { Markdown } from "../primitives/Markdown";

export function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div data-role="assistant" className="text-[15px] leading-relaxed text-zinc-200">
      <Markdown text={text} streaming={streaming} />
    </div>
  );
}
