import { firstLine } from "../../../../lib/format";
import type { ToolPart } from "../../../../types";
import { Output } from "../../primitives/Output";
import { argStr, type ToolRenderer } from "../types";

const LONG = 80;

/** The row already shows the command's first line; only repeat it in the body when it would be cut off. */
function ShellBody({ tool }: { tool: ToolPart }) {
  const cmd = argStr(tool, "command") ?? "";
  const header = cmd.includes("\n") || cmd.length > LONG ? cmd : undefined;
  if (!header && !tool.output) return null;
  return <Output header={header} text={tool.output} label={`${tool.name} output`} tone={tool.status === "error" ? "error" : "default"} />;
}

export const bashTool: ToolRenderer = {
  icon: "terminal",
  title: "Shell",
  detail: (t) => firstLine(argStr(t, "command") ?? ""),
  Body: ShellBody,
};
