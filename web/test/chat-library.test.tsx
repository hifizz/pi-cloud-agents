import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageList } from "../src/components/Chat/MessageList";
import { registerTool, resolveTool } from "../src/components/Chat";
import { parseSearchResults } from "../src/components/Chat/tools/builtin/web";
import { parsePiDiff } from "../src/lib/diff";
import { deriveFeed } from "../src/lib/turns";
import type { ChatMessage, ToolPart } from "../src/types";

const tool = (over: Partial<ToolPart>): ToolPart => ({ type: "tool", id: "t", name: "bash", args: {}, status: "done", output: "", ...over });
const turn = (parts: ChatMessage["parts"], at = 1000): ChatMessage[] => [
  { id: "u", entryId: 1, role: "user", parts: [{ type: "text", text: "do it" }], at },
  { id: "a", entryId: 2, role: "assistant", parts, at: at + 42_000 },
];

describe("tool registry", () => {
  it("resolves built-ins, namespaced names and falls back to generic", () => {
    expect(resolveTool("bash").title).toBe("Shell");
    expect(resolveTool("mcp__fs__read").title).toBe("Read");
    expect(resolveTool("write").title).toBe("Write");
    expect(resolveTool("totally_new").title).toBe("totally_new");
  });
  it("lets extensions register a renderer", () => {
    registerTool("my_tool", { icon: "wrench", title: "Mine" });
    expect(resolveTool("my_tool").title).toBe("Mine");
  });
});

describe("diff + search parsing", () => {
  it("parses the edit tool's diff string", () => {
    const lines = parsePiDiff(" 1 keep\n-2 old\n+2 new\n   ...\n 9 tail");
    expect(lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "gap", "ctx"]);
    expect(lines[1]).toMatchObject({ num: 2, text: "old" });
  });
  it("parses web_search output and rejects other text", () => {
    const r = parseSearchResults("1. Title A\n   https://a.dev/x\n   Published: 2026-01-02\n   snippet text\n\n2. B\n   https://b.dev");
    expect(r).toHaveLength(2);
    expect(r![0]).toMatchObject({ title: "Title A", url: "https://a.dev/x", date: "2026-01-02", snippet: "snippet text" });
    expect(parseSearchResults("No results for: x")).toBeNull();
  });
});

describe("feed derivation", () => {
  const work: ChatMessage["parts"] = [
    { type: "text", text: "On it." },
    tool({ id: "1", args: { command: "ls" }, output: "a" }),
    tool({ id: "2", name: "edit", args: { path: "/x/a.txt", edits: [{ oldText: "a", newText: "b" }] }, details: { diff: "-1 a\n+1 b" } }),
    { type: "text", text: "Done." },
  ];

  it("folds the middle of a settled turn and appends a files-changed card", () => {
    const rows = deriveFeed(turn(work), { busy: false, expanded: new Set() });
    expect(rows.map((r) => r.type)).toEqual(["message", "part", "fold", "part", "files"]);
    expect(rows[2]).toMatchObject({ label: "Worked for 42s", steps: 2 });
  });
  it("shows everything while the turn is live or when expanded", () => {
    expect(deriveFeed(turn(work), { busy: true, expanded: new Set() }).some((r) => r.type === "fold")).toBe(false);
    const open = deriveFeed(turn(work), { busy: false, expanded: new Set(["u"]) });
    const fold = open.find((r) => r.type === "fold");
    expect(fold).toMatchObject({ open: true });
    expect(fold && fold.type === "fold" && fold.rows).toHaveLength(2);
    expect(open.filter((r) => r.type === "part")).toHaveLength(2);
  });
  it("does not fold when the turn does not end with an answer", () => {
    const rows = deriveFeed(turn([{ type: "text", text: "hm" }, tool({})]), { busy: false, expanded: new Set() });
    expect(rows.some((r) => r.type === "fold")).toBe(false);
  });
});

