import { DiffStat, DiffView } from "../../primitives/DiffView";
import { diffStats, toolDiff } from "../../../../lib/diff";
import { tailClip } from "../../../../lib/format";
import type { ToolPart } from "../../../../types";
import { argNum, argStr, type ToolRenderer } from "../types";
import { ResultOutput } from "./generic";
import { Output } from "../../primitives/Output";

const pathOf = (t: ToolPart) => tailClip(argStr(t, "path") ?? "");

function DiffBody({ tool }: { tool: ToolPart }) {
  const d = toolDiff(tool);
  // A failed edit has no diff worth showing; the error text explains why.
  if (tool.status === "error" || !d || d.lines.length === 0) return <ResultOutput tool={tool} />;
  return <DiffView lines={d.lines} label={`${tool.name} diff`} />;
}

function diffStat(tool: ToolPart) {
  if (tool.status !== "done") return null;
  const d = toolDiff(tool);
  if (!d) return null;
  const { add, del } = diffStats(d.lines);
  return add + del > 0 ? <DiffStat add={add} del={del} /> : null;
}

export const editTool: ToolRenderer = { icon: "pencil", title: "Edit", detail: pathOf, stat: diffStat, Body: DiffBody };
export const writeTool: ToolRenderer = { icon: "filePlus", title: "Write", detail: pathOf, stat: diffStat, Body: DiffBody };

function ReadBody({ tool }: { tool: ToolPart }) {
  return tool.output ? <Output text={tool.output} label="read output" tone={tool.status === "error" ? "error" : "default"} /> : null;
}

export const readTool: ToolRenderer = {
  icon: "file",
  title: "Read",
  detail: (t) => {
    const offset = argNum(t, "offset");
    const limit = argNum(t, "limit");
    const range = offset || limit ? `:${offset ?? 1}${limit ? `–${(offset ?? 1) + limit - 1}` : ""}` : "";
    return pathOf(t) + range;
  },
  stat: (t) => (t.status === "done" && t.output ? <span className="text-zinc-600">{t.output.split("\n").length} lines</span> : null),
  Body: ReadBody,
};
