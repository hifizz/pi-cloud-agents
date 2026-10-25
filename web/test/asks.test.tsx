import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskBar } from "../src/components/AskBar";
import { parseAsksFrame } from "../src/lib/asks";
import type { AskItem } from "../src/types";

afterEach(() => vi.restoreAllMocks());

const item = (over: Partial<AskItem> = {}): AskItem => ({
  id: "a1",
  conversationId: "1",
  question: "Which repo should I watch?",
  options: ["tars", "playground"],
  askedAt: "2026-10-24T00:00:00.000Z",
  ...over,
});

describe("parseAsksFrame", () => {
  it("parses a full-replacement asks frame", () => {
    const items = parseAsksFrame(JSON.stringify({ type: "asks", items: [{ ...item(), id: 9, options: ["yes"] }] }));
    expect(items).toHaveLength(1);
    expect(items![0]).toMatchObject({ id: "9", question: "Which repo should I watch?", options: ["yes"] });
  });

  it("ignores non-asks frames", () => {
    expect(parseAsksFrame(JSON.stringify({ type: "approvals", items: [] }))).toBeUndefined();
    expect(parseAsksFrame("not json")).toBeUndefined();
  });
});

describe("AskBar", () => {
  it("renders nothing without items", () => {
    const { container } = render(<AskBar items={[]} onAnswer={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the question, option buttons and answers on click", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<AskBar items={[item()]} onAnswer={onAnswer} />);
    expect(screen.getAllByTestId("ask-item")).toHaveLength(1);
    expect(screen.getByText(/Which repo should I watch\?/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "tars" }));
    expect(onAnswer).toHaveBeenCalledWith("a1", "tars");
  });

  it("keeps the item and shows the message when answering rejects", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockRejectedValue(new Error("gone"));
    render(<AskBar items={[item()]} onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "playground" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("gone");
    expect(screen.getByTestId("ask-item")).toBeInTheDocument();
  });
});