describe("rendering", () => {
  it("fold toggles hidden tool rows; files card shows a diff", async () => {
    const user = userEvent.setup();
    const messages = turn([
      { type: "text", text: "On it." },
      tool({ id: "2", name: "edit", args: { path: "/x/a.txt" }, details: { diff: "-1 a\n+1 b" } }),
      { type: "text", text: "Done." },
    ]);
    render(<MessageList messages={messages} busy={false} />);
    expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /worked for 42s/i }));
    expect(screen.getByTestId("tool-card")).toHaveTextContent("a.txt");
    await user.click(screen.getByRole("button", { name: /1 changed file/i }));
    const section = screen.getByRole("region", { name: "Changed files" });
    await user.click(within(section).getByRole("button", { name: /a\.txt/ }));
    expect(within(section).getByRole("group", { name: /diff of \/x\/a\.txt/i })).toHaveTextContent("b");
  });

  it("edit tool body renders a diff and web_search renders result links", async () => {
    const user = userEvent.setup();
    render(
      <MessageList
        busy
        messages={[
          { id: "a", role: "assistant", parts: [
            tool({ id: "e", name: "edit", args: { path: "/p/f.ts" }, details: { diff: " 1 same\n-2 old\n+2 new" } }),
            tool({ id: "w", name: "web_search", args: { query: "pi" }, output: "1. Pi\n   https://pi.dev/docs\n   a snippet" }),
          ] },
        ]}
      />,
    );
    const [edit, search] = screen.getAllByTestId("tool-card");
    await user.click(within(edit).getByRole("button"));
    expect(within(edit).getByRole("group", { name: "edit diff" })).toHaveTextContent("new");
    await user.click(within(search).getByRole("button"));
    expect(within(search).getByRole("link", { name: /pi/i })).toHaveAttribute("href", "https://pi.dev/docs");
  });
});

describe("files card: Open diff", () => {
  const edits = () =>
    turn([
      { type: "text", text: "On it." },
      tool({ id: "2", name: "edit", args: { path: "/x/a.txt" }, details: { diff: "-1 a\n+1 b" } }),
      tool({ id: "3", name: "edit", args: { path: "/x/b.txt" }, details: { diff: "-1 c\n+1 d" } }),
      { type: "text", text: "Done." },
    ]);
  const turnKey = () => {
    const files = deriveFeed(edits(), { busy: false, expanded: new Set() }).find((r) => r.type === "files");
    if (files?.type !== "files") throw new Error("no files row");
    return files.turnKey;
  };

  it("with onOpenDiff: Open diff and file rows call back with (turnKey, path)", async () => {
    const user = userEvent.setup();
    const onOpenDiff = vi.fn();
    render(<MessageList messages={edits()} busy={false} onOpenDiff={onOpenDiff} />);
    const section = screen.getByRole("region", { name: "Changed files" });
    await user.click(within(section).getByRole("button", { name: "Open diff" }));
    expect(onOpenDiff).toHaveBeenLastCalledWith(turnKey(), "/x/a.txt");
    await user.click(within(section).getByRole("button", { name: /2 changed files/i }));
    await user.click(within(section).getByRole("button", { name: /b\.txt/ }));
    expect(onOpenDiff).toHaveBeenLastCalledWith(turnKey(), "/x/b.txt");
    expect(within(section).queryByRole("group", { name: /diff of/i })).not.toBeInTheDocument();
  });

  it("without onOpenDiff: no Open diff button, rows expand inline", async () => {
    const user = userEvent.setup();
    render(<MessageList messages={edits()} busy={false} />);
    const section = screen.getByRole("region", { name: "Changed files" });
    expect(within(section).queryByRole("button", { name: "Open diff" })).not.toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: /2 changed files/i }));
    await user.click(within(section).getByRole("button", { name: /b\.txt/ }));
    expect(within(section).getByRole("group", { name: /diff of \/x\/b\.txt/i })).toBeInTheDocument();
  });
});

describe("a long unbreakable line cannot widen the conversation", () => {
  // jsdom computes no layout, so the real guarantee (measured in a browser: scrollWidth 3326 -> 833 with a 1244-char shell
  // command) is pinned through the classes that produce it.
  it("the feed clips horizontal overflow, and an open fold row has a shrinkable column", async () => {
    const user = userEvent.setup();
    const long = "echo " + "x".repeat(1200);
    const messages = turn([{ type: "text", text: "On it." }, tool({ id: "1", args: { command: long } }), { type: "text", text: "Done." }]);
    render(<MessageList messages={messages} busy={false} />);
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(log).toHaveClass("overflow-y-auto", "overflow-x-hidden");
    await user.click(screen.getByRole("button", { name: /worked for/i }));
    const card = screen.getByTestId("tool-card");
    const collapse = card.closest(".grid");
    expect(collapse).not.toBeNull();
    expect(collapse!.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(collapse!.firstElementChild).toHaveClass("min-w-0");
  });
});

describe("Collapse via the fold row", () => {
  it("mounts folded rows on open and unmounts them after the close animation", async () => {
    const user = userEvent.setup();
    const messages = turn([{ type: "text", text: "On it." }, tool({ id: "1", args: { command: "ls" } }), { type: "text", text: "Done." }]);
    render(<MessageList messages={messages} busy={false} />);
    const fold = screen.getByRole("button", { name: /worked for/i });
    expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument();
    await user.click(fold);
    expect(screen.getByTestId("tool-card")).toBeInTheDocument();
    await user.click(fold);
    // jsdom runs no transitions, so the safety timer unmounts the content.
    await waitFor(() => expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument(), { timeout: 2000 });
  });
});
