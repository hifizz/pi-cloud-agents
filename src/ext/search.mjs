// Web search tool backed by the Exa Search API (POST https://api.exa.ai/search, header x-api-key).
// The API key is read from the host process environment only and never appears in output or errors.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const EXA_URL = "https://api.exa.ai/search";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const MAX_CHARACTERS = 1500; // requested from Exa per result
const SNIPPET_CHARS = 500; // shown to the model per result
const ERROR_BODY_CHARS = 200;

function clampNumResults(n) {
  const v = Number.isFinite(n) ? Math.trunc(n) : DEFAULT_NUM_RESULTS;
  return Math.min(MAX_NUM_RESULTS, Math.max(1, v));
}

function redact(text, key) {
  let out = String(text ?? "");
  if (key) out = out.split(key).join("[redacted]");
  return out;
}

function snippet(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
}

export function createWebSearchTool({ fetch: fetchImpl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return defineTool({
    name: "web_search",
    description:
      "Search the web (Exa) and return a numbered list of results with title, URL, publish date and a text excerpt. " +
      "Use for current information, documentation and facts you are unsure about.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      numResults: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_NUM_RESULTS, description: `Number of results (1-${MAX_NUM_RESULTS}, default ${DEFAULT_NUM_RESULTS})` }),
      ),
      includeText: Type.Optional(Type.Boolean({ description: "Include page text excerpts (default true)" })),
    }),
    replay: "safe",
    async execute(args) {
      // Resolve lazily so tests/production can set env or fetch after import.
      const key = apiKey ?? process.env.EXA_API_KEY;
      if (!key) throw new Error("EXA_API_KEY is not set");
      const doFetch = fetchImpl ?? globalThis.fetch;

      const numResults = clampNumResults(args.numResults ?? DEFAULT_NUM_RESULTS);
      const includeText = args.includeText ?? true;
      const body = { query: args.query, numResults, type: "auto" };
      if (includeText) body.contents = { text: { maxCharacters: MAX_CHARACTERS } };

      let res;
      try {
        res = await doFetch(EXA_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error("web_search timed out");
        throw new Error(`web_search request failed: ${redact(e?.message ?? e, key)}`);
      }

      if (!res.ok) {
        let text = "";
        try {
          text = await res.text();
        } catch {}
        const short = redact(text, key).replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_CHARS);
        throw new Error(`web_search failed: HTTP ${res.status}${short ? ` ${short}` : ""}`);
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error("web_search failed: invalid JSON response");
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      const details = results.map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        publishedDate: r.publishedDate ?? null,
      }));

      let text;
      if (results.length === 0) {
        text = `No results for: ${args.query}`;
      } else {
        text = results
          .map((r, i) => {
            const lines = [`${i + 1}. ${r.title || "(untitled)"}`, `   ${r.url}`];
            if (r.publishedDate) lines.push(`   Published: ${r.publishedDate}`);
            const s = includeText ? snippet(r.text) : "";
            if (s) lines.push(`   ${s}`);
            return lines.join("\n");
          })
          .join("\n\n");
      }
      return { output: [{ type: "text", text }], details };
    },
  });
}

export const webSearch = createWebSearchTool();

export const Search = defineExtension({ name: "tarsbot.search", tools: [webSearch] });
