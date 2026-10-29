import { describe, expect, it } from "vitest";
import { emptyVM, reduce, type Frame } from "../src/lib/reducer";
import type { ChatMessage, ConversationVM, ToolPart } from "../src/types";
import { FIXTURES, loadFixture, snapshotAfter } from "./helpers";
import { formatDuration } from "../src/lib/format";

const replay = (frames: Frame[], from = emptyVM()) => frames.reduce(reduce, from);
const toolsOf = (vm: ConversationVM): ToolPart[] =>
  vm.messages.flatMap((m) => m.parts.filter((p): p is ToolPart => p.type === "tool"));
const textOf = (m: ChatMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("reducer: recorded fixtures", () => {
  it("run-basic: text/thinking deltas concatenate, tool runs to completion", () => {
    const vm = replay(loadFixture("run-basic"));
    expect(vm.busy).toBe(false);
    expect(vm.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(vm.messages.every((m) => !m.pending)).toBe(true);

    const [user, first, second] = vm.messages;
    expect(textOf(user)).toBe("List the files in the current directory and tell me what you see.");
    expect(first.parts.map((p) => p.type)).toEqual(["thinking", "text", "tool"]);
    expect(first.parts[0]).toEqual({ type: "thinking", text: "The user wants a directory listing. I should run ls." });
    expect(first.parts[1]).toEqual({ type: "text", text: "Let me look at the directory." });
    const tool = first.parts[2] as ToolPart;
    expect(tool).toMatchObject({
      id: "call-1",
      name: "bash",
      status: "done",
      args: { command: "echo hello > notes.txt && ls" },
      output: "notes.txt\n",
      resultText: "notes.txt\n",
    });
    expect(second.parts).toEqual([
      { type: "thinking", text: "One file, notes.txt." },
      { type: "text", text: "The directory contains a single file: notes.txt." },
    ]);
    expect(vm.usage.totalTokens).toBe(2500);
    expect(vm.agent).toMatchObject({ provider: "faux", modelId: "faux-1" });
    expect(vm.toolStash).toEqual({});
  });

  it("streams incrementally: partial message is pending until message_end", () => {
    const frames = loadFixture("run-basic");
    // snapshot + frames up to the first text_delta of the first assistant message
    let vm = replay(frames.slice(0, 7));
    const pending = vm.messages.find((m) => m.pending)!;
    expect(pending.role).toBe("assistant");
    const thinking = pending.parts[0];
    expect(thinking).toMatchObject({ type: "thinking" });
    expect((thinking as { text: string }).text).toBe("The user wants a directory listing. I should run ls.");
    expect(pending.parts[1]).toEqual({ type: "text", text: "Let me look at the direc" });
    vm = replay(frames.slice(7, 9), vm);
    const done = vm.messages.find((m) => m.role === "assistant")!;
    expect(done.pending).toBeUndefined();
    expect(done.id).toBe("e12");
  });

  it("tool start -> running with live output -> end (failing command => error)", () => {
    const frames = loadFixture("run-tool");
    const startIdx = frames.findIndex((f) => f.type === "events" && f.events.some((e) => e.type === "tool_execution_start"));
    let vm = replay(frames.slice(0, startIdx + 1));
    expect(toolsOf(vm)[0].status).toBe("running");
    vm = reduce(vm, frames[startIdx + 1]);
    expect(toolsOf(vm)[0].output).not.toBe("");
    vm = replay(frames.slice(startIdx + 2), vm);
    expect(toolsOf(vm)[0]).toMatchObject({ status: "error", resultText: "partial output\noops\n", diagnostics: ["Command exited with code 3"] });
    expect(vm.busy).toBe(false);
  });

  it("run-abort: aborted tool is interrupted and keeps partial output", () => {
    const vm = replay(loadFixture("run-abort"));
    const [tool] = toolsOf(vm);
    expect(tool.status).toBe("interrupted");
    expect(tool.output).toBe("started\n");
    expect(tool.diagnostics).toEqual(["Tool bash was aborted"]);
    expect(vm.busy).toBe(false);
  });

  it("run-real: thinking + answer from a real provider", () => {
    const vm = replay(loadFixture("run-real"));
    const assistant = vm.messages.find((m) => m.role === "assistant")!;
    expect(assistant.parts).toEqual([
      { type: "thinking", text: "The user is asking a simple math question: 1+1. No tools needed. Answer in one short sentence." },
      { type: "text", text: "1+1 equals 2." },
    ]);
    expect(vm.usage.cost).toBeCloseTo(0.000084, 9);
    expect(vm.agent).toMatchObject({ provider: "tokenrouter", modelId: "glm-5.3" });
  });

  it("system (pi.system) entries are not shown", () => {
    const vm = replay(loadFixture("run-real"));
    expect(vm.messages.some((m) => m.role === "system")).toBe(false);
  });
});

describe("reducer: tool edge cases", () => {
  const base = (): ConversationVM =>
    replay([
      { type: "snapshot", entries: [], tools: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } },
      {
        type: "events",
        events: [
          { type: "run_start", inputs: [1] },
          {
            type: "message_end",
            entry: {
              id: 2,
              kind: "pi.assistant",
              model: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 9" } }] }],
            },
          },
          { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 9" } },
        ],
      },
    ]);

  it("tool_execution_end without entry -> interrupted", () => {
    const vm = reduce(base(), { type: "events", events: [{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" }] });
    expect(toolsOf(vm)[0].status).toBe("interrupted");
  });

  it("run_end with a still-running tool -> interrupted, not busy", () => {
    const vm = reduce(base(), { type: "events", events: [{ type: "run_end", inputs: [1] }] });
    expect(toolsOf(vm)[0].status).toBe("interrupted");
    expect(vm.busy).toBe(false);
  });

  it("output updates: append, trimStart, set", () => {
    const upd = (output: unknown) => ({ type: "events", events: [{ type: "tool_execution_update", toolCallId: "t1", toolName: "bash", output }] }) as Frame;
    let vm = reduce(base(), upd({ append: "abcdef" }));
    expect(toolsOf(vm)[0].output).toBe("abcdef");
    vm = reduce(vm, upd({ trimStart: 2, append: "XY" }));
    expect(toolsOf(vm)[0].output).toBe("cdefXY");
    vm = reduce(vm, upd({ set: "fresh" }));
    expect(toolsOf(vm)[0].output).toBe("fresh");
  });

  it("error result -> error status; image results are collected", () => {
    const vm = reduce(base(), {
      type: "events",
      events: [
        {
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "bash",
          entry: {
            id: 3,
            kind: "pi.tool-result",
            model: [{ role: "toolResult", toolCallId: "t1", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }],
            data: { diagnostics: [] },
          },
        },
      ],
    });
    expect(toolsOf(vm)[0]).toMatchObject({ status: "error", resultText: "boom", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
  });

  it("execution time comes from details.tarsbotTiming", () => {
    const vm = reduce(base(), {
      type: "events",
      events: [
        {
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "bash",
          entry: {
            id: 3,
            kind: "pi.tool-result",
            model: [{ role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }], details: { tarsbotTiming: { durationMs: 1234 } } }],
            data: { diagnostics: [] },
          },
        },
      ],
    });
    expect(toolsOf(vm)[0]).toMatchObject({ status: "done", durationMs: 1234 });
  });

  it("formatDuration", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(4210)).toBe("4.2 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
  });

  it("toolcall_delta streams arguments", () => {
    const vm = replay([
      { type: "snapshot", entries: [] },
      {
        type: "events",
        events: [
          { type: "message_start", message: { role: "assistant", content: [] } },
          { type: "message_update", changes: [{ type: "toolcall_start", contentIndex: 0, block: { type: "toolCall", id: "t9", name: "bash", arguments: {} } }] },
          { type: "message_update", changes: [{ type: "toolcall_delta", contentIndex: 0, path: ["command"], delta: "ls " }] },
          { type: "message_update", changes: [{ type: "toolcall_delta", contentIndex: 0, path: ["command"], delta: "-la" }] },
        ],
      },
    ]);
    expect(toolsOf(vm)[0].args).toEqual({ command: "ls -la" });
  });

  it("task_failed shows up as a system message; inbox_update is tracked", () => {
    const vm = reduce(base(), {
      type: "events",
      events: [
        { type: "task_failed", taskId: 7, kind: "pi.generation", message: "provider exploded" },
        { type: "inbox_update", items: [{ id: 5, mode: "steer" }] },
      ],
    });
    const sys = vm.messages.find((m) => m.role === "system")!;
    expect(textOf(sys)).toContain("provider exploded");
    expect(vm.inbox).toEqual([{ id: 5, mode: "steer" }]);
  });

  it("compaction and reset entries", () => {
    let vm = reduce(base(), {
      type: "events",
      events: [
        {
          type: "entry_appended",
          entry: { id: 10, kind: "pi.compaction", model: [{ role: "user", content: [{ type: "text", text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nDid things.\n</summary>" }] }] },
        },
      ],
    });
    const c = vm.messages.find((m) => m.role === "compaction")!;
    expect(textOf(c)).toBe("Did things.");
    vm = reduce(vm, { type: "events", events: [{ type: "entry_appended", entry: { id: 11, kind: "pi.reset", head: 11 } }] });
    expect(vm.messages.map((m) => m.role)).toEqual(["system"]);
  });

  it("duplicate delivery of an entry does not duplicate messages", () => {
    const entry = { id: 20, kind: "pi.user", model: [{ role: "user", content: "hi" }] };
    const vm = reduce(emptyVM(), { type: "events", events: [{ type: "message_end", entry }, { type: "entry_appended", entry }] });
    expect(vm.messages).toHaveLength(1);
  });
});

describe("reducer: snapshot reset and late join", () => {
  it("a snapshot frame fully resets prior state (reconnect)", () => {
    const frames = loadFixture("run-basic");
    const full = replay(frames);
    const dirty = replay(loadFixture("run-abort"));
    const reconnected = reduce(dirty, snapshotAfter(frames, frames.length - 1));
    expect(reconnected).toEqual(full);
  });

  it("snapshot of an idle, empty conversation yields an empty VM", () => {
    const vm = reduce(replay(loadFixture("run-basic")), loadFixture("run-basic")[0]);
    expect(vm).toEqual({ ...emptyVM(), agent: { provider: "faux", modelId: "faux-1", cwd: expect.any(String) } });
  });

  for (const name of FIXTURES) {
    it(`late join: ${name} — snapshot at any point + remaining frames == full replay`, () => {
      const frames = loadFixture(name);
      const expected = replay(frames);
      for (let k = 0; k < frames.length; k++) {
        const vm = replay(frames.slice(k + 1), reduce(emptyVM(), snapshotAfter(frames, k)));
        expect(vm, `joined after ${k} event frames`).toEqual(expected);
      }
    });
  }

  it("mid-run snapshot shows running tool and busy state", () => {
    const frames = loadFixture("run-abort");
    const k = frames.findIndex((f) => f.type === "events" && f.events.some((e) => e.type === "tool_execution_update"));
    const vm = reduce(emptyVM(), snapshotAfter(frames, k));
    expect(vm.busy).toBe(true);
    expect(toolsOf(vm)[0]).toMatchObject({ status: "running", output: "started\n", args: { command: "echo started; sleep 30" } });
  });

  it("snapshot without an active run marks dangling tools interrupted (crash recovery)", () => {
    const frames = loadFixture("run-abort");
    const k = frames.findIndex((f) => f.type === "events" && f.events.some((e) => e.type === "tool_execution_update"));
    const snap = snapshotAfter(frames, k);
    delete snap.run;
    delete snap.generation;
    snap.tools = [];
    const vm = reduce(emptyVM(), snap);
    expect(vm.busy).toBe(false);
    expect(toolsOf(vm)[0].status).toBe("interrupted");
  });
});

describe("reducer: nested tool calls (codemode)", () => {
  // A running codemode call "cm1" whose script makes nested tool calls ("cm1/c1", ...).
  const base = (): ConversationVM =>
    replay([
      { type: "snapshot", entries: [], tools: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } },
      {
        type: "events",
        events: [
          { type: "run_start", inputs: [1] },
          {
            type: "message_end",
            entry: {
              id: 2,
              kind: "pi.assistant",
              model: [
                {
                  role: "assistant",
                  stopReason: "toolUse",
                  content: [{ type: "toolCall", id: "cm1", name: "codemode", arguments: { code: "await tools.bash({command:'ls'})" } }],
                },
              ],
            },
          },
          { type: "tool_execution_start", toolCallId: "cm1", toolName: "codemode", taskId: "t1", args: { code: "await tools.bash({command:'ls'})" } },
        ],
      },
    ]);

  it("nested start/update/end attach to the parent's nested list", () => {
    let vm = reduce(base(), {
      type: "events",
      events: [
        { type: "tool_execution_start", toolCallId: "cm1/c1", toolName: "bash", taskId: "t2", parentToolCallId: "cm1", parentTaskId: "t1", args: { command: "ls" } },
        { type: "tool_execution_update", toolCallId: "cm1/c1", toolName: "bash", parentToolCallId: "cm1", output: { append: "partial\n" } },
      ],
    });
    const parent = toolsOf(vm)[0];
    expect(parent.nested).toHaveLength(1);
    expect(parent.nested![0]).toMatchObject({ id: "cm1/c1", name: "bash", status: "running", args: { command: "ls" }, output: "partial\n" });
    // No stray top-level part for the nested call id.
    expect(toolsOf(vm)).toHaveLength(1);

    vm = reduce(vm, {
      type: "events",
      events: [
        {
          type: "tool_execution_end",
          toolCallId: "cm1/c1",
          toolName: "bash",
          parentToolCallId: "cm1",
          parentTaskId: "t1",
          result: { taskId: "t2", isError: false, diagnostics: [], durationMs: 42, structuredOutput: { output: "a.txt\nb.txt\n", truncated: false, exitCode: 0 } },
        },
      ],
    });
    expect(toolsOf(vm)[0].nested![0]).toMatchObject({ status: "done", durationMs: 42, output: "a.txt\nb.txt\n" });
  });

  it("nested end with isError -> error status and message; without result -> interrupted", () => {
    let vm = reduce(base(), {
      type: "events",
      events: [
        { type: "tool_execution_start", toolCallId: "cm1/c1", toolName: "bash", taskId: "t2", parentToolCallId: "cm1", args: { command: "rm -rf /" } },
        {
          type: "tool_execution_end",
          toolCallId: "cm1/c1",
          toolName: "bash",
          parentToolCallId: "cm1",
          result: { taskId: "t2", isError: true, diagnostics: [{ severity: "error", message: "User denied: rm -rf" }] },
        },
        { type: "tool_execution_start", toolCallId: "cm1/c2", toolName: "read", taskId: "t3", parentToolCallId: "cm1", args: { path: "x" } },
        { type: "tool_execution_end", toolCallId: "cm1/c2", toolName: "read", parentToolCallId: "cm1" },
      ],
    });
    const [denied, gone] = toolsOf(vm)[0].nested!;
    expect(denied).toMatchObject({ status: "error", error: "User denied: rm -rf" });
    expect(gone.status).toBe("interrupted");
  });

  it("run_end interrupts still-running nested calls too", () => {
    let vm = reduce(base(), {
      type: "events",
      events: [
        { type: "tool_execution_start", toolCallId: "cm1/c1", toolName: "bash", taskId: "t2", parentToolCallId: "cm1", args: { command: "sleep 9" } },
        { type: "run_end", inputs: [1] },
      ],
    });
    const parent = toolsOf(vm)[0];
    expect(parent.status).toBe("interrupted");
    expect(parent.nested![0].status).toBe("interrupted");
  });

  it("snapshot nestedTools attach to the parent's part", () => {
    const vm = reduce(emptyVM(), {
      type: "snapshot",
      entries: [
        {
          id: 2,
          kind: "pi.assistant",
          model: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "cm1", name: "codemode", arguments: { code: "x" } }] }],
        },
      ],
      run: { inputs: [1] },
      tools: [{ callId: "cm1", name: "codemode", status: "running", taskId: "t1" }],
      nestedTools: [
        { callId: "cm1/c1", name: "bash", status: "running", taskId: "t2", parentCallId: "cm1", parentTaskId: "t1", arguments: { command: "ls" }, output: "half\n" },
        {
          callId: "cm1/c2",
          name: "read",
          status: "done",
          taskId: "t3",
          parentCallId: "cm1",
          parentTaskId: "t1",
          arguments: { path: "a" },
          summary: { isError: false, durationMs: 7 },
        },
      ],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    });
    const parent = toolsOf(vm)[0];
    expect(parent.nested).toHaveLength(2);
    expect(parent.nested![0]).toMatchObject({ id: "cm1/c1", name: "bash", status: "running", args: { command: "ls" }, output: "half\n" });
    expect(parent.nested![1]).toMatchObject({ id: "cm1/c2", name: "read", status: "done", durationMs: 7 });
  });
});
