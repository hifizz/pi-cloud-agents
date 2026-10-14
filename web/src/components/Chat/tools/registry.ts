// Tool renderer registry: tool name -> how it looks in the feed.
// Built-in tools live in ./builtin/*; custom extensions call `registerTool` (e.g. from a plugin module).
import { desktopTools } from "./builtin/desktop";
import { editTool, readTool, writeTool } from "./builtin/files";
import { genericTool } from "./builtin/generic";
import { bashTool } from "./builtin/shell";
import { searchHistoryTool, webSearchTool } from "./builtin/web";
import type { ToolRenderer } from "./types";

const registry = new Map<string, ToolRenderer>(
  Object.entries({
    bash: bashTool,
    read: readTool,
    write: writeTool,
    edit: editTool,
    web_search: webSearchTool,
    search_history: searchHistoryTool,
    ...desktopTools,
  }),
);

export function registerTool(name: string, renderer: ToolRenderer): void {
  registry.set(name, renderer);
}

/** Exact match, then the bare name of namespaced tools (`mcp__server__tool`, `server/tool`), then the generic fallback. */
export function resolveTool(name: string): ToolRenderer {
  const hit = registry.get(name);
  if (hit) return hit;
  const bare = /^(?:mcp__.+?__|.+\/)(.+)$/.exec(name)?.[1];
  return (bare && registry.get(bare)) || { ...genericTool, title: name.replace(/^mcp__/, "").replace(/__/g, "/") };
}
