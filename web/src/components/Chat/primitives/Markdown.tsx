import { Children, isValidElement, memo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon";

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

function CodeFence({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = Children.toArray(children)[0];
  const lang = isValidElement(code) ? /language-(\S+)/.exec(String((code as ReactElement<{ className?: string }>).props.className ?? ""))?.[1] : undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable (insecure context) */
    }
  };
  return (
    <div className="group/code relative my-3">
      <pre>{children}</pre>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
        {lang && <span className="font-mono">{lang}</span>}
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy code"
          className="rounded p-1 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-sky-400 group-hover/code:opacity-100"
        >
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </div>
    </div>
  );
}

/** Assistant/user markdown (GFM). Styling lives in index.css under `.md`. */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className={streaming ? "md md-streaming" : "md"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeFence,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
