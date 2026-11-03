import { describe, expect, it } from "vitest";
import { applyOps, emptyVM, reduce, type Frame, type WireOp, type WireView } from "../src/lib/reducer";
import type { ChatMessage, ConversationVM, ToolPart } from "../src/types";
import { FIXTURES, loadFixture, viewAfter } from "./helpers";
import { formatDuration } from "../src/lib/format";

const replay = (frames: Frame[], from = emptyVM()) => frames.reduce(reduce, from);
const toolsOf = (vm: ConversationVM): ToolPart[] =>
  vm.messages.flatMap((m) => m.parts.filter((p): p is ToolPart => p.type === "tool"));
const textOf = (m: ChatMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const ops = (...list: WireOp[]): Frame => ({ type: "ops", ops: list });
/** Index of the first frame after which `pred` holds for the replayed VM. */
const firstWhere = (frames: Frame[], pred: (vm: ConversationVM) => boolean) => {
  let vm = emptyVM();
  for (let i = 0; i < frames.length; i++) {
    vm = reduce(vm, frames[i]);
    if (pred(vm)) return i;
  }
  return -1;
};
/** Without the reducer's internal protocol state. */
const visible = ({ wire: _wire, ...vm }: ConversationVM) => vm;

describe("reducer: recorded fixtures", () => {
  it("run-basic: streamed thinking/text, tool runs to completion", () => {
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
    expect(vm.usage.totalTokens).toBeGreaterThan(0);
    expect(vm.agent).toMatchObject({ provider: "faux", modelId: "faux-1" });
    expect(vm.toolStash).toEqual({});
  });

  it("streams incrementally: the partial answer is pending until its entry is committed", () => {
    const frames = loadFixture("run-basic");
    const k = firstWhere(frames, (vm) => vm.messages.some((m) => m.pending && m.parts.some((p) => p.type === "text")));
    expect(k).toBeGreaterThan(0);
    let vm = replay(frames.slice(0, k + 1));
    const pending = vm.messages.find((m) => m.pending)!;
    expect(pending.role).toBe("assistant");
    expect(pending.entryId).toBeUndefined();
    expect(pending.parts[0]).toMatchObject({ type: "thinking" });
    expect((pending.parts[1] as { text: string }).text).toMatch(/^Let me l/);
    expect(vm.busy).toBe(true);
    const done = firstWhere(frames, (v) => v.messages.some((m) => m.role === "assistant" && !m.pending));
    vm = replay(frames.slice(0, done + 1));
    expect(vm.messages.some((m) => m.pending)).toBe(false);
    const committed = vm.messages.find((m) => m.role === "assistant")!;
    expect(committed.id).toBe(`e${committed.entryId}`);
  });

  it("tool pending -> running with live output -> error result (failing command)", () => {
    const frames = loadFixture("run-tool");
    const running = firstWhere(frames, (vm) => toolsOf(vm)[0]?.output !== "" && toolsOf(vm)[0]?.status === "running" && toolsOf(vm)[0]?.output !== undefined);
    expect(running).toBeGreaterThan(0);
    const mid = replay(frames.slice(0, running + 1));
    expect(toolsOf(mid)[0]).toMatchObject({ status: "running", output: "partial output\n" });
    const vm = replay(frames);
    expect(toolsOf(vm)[0]).toMatchObject({ status: "error", resultText: "partial output\noops\n", diagnostics: ["Command exited with code 3"] });
    expect(vm.busy).toBe(false);
  });

  it("run-abort: aborted tool is interrupted and keeps partial output; an aborted run shows no failure", () => {
    const vm = replay(loadFixture("run-abort"));
    const [tool] = toolsOf(vm);
    expect(tool.status).toBe("interrupted");
    expect(tool.output).toBe("started\n");
    expect(tool.diagnostics).toEqual(["Tool bash was aborted"]);
    expect(vm.busy).toBe(false);
    expect(vm.messages.some((m) => m.role === "system")).toBe(false);
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
  const assistant = {
    id: 2,
    kind: "pi.assistant",
    model: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 9" } }] }],
  };
  const baseView = (): WireView => ({
    conversation: { id: 1 },
    entries: [{ id: 1, kind: "pi.user", model: [{ role: "user", content: "go" }] }, assistant],
    docs: {
      "pi.live": { run: { taskId: 5, inputs: [1], turns: 1 }, tools: [{ callId: "t1", name: "bash", taskId: 6, status: "running", output: "" }] },
      "pi.inbox": { items: [] },
      "pi.agent": {},
      "pi.usage": { models: {}, tools: {} },
    },
  });
  const base = (): ConversationVM => reduce(emptyVM(), { type: "view", view: baseView() });
  const result = (content: unknown[], extra: Record<string, unknown> = {}) => ({
    id: 3,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content, ...extra }],
    data: { diagnostics: [] },
  });
  const settle = (entry: unknown): Frame =>
    ops(["s", ["docs", "pi.live", "tools", 0, "status"], "done"], ["s", ["docs", "pi.live", "tools", 0, "entry"], 3], ["p", ["entries"], 2, 0, [entry]]);

  it("a running slot shows the tool running; busy", () => {
    const vm = base();
    expect(vm.busy).toBe(true);
    expect(toolsOf(vm)[0]).toMatchObject({ status: "running", args: { command: "sleep 9" } });
  });

  it("a done slot without a result entry -> interrupted (the task faulted)", () => {
    const vm = reduce(base(), ops(["s", ["docs", "pi.live", "tools", 0, "status"], "done"]));
    expect(toolsOf(vm)[0].status).toBe("interrupted");
  });

  it("run ends with a still-running tool -> interrupted, not busy", () => {
    const vm = reduce(base(), ops(["d", ["docs", "pi.live", "run"]], ["d", ["docs", "pi.live", "tools"]]));
    expect(toolsOf(vm)[0].status).toBe("interrupted");
    expect(vm.busy).toBe(false);
  });

  it("running output follows the slot: set, append, trim", () => {
    const out = ["docs", "pi.live", "tools", 0, "output"] as const;
    let vm = reduce(base(), ops(["s", out, "abcdef"]));
    expect(toolsOf(vm)[0].output).toBe("abcdef");
    vm = reduce(vm, ops(["t", out, 2], ["a", out, "XY"]));
    expect(toolsOf(vm)[0].output).toBe("cdefXY");
    vm = reduce(vm, ops(["s", out, "fresh"]));
    expect(toolsOf(vm)[0].output).toBe("fresh");
  });

  it("error result -> error status; image results are collected", () => {
    const vm = reduce(base(), settle(result([{ type: "text", text: "boom" }, { type: "image", data: "AAAA", mimeType: "image/png" }], { isError: true })));
    expect(toolsOf(vm)[0]).toMatchObject({ status: "error", resultText: "boom", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
  });

  it("execution time comes from details.tarsbotTiming", () => {
    const vm = reduce(base(), settle(result([{ type: "text", text: "ok" }], { details: { tarsbotTiming: { durationMs: 1234 } } })));
    expect(toolsOf(vm)[0]).toMatchObject({ status: "done", durationMs: 1234 });
  });

  it("formatDuration", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(4210)).toBe("4.2 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
  });

  it("streamed tool-call arguments (appends to the generation's message)", () => {
    const view: WireView = { entries: [], docs: { "pi.live": { run: { taskId: 1, inputs: [], turns: 0 } } } };
    const msg = ["docs", "pi.live", "generation", "message"] as const;
    const vm = replay([
      { type: "view", view },
      ops(["s", ["docs", "pi.live", "generation"], { attempt: 1 }]),
      ops(["s", msg, { role: "assistant", content: [{ type: "toolCall", id: "t9", name: "bash", arguments: { command: "" } }] }]),
      ops(["a", [...msg, "content", 0, "arguments", "command"], "ls "]),
      ops(["a", [...msg, "content", 0, "arguments", "command"], "-la"]),
    ]);
    expect(vm.messages.at(-1)).toMatchObject({ id: "pending", pending: true });
    expect(toolsOf(vm)[0].args).toEqual({ command: "ls -la" });
  });

  it("runFailure shows up as a system error message until the next run; inbox is tracked", () => {
    let vm = reduce(
      base(),
      ops(
        ["d", ["docs", "pi.live", "run"]],
        ["d", ["docs", "pi.live", "tools"]],
        ["s", ["docs", "pi.live", "runFailure"], { taskId: 7, inputs: [1], reason: "model_error", detail: "provider exploded" }],
        ["s", ["docs", "pi.inbox", "items"], [{ id: 5, mode: "steer" }]],
      ),
    );
    const sys = vm.messages.find((m) => m.role === "system")!;
    expect(sys).toMatchObject({ tone: "error" });
    expect(textOf(sys)).toContain("provider exploded");
    expect(vm.inbox).toEqual([{ id: 5, mode: "steer" }]);
    expect(vm.busy).toBe(false);
    vm = reduce(vm, ops(["d", ["docs", "pi.live", "runFailure"]], ["s", ["docs", "pi.live", "run"], { taskId: 8, inputs: [5], turns: 0 }]));
    expect(vm.messages.some((m) => m.role === "system")).toBe(false);
    expect(vm.busy).toBe(true);
  });

  it("compactions count and a compaction failure is shown", () => {
    let vm = reduce(base(), ops(["s", ["docs", "pi.live", "compactions"], [{ taskId: 9, trigger: "threshold", blocking: false, attempt: 1 }]]));
    expect(vm.compacting).toBe(1);
    vm = reduce(vm, ops(["d", ["docs", "pi.live", "compactions"]], ["s", ["docs", "pi.live", "compactionFailure"], { taskId: 9, trigger: "threshold", error: "too long" }]));
    expect(vm.compacting).toBe(0);
    expect(textOf(vm.messages.find((m) => m.role === "system")!)).toContain("too long");
  });

  it("compaction and reset entries", () => {
    let vm = reduce(
      base(),
      ops([
        "p",
        ["entries"],
        2,
        0,
        [{ id: 10, kind: "pi.compaction", model: [{ role: "user", content: [{ type: "text", text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nDid things.\n</summary>" }] }] }],
      ]),
    );
    const c = vm.messages.find((m) => m.role === "compaction")!;
    expect(textOf(c)).toBe("Did things.");
    vm = reduce(vm, ops(["d", ["docs", "pi.live", "run"]], ["d", ["docs", "pi.live", "tools"]], ["p", ["entries"], 3, 0, [{ id: 11, kind: "pi.reset", head: 11 }]]));
    expect(vm.messages.map((m) => m.role)).toEqual(["system"]);
  });

  it("an entry delivered again (root replacement after overflow) does not duplicate messages", () => {
    const vm0 = base();
    const vm = reduce(vm0, ops(["r", baseView()]));
    expect(vm.messages).toHaveLength(vm0.messages.length);
  });

  it("entries that leave the window stay rendered", () => {
    const vm = reduce(base(), ops(["p", ["entries"], 0, 2, []]));
    expect(vm.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("unchanged messages keep their identity across frames", () => {
    const vm0 = base();
    const vm = reduce(vm0, ops(["s", ["docs", "pi.usage", "models", "x"], { input: 1, totalTokens: 1 }]));
    expect(vm.messages[0]).toBe(vm0.messages[0]);
    expect(vm.agent).toBe(vm0.agent);
    expect(vm.usage.totalTokens).toBe(1);
  });

  it("applyOps never mutates its input", () => {
    const view = baseView();
    const before = JSON.stringify(view);
    applyOps(view, [["s", ["docs", "pi.live", "tools", 0, "output"], "x"], ["p", ["entries"], 0, 1, []], ["d", ["docs", "pi.inbox"]]]);
    expect(JSON.stringify(view)).toBe(before);
  });
});

describe("reducer: view reset and late join", () => {
  it("a view frame fully resets prior state (reconnect)", () => {
    const frames = loadFixture("run-basic");
    const full = replay(frames);
    const dirty = replay(loadFixture("run-abort"));
    const reconnected = reduce(dirty, viewAfter(frames, frames.length - 1));
    expect(visible(reconnected)).toEqual(visible(full));
  });

  it("the view of an idle, empty conversation yields an empty VM", () => {
    const vm = reduce(replay(loadFixture("run-basic")), loadFixture("run-basic")[0]);
    expect(visible(vm)).toEqual({ ...emptyVM(), agent: { provider: "faux", modelId: "faux-1", cwd: expect.any(String) } });
  });

  for (const name of FIXTURES) {
    it(`late join: ${name} — view at any point + remaining frames == full replay`, () => {
      const frames = loadFixture(name);
      const expected = visible(replay(frames));
      for (let k = 0; k < frames.length; k++) {
        const vm = replay(frames.slice(k + 1), reduce(emptyVM(), viewAfter(frames, k)));
        expect(visible(vm), `joined after ${k} op frames`).toEqual(expected);
      }
    });
  }

  it("a mid-run view shows the running tool and busy state", () => {
    const frames = loadFixture("run-abort");
    const k = firstWhere(frames, (vm) => toolsOf(vm)[0]?.output === "started\n" && toolsOf(vm)[0]?.status === "running");
    const vm = reduce(emptyVM(), viewAfter(frames, k));
    expect(vm.busy).toBe(true);
    expect(toolsOf(vm)[0]).toMatchObject({ status: "running", output: "started\n", args: { command: "echo started; sleep 30" } });
  });

  it("a view without an active run marks dangling tools interrupted (crash recovery)", () => {
    const frames = loadFixture("run-abort");
    const k = firstWhere(frames, (vm) => toolsOf(vm)[0]?.output === "started\n" && toolsOf(vm)[0]?.status === "running");
    const frame = viewAfter(frames, k);
    const live = frame.view.docs!["pi.live"];
    delete live.run;
    delete live.generation;
    delete live.tools;
    const vm = reduce(emptyVM(), frame);
    expect(vm.busy).toBe(false);
    expect(toolsOf(vm)[0].status).toBe("interrupted");
  });
});
