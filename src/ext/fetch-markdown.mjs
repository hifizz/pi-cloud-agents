// fetch_markdown (idea 16, the "read a page without a browser" half): fetch an https URL from the SERVER (not the
// sandbox; the sandbox network may differ, and this keeps it off the approval surface), strip it to readable text,
// cap the size. A real browser remains future work (tars desktop migration); this covers docs / PR / API reading.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const MAX_BODY_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 20000;

/** Very small HTML -> text: drop script/style, tags, collapse whitespace. Good enough for docs pages. */
export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** @param {{ fetch?: typeof fetch, timeoutMs?: number, maxChars?: number }} [opts] */
export function createFetchMarkdown(opts = {}) {
  const doFetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? MAX_BODY_CHARS;

  return defineExtension({
    name: "tarsbot.fetchMarkdown",
    tools: [
      defineTool({
        name: "fetch_markdown",
        description:
          "Fetch an http(s) URL and return its readable text (HTML stripped to text). For documentation, PRs, APIs and " +
          "raw files. Cannot run the page's JavaScript; for that, use the sandbox (curl) or ask the user.",
        parameters: Type.Object({
          url: Type.String({ description: "Absolute http(s) URL" }),
        }),
        replay: "safe",
        async execute(args) {
          let u;
          try {
            u = new URL(String(args.url));
          } catch {
            return { output: [{ type: "text", text: `invalid URL: ${args.url}` }], isError: true };
          }
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            return { output: [{ type: "text", text: `unsupported protocol: ${u.protocol}` }], isError: true };
          }
          let res;
          try {
            res = await doFetch(u, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
          } catch (e) {
            if (e?.name === "TimeoutError" || e?.name === "AbortError") return { output: [{ type: "text", text: `fetch timed out after ${timeoutMs}ms` }], isError: true };
            return { output: [{ type: "text", text: `fetch failed: ${e?.message ?? e}` }], isError: true };
          }
          const type = res.headers.get("content-type") ?? "";
          let body = "";
          try {
            body = await res.text();
          } catch (e) {
            return { output: [{ type: "text", text: `read failed: ${e?.message ?? e}` }], isError: true };
          }
          const text = type.includes("html") ? htmlToText(body) : body;
          const out = text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} chars; fetch a narrower URL or use curl in the sandbox for more]` : text;
          return { output: [{ type: "text", text: `# ${res.status} ${u}\n\n${out || "(empty body)"}` }], isError: !res.ok };
        },
      }),
    ],
  });
}

export const FetchMarkdown = createFetchMarkdown();
