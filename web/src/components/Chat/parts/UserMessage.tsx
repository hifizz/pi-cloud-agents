import type { ChatMessage } from "../../../types";
import { ImageStrip } from "../primitives/Images";
import { Markdown } from "../primitives/Markdown";

export function UserMessage({ message }: { message: ChatMessage }) {
  const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
  const images = message.parts.flatMap((p) => (p.type === "image" ? [p] : []));
  return (
    <div data-role="user" className="w-fit max-w-[85%] rounded-xl border border-[#1d1d1d] bg-raised px-3.5 py-3 text-[14.5px] text-fg">
      {text && <Markdown text={text} />}
      {images.length > 0 && (
        <div className={text ? "mt-2" : ""}>
          <ImageStrip images={images} alt="Attached image" />
        </div>
      )}
    </div>
  );
}
