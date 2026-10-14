import { useState } from "react";
import type { ToolPart, ToolStatus } from "../../../types";
import { ActivityRow } from "../primitives/ActivityRow";
import { Icon } from "../primitives/Icon";
import { ImageStrip } from "../primitives/Images";
import { Spinner } from "../primitives/Spinner";
import { resolveTool } from "./registry";

const TONE: Record<ToolStatus, "default" | "running" | "error" | "warn"> = { running: "running", done: "default", error: "error", interrupted: "warn" };

function StatusLabel({ status }: { status: ToolStatus }) {
  switch (status) {
    case "running":
      return (
        <span className="flex items-center gap-1.5 text-amber-400">
          <Spinner />
          running
        </span>
      );
    case "error":
      return (
        <span className="flex items-center gap-1 text-red-400">
          <Icon name="alert" className="size-3" />
          failed
        </span>
      );
    case "interrupted":
      return <span className="text-amber-500">interrupted</span>;
    case "done":
      return <span className="sr-only">done</span>;
  }
}

/** The frame around every tool call: one row, status, expandable body, images, diagnostics, raw arguments. */
export function ToolCall({ tool }: { tool: ToolPart }) {
  const [open, setOpen] = useState(false);
  const r = resolveTool(tool.name);
  const Body = r.Body;
  const images = tool.images ?? [];
  // Diagnostics that merely repeat the status label or the output are noise.
  const notes = tool.status === "interrupted" ? [] : (tool.diagnostics ?? []).filter((d) => !tool.output.includes(d));
  const expandable = !!Body || !!tool.output || images.length > 0 || notes.length > 0;

  return (
    <ActivityRow
      testId="tool-card"
      icon={r.icon}
      title={r.title}
      titleAttr={tool.name}
      detail={r.detail?.(tool)}
      tone={TONE[tool.status]}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      expandable={expandable}
      preview={images.length > 0 ? <ImageStrip images={images} /> : undefined}
      trailing={
        <>
          {tool.status === "done" && r.stat?.(tool)}
          <StatusLabel status={tool.status} />
        </>
      }
    >
      {/* Collapse mounts this only while open / closing, so <Body> never runs for collapsed rows. */}
      <>
        {Body ? <Body tool={tool} /> : null}
        {notes.map((d, i) => (
          <p key={i} className="text-xs text-amber-400">
            {d}
          </p>
        ))}
        {images.length > 0 && <ImageStrip images={images} size="lg" />}
      </>
    </ActivityRow>
  );
}
