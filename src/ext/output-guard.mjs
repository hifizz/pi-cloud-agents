// Tool output truncation (idea 2): an afterTool hook that caps the text the model sees from ANY tool result, with an
// explicit truncation marker telling the model to narrow the next call. The built-in tools already bound their own
// output (bash keeps the tail, read truncates by lines/bytes); this is the last-resort cap for everything else, so a
// runaway search / webhook payload / future tool cannot flood the context window.
//
// `output` is replaced only when it changed, and by reference-equality discipline: a plain string content array is
// swapped for the shortened one. Diagnostics note the truncation for the UI.
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

/** Characters per tool result the model sees (bdots uses 12000). */
export const DEFAULT_MAX_CHARS = 12000;

const MARKER = "\n…[output truncated: {total} chars total, first {kept} shown — narrow the scope (head/tail/grep, smaller range) and re-run if you need more]";

/** Truncate a single text string to `maxChars` with a marker; returns null when unchanged. */
export function truncateText(text, maxChars = DEFAULT_MAX_CHARS) {
  const t = String(text ?? "");
  if (t.length <= maxChars) return null;
  const marker = MARKER.replace("{total}", String(t.length)).replace("{kept}", String(maxChars));
  return `${t.slice(0, maxChars)}${marker}`;
}

/** Map over a tool result's output content, truncating every text block. Returns a new result, or null when unchanged. */
export function truncateResultOutput(result, maxChars = DEFAULT_MAX_CHARS) {
  const content = result?.output;
  if (!Array.isArray(content)) return null;
  let changed = false;
  const next = content.map((part) => {
    if (part?.type !== "text") return part;
    const t = truncateText(part.text, maxChars);
    if (t === null) return part;
    changed = true;
    return { ...part, text: t };
  });
  if (!changed) return null;
  return { ...result, output: next };
}

/**
 * @param {{ maxChars?: number, toolNames?: string[] }} [opts] toolNames: restrict to these tools (default: all)
 */
export function createOutputGuard(opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const only = opts.toolNames ? new Set(opts.toolNames) : undefined;
  return defineExtension({
    name: "tarsbot.outputGuard",
    hooks: [
      hook(ToolTask, {
        afterTool: async (call, result, _api, _context) => {
          if (only && !only.has(call?.name)) return undefined;
          const shortened = truncateResultOutput(result, maxChars);
          if (!shortened) return undefined;
          const diagnostics = [
            ...(shortened.diagnostics ?? []),
            { severity: "warn", message: `output truncated to ${maxChars} characters`, code: "tarsbot.truncated" },
          ];
          return { ...shortened, diagnostics };
        },
      }),
    ],
  });
}

export const OutputGuard = createOutputGuard();
