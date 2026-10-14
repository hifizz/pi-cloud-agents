// Diff helpers shared by the edit/write tool renderers and the per-turn "files changed" card.
import type { ToolPart } from "../types";

export type DiffKind = "add" | "del" | "ctx" | "gap";
export interface DiffLine {
  kind: DiffKind;
  num?: number;
  text: string;
}

/** Parse the edit tool's `details.diff` ("+12 text" / "-12 text" / " 12 text" / "    ..."). */
export function parsePiDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const raw of diff.split("\n")) {
    const marker = raw[0];
    if (marker !== "+" && marker !== "-" && marker !== " ") continue;
    const m = /^\s*(\d+)? ?(.*)$/.exec(raw.slice(1));
    if (!m) continue;
    const num = m[1] ? Number(m[1]) : undefined;
    if (num === undefined && m[2].trim() === "...") {
      out.push({ kind: "gap", text: "…" });
      continue;
    }
    out.push({ kind: marker === "+" ? "add" : marker === "-" ? "del" : "ctx", num, text: m[2] });
  }
  return out;
}

/** Preview diff from the edit tool's arguments (before/while the result is in). */
export function diffFromEdits(edits: unknown): DiffLine[] {
  const out: DiffLine[] = [];
  if (!Array.isArray(edits)) return out;
  edits.forEach((e, i) => {
    if (!e || typeof e !== "object") return;
    const { oldText, newText } = e as { oldText?: unknown; newText?: unknown };
    if (i > 0) out.push({ kind: "gap", text: "…" });
    if (typeof oldText === "string" && oldText) for (const text of oldText.split("\n")) out.push({ kind: "del", text });
    if (typeof newText === "string" && newText) for (const text of newText.split("\n")) out.push({ kind: "add", text });
  });
  return out;
}

/** A newly written file is all additions. */
export function diffFromContent(content: string): DiffLine[] {
  if (!content) return [];
  const lines = content.replace(/\n$/, "").split("\n");
  return lines.map((text, i) => ({ kind: "add", num: i + 1, text }));
}

export function diffStats(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}

export function isFileMutation(tool: ToolPart): boolean {
  return tool.name === "edit" || tool.name === "write";
}

/** Diff of one edit/write tool call, or undefined for any other tool. */
export function toolDiff(tool: ToolPart): { path: string; lines: DiffLine[] } | undefined {
  if (!isFileMutation(tool)) return undefined;
  const path = typeof tool.args.path === "string" ? tool.args.path : undefined;
  if (!path) return undefined;
  if (tool.name === "write") return { path, lines: diffFromContent(typeof tool.args.content === "string" ? tool.args.content : "") };
  const d = tool.details as { diff?: unknown } | undefined;
  const lines = typeof d?.diff === "string" ? parsePiDiff(d.diff) : diffFromEdits(tool.args.edits);
  return { path, lines };
}
