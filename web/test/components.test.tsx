import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageList } from "../src/components/Chat/MessageList";
import { Composer } from "../src/components/Chat/Composer";
import { BotList } from "../src/components/BotList";
import { UsageBadge } from "../src/components/UsageBadge";
import type { ChatMessage } from "../src/types";

const messages: ChatMessage[] = [
  { id: "e1", role: "user", parts: [{ type: "text", text: "list files" }] },
  {
    id: "e2",
    role: "assistant",
    parts: [
      { type: "thinking", text: "secret reasoning" },
      { type: "text", text: "Here is **bold** text\n\n| a | b |\n|---|---|\n| 1 | 2 |" },
      { type: "tool", id: "c1", name: "bash", args: { command: "ls -la" }, status: "done", output: "notes.txt\n", resultText: "notes.txt\n" },
    ],
  },
];

describe("MessageList", () => {
  it("renders user text, markdown (GFM), collapsed thinking and a tool card", async () => {
    const user = userEvent.setup();
    render(<MessageList messages={messages} busy={false} />);

    expect(screen.getByText("list files")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toBeInTheDocument(); // GFM table

    // thinking collapsed by default
    expect(screen.queryByText("secret reasoning")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /thought/i }));
    expect(screen.getByText("secret reasoning")).toBeInTheDocument();

    // tool card: header visible, output hidden until expanded
    const card = screen.getByTestId("tool-card");
    expect(card).toHaveTextContent("Shell");
    expect(card).toHaveTextContent("ls -la");
    expect(card).toHaveTextContent("done");
    expect(screen.queryByLabelText("bash output")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /shell/i }));
    expect(screen.getByLabelText("bash output")).toHaveTextContent("notes.txt");
  });

  it("truncates very long tool output with a 'Show all' control", async () => {
    const user = userEvent.setup();
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    render(
      <MessageList
        busy={false}
        messages={[{ id: "a", role: "assistant", parts: [{ type: "tool", id: "x", name: "bash", args: {}, status: "done", output: long }] }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /shell/i }));
    expect(screen.getByLabelText("bash output")).not.toHaveTextContent("line 499");
    await user.click(screen.getByRole("button", { name: /show all 500 lines/i }));
    expect(screen.getByLabelText("bash output")).toHaveTextContent("line 499");
  });

  it("shows image results as an enlargeable thumbnail", async () => {
    const user = userEvent.setup();
    render(
      <MessageList
        busy={false}
        messages={[
          {
            id: "a",
            role: "assistant",
            parts: [{ type: "tool", id: "x", name: "desktop_screenshot", args: {}, status: "done", output: "", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }],
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /enlarge image/i }));
    expect(screen.getByRole("dialog", { name: /image preview/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders status badges for running / interrupted tools and system notes", () => {
    render(
      <MessageList
        busy
        messages={[
          { id: "a", role: "assistant", parts: [{ type: "tool", id: "1", name: "slow", args: {}, status: "running", output: "" }, { type: "tool", id: "2", name: "cut", args: {}, status: "interrupted", output: "" }] },
          { id: "s", role: "system", parts: [{ type: "text", text: "Task failed (x): nope" }] },
        ]}
      />,
    );
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("interrupted")).toBeInTheDocument();
    expect(screen.getByText(/Task failed/)).toBeInTheDocument();
  });
});

describe("Composer", () => {
  it("idle: shows Send only; Enter sends, Shift+Enter inserts a newline", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} onAbort={() => {}} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();

    const box = screen.getByLabelText("Message");
    await user.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("line1\nline2");
    await user.type(box, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("line1\nline2", "send");
    expect(box).toHaveValue("");
  });

  it("busy: shows Steer, Queue and Abort; Enter steers", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onAbort = vi.fn();
    render(<Composer busy onSend={onSend} onAbort={onAbort} />);
    expect(screen.getByRole("button", { name: "Steer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Message"), "change course{Enter}");
    expect(onSend).toHaveBeenLastCalledWith("change course", "steer");
    await user.type(screen.getByLabelText("Message"), "later");
    await user.click(screen.getByRole("button", { name: "Queue" }));
    expect(onSend).toHaveBeenLastCalledWith("later", "followUp");
    await user.click(screen.getByRole("button", { name: "Abort" }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("does not send empty input and keeps the draft when sending fails", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockRejectedValue(new Error("boom"));
    render(<Composer busy={false} onSend={onSend} onAbort={() => {}} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(screen.getByLabelText("Message"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "keep me{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Message")).toHaveValue("keep me");
  });
});

describe("BotList / UsageBadge", () => {
  it("lists bots with busy/idle state and creates a bot from the form", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onSelect = vi.fn();
    const bots = [
      { id: "b1", name: "alice", conversationId: 1, model: { provider: "tokenrouter", modelId: "glm-5.3" }, busy: true, queued: 2 },
      { id: "b2", name: "bob", conversationId: 2, model: { provider: "tokenrouter", modelId: "glm-5.3" }, busy: false, queued: 0 },
    ];
    render(<BotList bots={bots} selectedId="b1" onSelect={onSelect} onCreate={onCreate} />);
    expect(screen.getByRole("img", { name: "busy" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "idle" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /bob/ }));
    expect(onSelect).toHaveBeenCalledWith("b2");

    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(screen.getByLabelText("Name"), "carol");
    await user.selectOptions(screen.getByLabelText("Model"), "gpt-5.6-terra");
    await user.type(screen.getByLabelText(/Instructions/), "be brief");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith({ name: "carol", modelId: "gpt-5.6-terra", instructions: "be brief" });
  });

  it("formats usage", () => {
    render(<UsageBadge usage={{ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12345, cost: 0.0123 }} />);
    expect(screen.getByText("12.3k tok · $0.01")).toBeInTheDocument();
  });
});
