import type { ToolPart } from "../../../../types";
import { argStr, type ToolRenderer } from "../types";
import { ResultOutput } from "./generic";

interface WebResult {
  title: string;
  url: string;
  date?: string;
  snippet?: string;
}

/** Parse the numbered list produced by the web_search tool; null when the text is not in that shape. */
export function parseSearchResults(text: string): WebResult[] | null {
  const results: WebResult[] = [];
  let cur: WebResult | undefined;
  for (const raw of text.split("\n")) {
    const head = /^\d+\.\s+(.*)$/.exec(raw);
    if (head && !raw.startsWith(" ")) {
      cur = { title: head[1], url: "" };
      results.push(cur);
      continue;
    }
    if (!cur) continue;
    const line = raw.trim();
    if (!line) continue;
    if (!cur.url && /^https?:\/\//.test(line)) cur.url = line;
    else if (line.startsWith("Published:")) cur.date = line.slice(10).trim();
    else cur.snippet = cur.snippet ? `${cur.snippet} ${line}` : line;
  }
  return results.length && results.every((r) => r.url) ? results : null;
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function WebSearchBody({ tool }: { tool: ToolPart }) {
  const results = tool.status === "error" ? null : parseSearchResults(tool.output);
  if (!results) return <ResultOutput tool={tool} />;
  return (
    <ol aria-label="Search results" className="divide-y divide-zinc-800/70 overflow-hidden rounded-lg border border-zinc-800 bg-black/30">
      {results.map((r, i) => (
        <li key={i}>
          <a href={r.url} target="_blank" rel="noreferrer noopener" className="block px-3 py-2 hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-400">
            <span className="block truncate text-[13px] text-zinc-200">{r.title}</span>
            <span className="block truncate font-mono text-[11px] text-zinc-500">
              {host(r.url)}
              {r.date ? ` · ${r.date.slice(0, 10)}` : ""}
            </span>
            {r.snippet && <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-400">{r.snippet}</span>}
          </a>
        </li>
      ))}
    </ol>
  );
}

export const webSearchTool: ToolRenderer = {
  icon: "globe",
  title: "Search web",
  detail: (t) => argStr(t, "query") ?? "",
  stat: (t) => {
    const n = t.status === "done" ? parseSearchResults(t.output)?.length : undefined;
    return n ? <span className="text-zinc-600">{n} results</span> : null;
  },
  Body: WebSearchBody,
};

export const searchHistoryTool: ToolRenderer = {
  icon: "history",
  title: "Search history",
  detail: (t) => argStr(t, "query") ?? "",
};
