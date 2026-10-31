// Terminal panel tests: both modes, driven by a fake WebSocket (the real wire protocol lives in
// test/terminal.test.mjs + test/terminal-pty.test.mjs).
//   PTY:    consent gate -> start -> base64 in/out -> resize/signal/close frames. The display is the
//           built-in emulator (no xterm dep), so tests assert the decoded text lands on screen.
//   Console (non-interactive): run/out/exit/denied/kill frames, honestly labelled.
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { terminalPanel } from "../src/panels/terminal";
import type { PanelContext } from "../src/panels/types";
import type { BotSummary, ConversationVM } from "../src/types";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "b1",
  conversationId: "conv-1",
  model: { provider: "faux", modelId: "m" },
  busy: false,
  queued: 0,
  ...over,
});

const vm = { messages: [], busy: false, inbox: [], usage: {}, agent: {}, compacting: 0, toolStash: {} } as unknown as ConversationVM;
const ctxOf = (b?: BotSummary): PanelContext => ({ bots: b ? [b] : [], bot: b, vm });

/** Fake WebSocket: the test pushes server frames; sent frames are recorded. */
class FakeWS {
  static instances: FakeWS[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  constructor(public url: string) {
    FakeWS.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (d: string) => decodeURIComponent(escape(atob(d)));

afterEach(() => {
  FakeWS.instances = [];
  vi.restoreAllMocks();
});

/** Render the panel and switch to the console tab (PTY is the default mode now). */
async function renderConsole() {
  vi.stubGlobal("WebSocket", FakeWS);
  const user = userEvent.setup();
  render(<terminalPanel.Component {...ctxOf(bot())} />);
  await user.click(screen.getByRole("button", { name: "命令控制台" }));
  const ws = FakeWS.instances.find((i) => i.url.endsWith("/terminal"));
  if (!ws) throw new Error("console socket not opened");
  act(() => ws.emit({ type: "ready", root: "/home/sprite/sessions/x" }));
  return { user, ws };
}

/** Render, pass the consent gate and reach the "live" PTY. */
async function renderPty() {
  vi.stubGlobal("WebSocket", FakeWS);
  const user = userEvent.setup();
  render(<terminalPanel.Component {...ctxOf(bot())} />);
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "启动 Shell" }));
  const ws = FakeWS.instances.find((i) => i.url.endsWith("/terminal/pty"));
  if (!ws) throw new Error("pty socket not opened");
  act(() => ws.emit({ type: "ready", root: "/home/sprite/sessions/x" }));
  return { user, ws };
}

describe("terminalPanel — consent", () => {
  it("asks to select a session when there is no bot", () => {
    render(<terminalPanel.Component {...ctxOf()} />);
    expect(screen.getByText(/Select a session/)).toBeInTheDocument();
  });

  it("does NOT start a shell until the user confirms full access", async () => {
    vi.stubGlobal("WebSocket", FakeWS);
    const user = userEvent.setup();
    render(<terminalPanel.Component {...ctxOf(bot())} />);
    expect(screen.getAllByText(/完全访问/).length).toBeGreaterThan(0);
    expect(screen.getByText(/没有逐命令审批/)).toBeInTheDocument();
    expect(FakeWS.instances.filter((i) => i.url.includes("pty"))).toHaveLength(0);
    // unchecked: button disabled, still no socket
    expect(screen.getByRole("button", { name: "启动 Shell" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "启动 Shell" }));
    expect(FakeWS.instances.some((i) => i.url.endsWith("/terminal/pty"))).toBe(true);
  });
});

