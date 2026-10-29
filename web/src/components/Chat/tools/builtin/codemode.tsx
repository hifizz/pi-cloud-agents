import { clip, formatDuration, lastLine, summarizeArgs } from "../../../../lib/format";
import type { NestedToolCall, ToolPart } from "../../../../types";
import { Icon } from "../../primitives/Icon";
import { Output } from "../../primitives/Output";
import { Spinner } from "../../primitives/Spinner";
import { argStr, type ToolRenderer } from "../types";
import { ResultOutput } from "./generic";

// The codemode tool's result details (pi-durable CodemodeToolDetails): the calls the script made, once it settled.
interface DetailsCall {
  id: number;
  name: string;
  /** Compact JSON of the arguments, already cut for display. */
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
}
interface CodemodeDetails {
  calls?: DetailsCall[];
  /** Temp file on the workspace machine (the ExecutionEnv) with the complete text output. */
  fullOutputPath?: string;
}

const detailsOf = (tool: ToolPart): CodemodeDetails => (tool.details ?? {}) as CodemodeDetails;

// One row of the call list: the final list (details.calls) and the live one (tool.nested) share it.
interface Row {
  key: string;
  name: string;
  argsText: string;
  status: "running" | "ok" | "error" | "cancelled" | "done" | "interrupted";
  durationMs?: number;
  error?: string;
  output?: string;
}

function rowsOf(tool: ToolPart): Row[] {
  const final = detailsOf(tool).calls;
  if (Array.isArray(final)) {
    return final.map((c) => ({
      key: `c${c.id}`,
      name: c.name,
      argsText: c.args,
      status: c.status,
      durationMs: c.durationMs,
      error: c.error,
    }));
  }
  return (tool.nested ?? []).map((n: NestedToolCall) => ({
    key: n.id,
    name: n.name,
    argsText: summarizeArgs(n.args, 120),
    status: n.status,
    durationMs: n.durationMs,
    error: n.error,
    output: n.output,
  }));
}

function Status({ status }: { status: Row["status"] }) {
  switch (status) {
    case "running":
      return (
        <span className="flex items-center gap-1 text-warn">
          <Spinner />
        </span>
      );
    case "ok":
    case "done":
      return <Icon name="check" className="size-3 text-ok" />;
    case "error":
      return <Icon name="alert" className="size-3 text-bad" />;
    case "cancelled":
    case "interrupted":
      return <span className="text-[10px] text-warn">interrupted</span>;
  }
}

/** The calls a codemode script made (or is making), in call order. */
function NestedList({ tool }: { tool: ToolPart }) {
  const rows = rowsOf(tool);
  if (rows.length === 0) return null;
  return (
    <ol className="space-y-0.5 rounded-lg border border-[#1d1d1d] bg-[#0b0b0b] px-3 py-2" aria-label="script tool calls">
      {rows.map((r) => (
        <li key={r.key} data-testid="nested-call" className="text-[11.8px] leading-[1.65]">
          <div className="flex items-center gap-2">
            <Status status={r.status} />
            <span className="shrink-0 font-mono text-fg">{r.name}</span>
            {r.argsText && <span className="min-w-0 truncate font-mono text-fg-muted">{r.argsText}</span>}
            {r.durationMs !== undefined && (
              <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-fg-faint">{formatDuration(r.durationMs)}</span>
            )}
          </div>
          {r.error && <p className="mt-0.5 whitespace-pre-wrap break-words pl-5 font-mono text-bad">{r.error}</p>}
          {r.status === "running" && r.output && (
            <p className="mt-0.5 truncate pl-5 font-mono text-fg-faint">{lastLine(r.output)}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

function CodemodeBody({ tool }: { tool: ToolPart }) {
  const code = argStr(tool, "code");
  const details = detailsOf(tool);
  return (
    <>
      {code && <Output text={code} label="codemode script" />}
      <NestedList tool={tool} />
      {details.fullOutputPath && (
        <p className="text-xs text-fg-muted">
          Full output saved on the workspace machine: <code className="font-mono">{details.fullOutputPath}</code>
        </p>
      )}
      <ResultOutput tool={tool} />
    </>
  );
}

/** First code line that is not the `// @options:` header, for the collapsed row. */
function scriptLine(code: string | undefined): string {
  const line = (code ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("// @options") && !l.startsWith("//"));
  return line ? clip(line, 80) : "";
}

export const codemodeTool: ToolRenderer = {
  icon: "play",
  title: "Script",
  detail: (t) => scriptLine(argStr(t, "code")),
  stat: (t) => {
    const n = detailsOf(t).calls?.length ?? t.nested?.length;
    return n ? `${n} call${n === 1 ? "" : "s"}` : null;
  },
  Body: CodemodeBody,
};
