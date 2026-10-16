import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiffPanel } from "../src/panels/diff/DiffPanel";
import { diffPanel } from "../src/panels/diff";
import type { DiffSource } from "../src/panels/diff/source";
import type { PanelContext } from "../src/panels/types";
import { tokenize } from "../src/lib/highlight";
import type { ChatMessage, ConversationVM, ToolPart } from "../src/types";

const write = (id: string, path: string, content: string): ToolPart => ({ type: "tool", id, name: "write", args: { path, content }, status: "done", output: "" });
const turnMsgs = (n: number, tools: ToolPart[]): ChatMessage[] => [
  { id: `u${n}`, entryId: n * 2, role: "user", parts: [{ type: "text", text: `task ${n}` }], at: 1000 },
  { id: `a${n}`, entryId: n * 2 + 1, role: "assistant", parts: [...tools, { type: "text", text: "done" }], at: 2000 },
];
const vmOf = (messages: ChatMessage[], busy = false) => ({ messages, busy, inbox: [], usage: {}, agent: {}, compacting: 0, toolStash: {} }) as unknown as ConversationVM;
const ctxOf = (messages: ChatMessage[], extra: Partial<PanelContext> = {}, busy = false): PanelContext => ({ bots: [], vm: vmOf(messages, busy), ...extra });

const two = [
  ...turnMsgs(1, [write("w1", "/w/a.ts", "const a = 1;\nconst b = 2;")]),
  ...turnMsgs(2, [write("w2", "/w/b.py", "print(1)"), write("w3", "/w/c.md", "# hi")]),
];

describe("tokenize", () => {
  it("classifies keywords, strings, comments", () => {
    const t = tokenize('const x = "a"; // note', "ts");
    expect(t.find((k) => k.text === "const")?.kind).toBe("kw");
    expect(t.find((k) => k.text === '"a"')?.kind).toBe("str");
    expect(t.find((k) => k.kind === "cm")?.text).toBe("// note");
    expect(tokenize("foo(Bar, 12)", "ts").map((k) => k.kind)).toEqual(expect.arrayContaining(["fn", "type", "num"]));
  });
  it("returns long lines and non-JS files unchanged", () => {
    const long = "const ".repeat(500);
    expect(tokenize(long, "ts")).toEqual([{ text: long }]);
    expect(tokenize("const x", "py")).toEqual([{ text: "const x" }]);
  });
});

describe("DiffPanel", () => {
  it("shows the last turn by default and switches via TurnSelect; Escape closes", async () => {
    const user = userEvent.setup();
    render(<DiffPanel {...ctxOf(two)} />);
    expect(screen.getByRole("group", { name: "Changes in /w/b.py" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Changes in /w/a.ts" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select turn" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select turn" }));
    await user.click(screen.getByRole("option", { name: /Turn 1/ }));
    expect(screen.getByRole("group", { name: "Changes in /w/a.ts" })).toBeInTheDocument();
    expect(within(screen.getByRole("toolbar", { name: "Changed files" })).getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Changes in /w/b.py" })).not.toBeInTheDocument();
  });

  it("collapses files, collapse/expand all, wrap toggle", async () => {
    const user = userEvent.setup();
    render(<DiffPanel {...ctxOf(two)} />);
    const card = screen.getByRole("group", { name: "Changes in /w/b.py" });
    expect(within(card).getByText("print(1)", { exact: false })).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Collapse /w/b.py" }));
    expect(within(card).queryByText("print(1)", { exact: false })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand /w/b.py" }));
    await user.click(screen.getByRole("button", { name: /Collapse all/ }));
    expect(screen.getAllByRole("button", { name: /^Expand \// })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Expand all/ }));
    expect(screen.getAllByRole("button", { name: /^Collapse \// })).toHaveLength(2);
    const wrap = screen.getByRole("button", { name: "Wrap" });
    expect(wrap).toHaveAttribute("aria-pressed", "false");
    await user.click(wrap);
    expect(wrap).toHaveAttribute("aria-pressed", "true");
  });

  it("applies focus (repeatedly) to turn and file", () => {
    const { rerender } = render(<DiffPanel {...ctxOf(two, { focus: { turnKey: "u1", path: "/w/a.ts", seq: 1 } })} />);
    expect(screen.getByRole("group", { name: "Changes in /w/a.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /a\.ts/, pressed: true })).toBeInTheDocument();
    rerender(<DiffPanel {...ctxOf(two, { focus: { turnKey: "u2", path: "/w/c.md", seq: 2 } })} />);
    expect(screen.getByRole("button", { name: /c\.md/, pressed: true })).toBeInTheDocument();
    rerender(<DiffPanel {...ctxOf(two, { focus: { turnKey: "u2", path: "/w/c.md", seq: 3 } })} />);
    expect(screen.getByRole("button", { name: /c\.md/, pressed: true })).toBeInTheDocument();
  });

  it("hides a busy last turn; empty state without changes", () => {
    const { unmount } = render(<DiffPanel {...ctxOf(two, {}, true)} />);
    expect(screen.queryByRole("group", { name: "Changes in /w/b.py" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Changes in /w/a.ts" })).toBeInTheDocument();
    unmount();
    render(<DiffPanel {...ctxOf([])} />);
    expect(screen.getByText(/No file changes in this conversation yet/)).toBeInTheDocument();
  });

  it("accepts a custom source", () => {
    const source: DiffSource = {
      id: "x",
      label: "X",
      useTurns: () => ({ turns: [{ key: "k", index: 7, files: [{ path: "/z/only.ts", add: 1, del: 0, lines: [{ kind: "add", num: 1, text: "let z" }] }], add: 1, del: 0 }] }),
    };
    render(<DiffPanel {...ctxOf([])} source={source} />);
    expect(screen.getByRole("group", { name: "Changes in /z/only.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select turn" })).toHaveTextContent("Turn 7");
  });

  it("badge counts changed files", () => {
    expect(diffPanel.badge?.(ctxOf(two))).toBe(3);
    expect(diffPanel.badge?.(ctxOf([]))).toBeUndefined();
  });
});
