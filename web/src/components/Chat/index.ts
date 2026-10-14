// Public surface of the chat component library.
//   primitives/  generic building blocks (no knowledge of messages or tools)
//   parts/       one component per kind of message part / feed row
//   tools/       tool-call frame + per-tool renderers (register new ones in tools/registry.ts)
export { MessageList } from "./MessageList";
export { Composer, type ComposerProps, type SendMode } from "./Composer";
export { FeedRowView, type FeedRowHandlers } from "./FeedRow";
export { ToolCall } from "./tools/ToolCall";
export { registerTool, resolveTool } from "./tools/registry";
export type { ToolRenderer } from "./tools/types";
export { ActivityRow } from "./primitives/ActivityRow";
export { DiffView, DiffStat } from "./primitives/DiffView";
export { Markdown } from "./primitives/Markdown";
export { Output } from "./primitives/Output";
export { ImageStrip } from "./primitives/Images";
export { Icon, type IconName } from "./primitives/Icon";
export { Collapse } from "./primitives/Collapse";
