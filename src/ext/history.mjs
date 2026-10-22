// search_history: case-insensitive substring search over a conversation's whole stored history, including entries
// before a reset or compaction that no longer appear in the model context (REQ-F09-2).
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const PAGE = 200;
const SNIPPET_RADIUS = 120;
const MAX_SCANNED = 100_000;

const SELF = "search_history";

/**
 * Readable text of one entry: its model messages (text blocks, tool calls) or string data. search_history's own calls
 * and results are skipped, otherwise every search would match itself and earlier searches.
 */
export function entryText(entry) {
  const parts = [];
  for (const m of entry.model ?? []) {
    if (m.role === "toolResult" && m.toolName === SELF) continue;
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c.type === "toolCall" && c.name !== SELF) parts.push(`${c.name}(${JSON.stringify(c.arguments ?? {})})`);
      }
    }
  }
  if (parts.length === 0 && typeof entry.data === "string") parts.push(entry.data);
  return parts.join("\n");
}

function roleOf(entry) {
  return entry.model?.[0]?.role ?? entry.kind;
}

function snippetAround(text, index, queryLength) {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + queryLength + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/**
 * Search every stored entry of a conversation, newest first.
 * @param {(limit: number, cursor: any) => Promise<{items: readonly any[], next?: any}>} scan
 */
export async function searchEntries(scan, query, limit = DEFAULT_LIMIT) {
  const needle = query.toLowerCase();
  const cap = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
  const matches = [];
  let cursor;
  let scanned = 0;
  do {
    const page = await scan(PAGE, cursor);
    for (const entry of page.items) {
      scanned++;
      const text = entryText(entry);
      const idx = text.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      matches.push({ entryId: entry.id, kind: entry.kind, role: roleOf(entry), snippet: snippetAround(text, idx, needle.length) });
      if (matches.length >= cap) return { matches, scanned, truncated: true };
    }
    cursor = page.next;
  } while (cursor && scanned < MAX_SCANNED);
  return { matches, scanned, truncated: false };
}

export const searchHistory = defineTool({
  name: "search_history",
  description:
    "Search this conversation's full stored history (case-insensitive substring), including messages from before a " +
    "reset or compaction that are no longer in your context. Returns matching snippets, newest first.",
  parameters: Type.Object({
    query: Type.String({ minLength: 1, description: "Text to look for" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Max matches (default ${DEFAULT_LIMIT})` })),
  }),
  replay: "safe",
  async execute(args, api, context) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query must not be empty");
    const { matches, scanned, truncated } = await searchEntries(
      (limit, cursor) => api.commit((tx) => tx.scanEntries({ conversationId: api.conversationId }, limit, cursor), context),
      query,
      args.limit ?? DEFAULT_LIMIT,
    );
    if (matches.length === 0) {
      return { output: [{ type: "text", text: `No matches for "${query}" in ${scanned} history entries.` }], details: { matches: [] } };
    }
    const text = matches.map((m, i) => `${i + 1}. [${m.role}] (entry ${m.entryId}) ${m.snippet}`).join("\n");
    const note = truncated ? `\n(showing first ${matches.length} matches; raise limit for more)` : "";
    return { output: [{ type: "text", text: text + note }], details: { matches } };
  },
});

export const History = defineExtension({ name: "tarsbot.history", tools: [searchHistory] });