describe("terminalPanel — PTY", () => {
  it("sends start with dims on ready, decodes out frames, sends keystrokes as base64", async () => {
    const { user, ws } = await renderPty();
    expect(ws.sent).toContainEqual(expect.objectContaining({ type: "start", cols: 80, rows: 24 }));
    act(() => ws.emit({ type: "started", cols: 80, rows: 24 }));
    act(() => ws.emit({ type: "out", data: b64("$ hello\n") }));
    expect(screen.getByText("$ hello")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Terminal input"));
    await user.keyboard("ls{Enter}");
    const ins = ws.sent.filter((m) => (m as { type: string }).type === "in") as { data: string }[];
    expect(ins.map((m) => unb64(m.data)).join("")).toBe("ls\r");
  });

  it("maps control keys (Ctrl-C, arrows) to byte sequences", async () => {
    const { user, ws } = await renderPty();
    act(() => ws.emit({ type: "started", cols: 80, rows: 24 }));
    await user.click(screen.getByLabelText("Terminal input"));
    await user.keyboard("{ArrowUp}{ArrowDown}");
    const ins = ws.sent.filter((m) => (m as { type: string }).type === "in").map((m) => unb64((m as { data: string }).data));
    expect(ins.join("")).toBe("\x1b[A\x1b[B");
    // ^C button sends the signal frame, not a byte
    await user.click(screen.getByRole("button", { name: "Send SIGINT" }));
    expect(ws.sent).toContainEqual({ type: "signal", signal: "SIGINT" });
  });

  it("Kill sends close; exit frame ends the session and offers reconnect", async () => {
    const { user, ws } = await renderPty();
    act(() => ws.emit({ type: "started", cols: 80, rows: 24 }));
    await user.click(screen.getByRole("button", { name: "Kill shell" }));
    expect(ws.sent).toContainEqual({ type: "close" });
    act(() => ws.emit({ type: "exit", state: "closed", exit: null }));
    expect(screen.getByRole("button", { name: "重新连接" })).toBeInTheDocument();
  });

  it("SGR colors are rendered (16-color palette)", async () => {
    const { ws } = await renderPty();
    act(() => ws.emit({ type: "started", cols: 80, rows: 24 }));
    act(() => ws.emit({ type: "out", data: b64("\x1b[32mgreen\x1b[0m") }));
    const el = screen.getByText("green");
    expect(el).toHaveStyle({ color: "#4ade80" });
  });
});

describe("terminalPanel — console", () => {
  it("is honestly labelled as a non-interactive console (no PTY)", async () => {
    await renderConsole();
    expect(screen.getByText(/非交互式/)).toBeInTheDocument();
    expect(screen.getByText(/无 stdin/)).toBeInTheDocument();
    expect(screen.getByText("/home/sprite/sessions/x")).toBeInTheDocument();
  });

  it("sends run on submit and renders out + exit frames in order", async () => {
    const { user, ws } = await renderConsole();
    await user.type(screen.getByLabelText("Command"), "echo hi");
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(ws.sent).toEqual([{ type: "run", id: "r1", command: "echo hi" }]);
    act(() => ws.emit({ type: "started", id: "r1", runId: "term-r1-1" }));
    act(() => ws.emit({ type: "out", id: "r1", data: "hi\n" }));
    act(() => ws.emit({ type: "exit", id: "r1", state: "exited", exit: 0 }));
    expect(screen.getByText(/echo hi/)).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("[exit 0]")).toBeInTheDocument();
  });

  it("shows a denied command's reason and never marks it running", async () => {
    const { user, ws } = await renderConsole();
    await user.type(screen.getByLabelText("Command"), "rm -rf /");
    await user.click(screen.getByRole("button", { name: "Run" }));
    act(() => ws.emit({ type: "denied", id: "r1", reason: "recursive force delete (rm -rf)" }));
    expect(await screen.findByText(/recursive force delete/)).toBeInTheDocument();
  });

  it("kill button sends kill; a confirmed exit frame clears running so the next command can run", async () => {
    const { user, ws } = await renderConsole();
    await user.type(screen.getByLabelText("Command"), "sleep 9");
    await user.click(screen.getByRole("button", { name: "Run" }));
    act(() => ws.emit({ type: "started", id: "r1", runId: "term-r1-1" }));
    await user.click(screen.getByRole("button", { name: /Kill/ }));
    expect(ws.sent).toContainEqual({ type: "kill", id: "r1" });
    act(() => ws.emit({ type: "killing", id: "r1" }));
    // The bug being covered: previously "[killing…]" was the end; now the server always follows
    // with a terminal exit frame and the input/buttons unblock.
    act(() => ws.emit({ type: "exit", id: "r1", state: "exited", exit: 143 }));
    expect(screen.getByText("[exit 143]")).toBeInTheDocument();
    expect(screen.getByLabelText("Command")).toBeEnabled();
    await user.type(screen.getByLabelText("Command"), "echo next");
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(ws.sent).toContainEqual({ type: "run", id: "r2", command: "echo next" });
  });
});
