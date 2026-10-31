// Session-search panel tests (docs/tasks/AMP13-search.md). Renders the real panel against a stubbed `fetch`
// (the api request layer is the real one — same-origin, JSON error handling), no real server needed.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionSearchPanel, searchPanel } from "../src/panels/search";
import type { PanelContext } from "../src/panels/types";
import type { BotSummary, ConversationVM } from "../src/types";

const bot = (id: string, name: string, workspaceId = "ws_1"): BotSummary => ({
  id,
  name,
  conversationId: id,
  model: { provider: "faux", modelId: "f1" },
  busy: false,
  queued: 0,
  workspaceId,
});

const vm = () => ({ messages: [], busy: false, inbox: [], usage: {}, agent: {}, compacting: 0, toolStash: {} }) as unknown as ConversationVM;

const ctxOf = (b: BotSummary | undefined): PanelContext => ({ bots: b ? [b] : [], bot: b, vm: vm() });

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const SEARCH = {
  results: [
    { botId: "src", botName: "source-bot", entryId: "42", role: "user", kind: "pi.user", snippet: "…the unique text…" },
  ],
  scanned: 7,
  truncated: false,
  sessionsScanned: 2,
};

const REF = { reference: { botId: "src", botName: "source-bot", entryId: "42", role: "user", kind: "pi.user", text: "the unique stored body" } };

describe("SessionSearchPanel", () => {
  const calls: { url: string; body?: unknown }[] = [];
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/search/reference?botId=src&entryId=42")) return json(REF);
      if (url.includes("/search/submit")) return json({ submissionId: 7, references: [{ botId: "src", botName: "source-bot", entryId: "42", role: "user" }] });
      if (url.includes("/search?")) return json(SEARCH);
      return json({ error: "not found" }, 404);
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("is a PanelDefinition and refuses bots without a workspace", () => {
    expect(searchPanel.id).toBe("search");
    const noWs = { ...bot("b", "b"), workspaceId: undefined };
    render(<SessionSearchPanel {...ctxOf(noWs)} />);
    expect(screen.getByText(/不属于任何工作区/)).toBeInTheDocument();
  });

  it("searches, shows results with source session, previews the real entry, then submits references to the current session", async () => {
    const user = userEvent.setup();
    render(<SessionSearchPanel {...ctxOf(bot("me", "my-bot"))} />);

    await user.type(screen.getByLabelText("搜索同工作区会话"), "unique text");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByText("…the unique text…")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/api/workspaces/ws_1/search?q=unique%20text"))).toBe(true);
    expect(screen.getByText(/扫描 7 条历史/)).toBeInTheDocument();

    // preview: the real stored entry text from the dedicated reference route
    await user.click(screen.getByRole("button", { name: "预览原文" }));
    expect(await screen.findByText("the unique stored body")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/search/reference?botId=src&entryId=42"))).toBe(true);

    // select the reference and send the user's own question to the CURRENT session
    await user.click(screen.getByLabelText("引用 source-bot 42"));
    const q = screen.getByLabelText("针对引用输入问题");
    await user.type(q, "what did it decide?");
    await user.click(screen.getByRole("button", { name: /发送问题 \+ 1 条引用/ }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/已发送到 “my-bot”/));
    const submit = calls.find((c) => c.url.includes("/search/submit"));
    expect(submit).toBeDefined();
    expect(submit?.body).toEqual({
      botId: "me",
      text: "what did it decide?",
      references: [{ botId: "src", entryId: "42" }],
    });
  });

  it("surfaces API errors and reports truncation", async () => {
    globalThis.fetch = vi.fn(async () => json({ error: "session is busy" }, 409)) as unknown as typeof globalThis.fetch;
    const user = userEvent.setup();
    render(<SessionSearchPanel {...ctxOf(bot("me", "my-bot"))} />);
    await user.type(screen.getByLabelText("搜索同工作区会话"), "x");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("session is busy");
  });

  it("links each result to its session via ?bot=", async () => {
    const user = userEvent.setup();
    render(<SessionSearchPanel {...ctxOf(bot("me", "my-bot"))} />);
    await user.type(screen.getByLabelText("搜索同工作区会话"), "x");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    const link = await screen.findByRole("link", { name: "source-bot" });
    expect(link).toHaveAttribute("href", expect.stringContaining("?bot=src"));
  });
});
