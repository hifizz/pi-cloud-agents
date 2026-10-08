// Test helpers: load recorded frames and build a protocol-level snapshot at any frame boundary,
// WITHOUT using the reducer (so late-join tests compare two independent code paths).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Frame, SnapshotFrame } from "../src/lib/reducer";

const here = dirname(fileURLToPath(import.meta.url));

export function loadFixture(name: string): Frame[] {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8")) as Frame[];
}

export const FIXTURES = ["run-basic", "run-tool", "run-abort", "run-real"];

/* eslint-disable @typescript-eslint/no-explicit-any */
export function snapshotAfter(frames: Frame[], count: number): SnapshotFrame {
  const first = frames[0] as any;
  const entries: any[] = [...(first.entries ?? [])];
  let run: any;
  let partial: any;
  let tools: any[] = [...(first.tools ?? [])];
  let inbox: any[] = first.inbox ?? [];
  let agent: any = first.agent ?? {};
  let usage: any = first.usage ?? { models: {}, tools: {} };
  const addEntry = (e: any) => {
    if (!entries.some((x) => x.id === e.id)) entries.push(e);
  };

  for (const frame of frames.slice(1, 1 + count) as any[]) {
    for (const ev of frame.events) {
      switch (ev.type) {
        case "run_start":
          run = { inputs: ev.inputs };
          break;
        case "run_end":
          run = undefined;
          partial = undefined;
          tools = [];
          break;
        case "turn_end":
          tools = [];
          break;
        case "message_start":
          if (ev.message.role === "assistant") partial = JSON.parse(JSON.stringify(ev.message));
          break;
        case "message_update":
          for (const c of ev.changes) {
            if (!partial) break;
            if (c.type === "text_delta") partial.content[c.contentIndex].text += c.delta;
            else if (c.type === "thinking_delta") partial.content[c.contentIndex].thinking += c.delta;
            else if (c.type === "text_start" || c.type === "thinking_start" || c.type === "toolcall_start") partial.content.splice(c.contentIndex, 0, c.block);
            else throw new Error(`helper does not support change ${c.type}`);
          }
          break;
        case "message_end":
        case "entry_appended":
          addEntry(ev.entry);
          if (ev.entry.kind === "pi.assistant") partial = undefined;
          break;
        case "tool_execution_start":
          tools.push({ callId: ev.toolCallId, name: ev.toolName, status: "running", output: "" });
          break;
        case "tool_execution_update": {
          const slot = tools.find((t) => t.callId === ev.toolCallId);
          if (slot && ev.output?.set !== undefined) slot.output = ev.output.set;
          break;
        }
        case "tool_execution_end": {
          const slot = tools.find((t) => t.callId === ev.toolCallId);
          if (slot) {
            slot.status = "done";
            if (ev.entry) {
              slot.entry = ev.entry.id;
              addEntry(ev.entry);
            }
          }
          break;
        }
        case "inbox_update":
          inbox = ev.items;
          break;
        case "agent_changed":
          agent = ev.agent;
          break;
        case "usage_changed":
          usage = ev.usage;
          break;
      }
    }
  }
  return {
    type: "snapshot",
    entries,
    ...(run ? { run } : {}),
    ...(partial ? { generation: { attempt: 0, message: partial } } : {}),
    tools,
    compactions: [],
    inbox,
    agent,
    usage,
  };
}
