import type { Usage } from "../types";

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function usageLabel(u: Usage): string {
  return `${formatTokens(u.totalTokens)} tok · ${formatCost(u.cost)}`;
}

/** One-line summary of tool arguments for the card header. */
export function summarizeArgs(args: Record<string, unknown>, max = 90): string {
  const keys = Object.keys(args ?? {});
  if (keys.length === 0) return "";
  const preferred = ["command", "cmd", "path", "query", "url", "text", "name"].find((k) => typeof args[k] === "string");
  let s: string;
  if (preferred) s = String(args[preferred]);
  else {
    try {
      s = JSON.stringify(args);
    } catch {
      s = "";
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function splitLines(text: string, maxLines: number): { shown: string; total: number; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { shown: text, total: lines.length, truncated: false };
  return { shown: lines.slice(0, maxLines).join("\n"), total: lines.length, truncated: true };
}

/** "42s" / "3m 07s" */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function firstLine(s: string): string {
  const [line = "", ...rest] = s.split("\n");
  return rest.length ? `${line} …` : line;
}

/** Keep the END of long strings (file names matter more than directories). */
export function tailClip(s: string, max = 64): string {
  return s.length > max ? `…${s.slice(s.length - max + 1)}` : s;
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
