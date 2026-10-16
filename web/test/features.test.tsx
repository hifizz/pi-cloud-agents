import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyVM, reduce, type Frame } from "../src/lib/reducer";
import { ApprovalBar, summarizeArgs } from "../src/components/ApprovalBar";
import { ForkDialog } from "../src/components/ForkDialog";
import { RoutinesPanel } from "../src/components/RoutinesPanel";
import { BotList } from "../src/components/BotList";
import { MessageList } from "../src/components/Chat/MessageList";
import { ApprovalsStream, parseApprovalsFrame } from "../src/lib/approvals";
import { api } from "../src/lib/api";
import type { ApprovalItem, BotSummary, ChatMessage, RoutineItem } from "../src/types";
import { loadFixture } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "tars",
  conversationId: 2,
  model: { provider: "tokenrouter", modelId: "glm-5.3" },
  busy: false,
  queued: 0,
  ...over,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("reducer: entryId", () => {
  it("carries the durable entry id on user/assistant messages, none while streaming", () => {
    const frames = loadFixture("run-basic");
    const vm = frames.reduce<ReturnType<typeof emptyVM>>(reduce, emptyVM());
    for (const m of vm.messages) {
      expect(m.entryId).toBe(Number(m.id.slice(1)));
    }
    expect(vm.messages.length).toBeGreaterThan(0);

    const mid = frames.slice(0, 7).reduce<ReturnType<typeof emptyVM>>(reduce, emptyVM());
    const pending = mid.messages.find((m) => m.pending)!;
    expect(pending.entryId).toBeUndefined();
  });

  it("compaction entries carry entryId and render as collapsed summaries", () => {
    const frame: Frame = {
      type: "snapshot",
      entries: [{ id: 7, kind: "pi.compaction", model: [{ role: "user", content: "<summary>\nEarlier work\n</summary>" }] }],
    };
    const vm = reduce(emptyVM(), frame);
    expect(vm.messages[0]).toMatchObject({ role: "compaction", entryId: 7 });
    render(<MessageList messages={vm.messages} busy={false} />);
    const summary = screen.getByText(/context compacted/i);
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });
});

describe("ApprovalBar", () => {
  const items: ApprovalItem[] = [
    { taskId: "41", conversationId: "2", toolName: "bash", args: { command: "rm -rf /tmp/x" }, reason: "recursive force delete (rm -rf)" },
    { taskId: "42", conversationId: "2", toolName: "write", args: { x: 1, y: 2 }, reason: "matches tool name" },
  ];

  it("renders nothing without items", () => {
    const { container } = render(<ApprovalBar items={[]} onResolve={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows tool, bash command and reason; summarizes other args as JSON", () => {
    render(<ApprovalBar items={items} onResolve={vi.fn()} />);
    const [first, second] = screen.getAllByTestId("approval-item");
    expect(first).toHaveTextContent("bash");
    expect(first).toHaveTextContent("rm -rf /tmp/x");
    expect(first).toHaveTextContent("recursive force delete (rm -rf)");
    expect(second).toHaveTextContent('{"x":1,"y":2}');
    expect(summarizeArgs("bash", { command: "ls" })).toBe("ls");
  });

  it("Approve / Deny call back with the task id and verdict", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalBar items={items} onResolve={onResolve} />);
    const [first, second] = screen.getAllByTestId("approval-item");
    await user.click(within(first).getByRole("button", { name: "Approve" }));
    expect(onResolve).toHaveBeenLastCalledWith("41", true);
    await user.click(within(second).getByRole("button", { name: "Deny" }));
    expect(onResolve).toHaveBeenLastCalledWith("42", false);
  });

  it("shows the error when resolving fails", async () => {
    const user = userEvent.setup();
    render(<ApprovalBar items={items} onResolve={vi.fn().mockRejectedValue(new Error("no pending approval: 41"))} />);
    await user.click(within(screen.getAllByTestId("approval-item")[0]).getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no pending approval: 41");
  });

  it("api.resolveApproval POSTs {approved}", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
    await api.resolveApproval("41", false);
    expect(fetchMock).toHaveBeenCalledWith("/api/approvals/41", expect.objectContaining({ method: "POST", body: JSON.stringify({ approved: false }) }));
  });
});

