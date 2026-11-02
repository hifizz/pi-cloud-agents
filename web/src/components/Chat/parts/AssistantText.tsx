import { Message, MessageContent } from "@/components/ai-elements/message";
import { Markdown } from "../primitives/Markdown";

export function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Message from="assistant">
      <MessageContent data-role="assistant" className="text-[15px] leading-[1.62]">
        <Markdown text={text} streaming={streaming} />
      </MessageContent>
    </Message>
  );
}
