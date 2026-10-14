import type { ComponentType, ReactNode } from "react";
import type { ToolPart } from "../../../types";
import type { IconName } from "../primitives/Icon";

/**
 * How one tool (or family of tools) is presented in the feed.
 * The frame (`ToolCall`) owns the row, status, images, diagnostics and raw-args fallback;
 * a renderer only says what the row says and what the expanded body contains.
 */
export interface ToolRenderer {
  icon: IconName;
  /** Human verb shown first, e.g. "Shell". The raw tool name is kept as the row's tooltip. */
  title: string;
  /** One-line target after the title (command, path, query …). */
  detail?: (tool: ToolPart) => string;
  /** Compact stat on the right once the call has finished (e.g. diff counts, result count). */
  stat?: (tool: ToolPart) => ReactNode;
  /** Expanded content. Omit to fall back to the generic args + output body. */
  Body?: ComponentType<{ tool: ToolPart }>;
}

export function argStr(tool: ToolPart, key: string): string | undefined {
  const v = tool.args[key];
  return typeof v === "string" ? v : undefined;
}

export function argNum(tool: ToolPart, key: string): number | undefined {
  const v = tool.args[key];
  return typeof v === "number" ? v : undefined;
}
