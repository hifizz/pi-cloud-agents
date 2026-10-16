import { Markdown } from "../primitives/Markdown";

export function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div data-role="assistant" className="text-[15px] leading-[1.62] text-[#e4e4e4]">
      <Markdown text={text} streaming={streaming} />
    </div>
  );
}
