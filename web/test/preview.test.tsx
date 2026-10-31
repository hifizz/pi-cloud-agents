import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { previewPanel } from "../src/panels/preview";
import type { PanelContext } from "../src/panels/types";
import { emptyVM } from "../src/lib/reducer";
import type { BotSummary } from "../src/types";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "session",
  conversationId: 1,
  model: { provider: "faux", modelId: "faux-1" },
  busy: false,
  queued: 0,
  workspaceId: "w1",
  ...over,
});

const ctxOf = (extra: Partial<PanelContext> = {}): PanelContext => ({ bots: [], vm: emptyVM(), ...extra });

type Call = { method: string; path: string };
function fakeFetch(handler: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const call: Call = { method: (init as RequestInit | undefined)?.method ?? "GET", path: url.pathname + url.search };
    calls.push(call);
    return (await handler(call)) ?? new Response(JSON.stringify({ error: `unexpected ${call.method} ${call.path}` }), { status: 404 });
  });
  return calls;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** Server-minted cap URL the panel is handed back; iframe + new-tab use it verbatim. */
const capUrl = (workspaceId: string, port: number) => `/api/workspaces/${workspaceId}/preview/${port}/cap-TESTCAP/`;
const capReply = (workspaceId: string) => json({ token: "TESTCAP", exp: Date.now() + 900_000, url: capUrl(workspaceId, 3000), ttlMs: 900_000 });

afterEach(() => vi.restoreAllMocks());

describe("previewPanel", () => {
  it("idle shows the port form; a listening port mints a cap and opens the sandboxed iframe at the cap URL", async () => {
    const user = userEvent.setup();
    const calls = fakeFetch((c) => {
      if (c.path === "/api/workspaces/w1/preview?port=3000") return json({ workspaceId: "w1", ports: [3000], up: true });
      if (c.method === "POST" && c.path === "/api/workspaces/w1/preview/token") return capReply("w1");
      return undefined;
    });
    render(<previewPanel.Component {...ctxOf({ bot: bot() })} />);
    expect(screen.getByLabelText("端口")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开预览" }));
    await waitFor(() => expect(screen.getByTitle("预览 :3000")).toBeInTheDocument());
    const frame = screen.getByTitle("预览 :3000") as HTMLIFrameElement;
    // The frame loads the CAP-URL — the opaque sandbox does not send the session cookie; the path cap carries auth.
    expect(frame.src).toContain(capUrl("w1", 3000));
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/workspaces/w1/preview/token")).toBe(true);
  });

  it("a port with nothing listening shows 无服务, never a stale frame", async () => {
    const user = userEvent.setup();
    fakeFetch((c) => (c.path.includes("/preview?port=3000") ? json({ workspaceId: "w1", ports: [], up: false, reason: "no_service" }) : undefined));
    render(<previewPanel.Component {...ctxOf({ bot: bot() })} />);
    await user.click(screen.getByRole("button", { name: "打开预览" }));
    await waitFor(() => expect(screen.getByText(/无服务/)).toBeInTheDocument());
    expect(screen.queryByTitle(/预览 :/)).not.toBeInTheDocument();
  });

  it("a server/probe error is visible and never silently up", async () => {
    const user = userEvent.setup();
    fakeFetch((c) => (c.path.includes("/preview?port=3000") ? json({ error: "workspace is not ready (status: preparing)" }, 409) : undefined));
    render(<previewPanel.Component {...ctxOf({ bot: bot() })} />);
    await user.click(screen.getByRole("button", { name: "打开预览" }));
    await waitFor(() => expect(screen.getByText(/not ready|失败|错误/i)).toBeInTheDocument());
    expect(screen.queryByTitle(/预览 :/)).not.toBeInTheDocument();
  });

  it("no bot selected and no workspace -> the panel says so, it does not guess", () => {
    render(<previewPanel.Component {...ctxOf()} />);
    expect(screen.getByText(/选择一个会话/)).toBeInTheDocument();
  });

  it("a bot with a workspaceId uses it without needing a selected workspace context", async () => {
    const user = userEvent.setup();
    fakeFetch((c) => {
      if (c.path === "/api/workspaces/w9/preview?port=5173") return json({ workspaceId: "w9", ports: [5173], up: true });
      if (c.method === "POST" && c.path === "/api/workspaces/w9/preview/token") {
        return json({ token: "TESTCAP", exp: Date.now() + 900_000, url: "/api/workspaces/w9/preview/5173/cap-TESTCAP/", ttlMs: 900_000 });
      }
      return undefined;
    });
    render(<previewPanel.Component {...ctxOf({ bot: bot({ workspaceId: "w9" }), bots: [] })} />);
    const input = screen.getByLabelText("端口");
    await user.clear(input);
    await user.type(input, "5173");
    await user.click(screen.getByRole("button", { name: "打开预览" }));
    await waitFor(() => expect(screen.getByTitle("预览 :5173")).toBeInTheDocument());
  });
});