describe("ApprovalsStream", () => {
  class FakeWS {
    static instances: FakeWS[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) {
      FakeWS.instances.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  it("parses approvals frames and ignores others", () => {
    expect(parseApprovalsFrame(JSON.stringify({ type: "approvals", items: [{ taskId: 5, conversationId: 2, toolName: "bash", args: { command: "x" } }] }))).toEqual([
      { taskId: "5", conversationId: "2", toolName: "bash", args: { command: "x" } },
    ]);
    expect(parseApprovalsFrame("not json")).toBeUndefined();
    expect(parseApprovalsFrame(JSON.stringify({ type: "other" }))).toBeUndefined();
  });

  it("delivers items and reconnects with backoff after close", () => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    const onItems = vi.fn();
    const statuses: string[] = [];
    const s = new ApprovalsStream({ onItems, onStatus: (x) => statuses.push(x), url: "ws://x/a", WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    s.start();
    const first = FakeWS.instances[0];
    first.onopen?.();
    first.onmessage?.({ data: JSON.stringify({ type: "approvals", items: [] }) });
    expect(onItems).toHaveBeenCalledWith([]);
    first.onclose?.();
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeWS.instances).toHaveLength(2);
    s.stop();
    expect(FakeWS.instances[1].closed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.instances).toHaveLength(2);
    expect(statuses).toContain("reconnecting");
    vi.useRealTimers();
  });
});

describe("BotList: approvals badge and fork lineage", () => {
  it("shows a badge for pending approvals and the parent name on forked bots", () => {
    const bots = [bot(), bot({ id: "b2", name: "reviewer", conversationId: 9, parent: { botId: "b1", entryId: 3 } })];
    render(<BotList bots={bots} onSelect={vi.fn()} onCreate={vi.fn()} pendingApprovals={{ b2: 2 }} />);
    expect(screen.getByRole("status", { name: "2 pending approvals" })).toHaveTextContent("2");
    expect(screen.getByText("↳ tars")).toBeInTheDocument();
  });
});

describe("Fork", () => {
  const messages: ChatMessage[] = [
    { id: "e1", entryId: 1, role: "user", parts: [{ type: "text", text: "hello" }] },
    { id: "pending", role: "assistant", pending: true, parts: [{ type: "text", text: "typing" }] },
  ];

  it("message shows a Fork button only when it has an entry id", async () => {
    const user = userEvent.setup();
    const onFork = vi.fn();
    render(<MessageList messages={messages} busy={false} onFork={onFork} />);
    const buttons = screen.getAllByRole("button", { name: "Fork from here" });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]);
    expect(onFork).toHaveBeenCalledWith(1);
  });

  it("dialog submits name, model and readOnly (default on)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ForkDialog parentName="tars" entryId={12} defaultModelId="glm-5.3" onSubmit={onSubmit} onClose={onClose} />);
    expect(screen.getByRole("checkbox", { name: /read-only tools/i })).toBeChecked();
    await user.type(screen.getByLabelText("New bot name"), "  reviewer ");
    await user.selectOptions(screen.getByLabelText("Model"), "glm-5.3-flash");
    await user.click(screen.getByRole("button", { name: "Fork" }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "reviewer", modelId: "glm-5.3-flash", readOnly: true, entryId: 12 });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("dialog honours unchecking read-only, keeps open and shows the error on failure", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("bot exists: dup"));
    const onClose = vi.fn();
    render(<ForkDialog parentName="tars" entryId={3} onSubmit={onSubmit} onClose={onClose} />);
    await user.type(screen.getByLabelText("New bot name"), "dup");
    await user.click(screen.getByRole("checkbox", { name: /read-only tools/i }));
    await user.click(screen.getByRole("button", { name: "Fork" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "dup", readOnly: false }));
    expect(await screen.findByRole("alert")).toHaveTextContent("bot exists: dup");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape closes the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ForkDialog parentName="tars" onSubmit={vi.fn()} onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("api.forkBot POSTs the route's expected body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(bot({ id: "n" })));
    await api.forkBot("b1", { name: "r", entryId: 12, modelId: "glm-5.3", readOnly: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/bots/b1/fork");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "r", readOnly: true, entryId: "12", modelId: "glm-5.3" });
  });
});

describe("RoutinesPanel", () => {
  const routines: RoutineItem[] = [
    { id: "r1", bot: "tars", botId: "b1", prompt: "check the inbox", everyMs: 1_800_000, enabled: true, status: "running", nextAt: Date.UTC(2026, 9, 7, 1, 0, 0), fireCount: 0 },
    { id: "r2", bot: "tars", botId: "b1", prompt: "cancelled one", everyMs: 60_000, enabled: false, status: "terminal:aborted" },
  ];

  it("is collapsed until opened, then lists active routines", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(routines));
    render(<RoutinesPanel bots={[bot()]} />);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /routines/i }));
    const item = await screen.findByTestId("routine-item");
    expect(item).toHaveTextContent("check the inbox");
    expect(item).toHaveTextContent("tars");
    expect(item).toHaveTextContent("every 30 min");
    expect(item).toHaveTextContent(/Next: (?!—)/);
    expect(screen.queryByText("cancelled one")).not.toBeInTheDocument();
  });

  it("creates a routine with everyMs from minutes, then cancels one", async () => {
    const user = userEvent.setup();
    let list: RoutineItem[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (url === "/api/routines" && method === "POST") {
        list = [routines[0]];
        return jsonResponse(routines[0]);
      }
      if (url === "/api/routines/r1/cancel") {
        list = [];
        return jsonResponse({ ok: true, id: "r1" });
      }
      return jsonResponse(list);
    });
    render(<RoutinesPanel bots={[bot(), bot({ id: "b2", name: "other" })]} />);
    await user.click(screen.getByRole("button", { name: /routines/i }));
    await user.click(await screen.findByRole("button", { name: "New routine" }));
    await user.selectOptions(screen.getByLabelText("Bot"), "b2");
    await user.type(screen.getByLabelText("Prompt"), "check the inbox");
    await user.clear(screen.getByLabelText("Every (minutes)"));
    await user.type(screen.getByLabelText("Every (minutes)"), "30");
    await user.click(screen.getByRole("button", { name: "Create routine" }));

    const post = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/routines" && (i as RequestInit)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ bot: "b2", prompt: "check the inbox", everyMs: 1_800_000 });

    await user.click(await screen.findByRole("button", { name: /cancel routine/i }));
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === "/api/routines/r1/cancel" && (i as RequestInit)?.method === "POST")).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("routine-item")).not.toBeInTheDocument());
  });

  it("shows an error from the server", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    render(<RoutinesPanel bots={[bot()]} />);
    await user.click(screen.getByRole("button", { name: /routines/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
