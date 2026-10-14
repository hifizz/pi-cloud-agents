import { Output } from "../../primitives/Output";
import { summarizeArgs } from "../../../../lib/format";
import type { ToolPart } from "../../../../types";
import type { ToolRenderer } from "../types";

export function prettyArgs(tool: ToolPart): string {
  try {
    return JSON.stringify(tool.args, null, 2);
  } catch {
    return "";
  }
}

/** Result text of a tool as an output panel (red when the call failed). */
export function ResultOutput({ tool }: { tool: ToolPart }) {
  if (!tool.output) return null;
  return <Output text={tool.output} label={`${tool.name} output`} tone={tool.status === "error" ? "error" : "default"} />;
}

function GenericBody({ tool }: { tool: ToolPart }) {
  const args = Object.keys(tool.args).length ? prettyArgs(tool) : "";
  return (
    <>
      {args && <Output text={args} label={`${tool.name} arguments`} />}
      <ResultOutput tool={tool} />
    </>
  );
}

/** Fallback for any tool without a dedicated renderer (custom extensions, MCP, future tools). */
export const genericTool: ToolRenderer = {
  icon: "wrench",
  title: "Tool",
  detail: (t) => summarizeArgs(t.args, 70),
  Body: GenericBody,
};
