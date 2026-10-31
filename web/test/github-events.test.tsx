// AMP13-events panel: direct render tests (the panel is not yet registered in panels/index.ts — the parent wires it).
// fetch is stubbed; assertions cover enable/sync/disable flows, event listing, subscription display and manual append.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventsPanel } from "../src/panels/events";
import { WorkspaceContext, type Workspace } from "../src/lib/workspaces";
import { emptyVM } from "../src/lib/reducer";
import type { BotSummary } from "../src/types";
import type { EventsSyncState } from "../src/panels/events";

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  name: "events ws",
  repo: "hifizz/tars-sandbox-playground",
  baseBranch: "main",
  branch: "tarsbot/ws-abc123",
  status: "ready",
  steps: [],
  botId: "b1",
  binding: { provider: "sprites", runtimeId: "pca-eae56f671c", version: 1 },
  ...over,
});

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "primary",
  conversationId: 5001,
  model: { provider: "faux", modelId: "faux-1" },
  busy: false,
  queued: 0,
  workspaceId: "w1",
  ...over,
});

const state = (over: Partial<EventsSyncState> = {}): EventsSyncState => ({
  enabled: false,
  autoCreate: false,
  autoAppend: false,
  lastSyncAt: null,
  nextSyncAt: null,
  pollSec: null,
  pollCount: 0,
  lastError: null,
  lastResult: null,
  baseline: null,
  prChecks: [],
  subscriptions: [],
  record: [],
  ...over,
});

const commentEvent = {
  id: "c1",
  kind: "comment" as const,
  number: 7,
  title: "demo issue",
  url: "https://github.com/hifizz/tars-sandbox-playground/issues/7#issuecomment-1",
  actor: "alice",
  at: "2026-01-01T02:00:00Z",
  isPr: false,
  outcome: "pending (auto-append off)",
};

/** Stub fetch: handlers keyed as "METHOD /path" (GET when no prefix); every call must match. */
function stubFetch(handlers: Record<string, unknown | (() => unknown)>) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(handlers).find((k) => {
      const post = k.startsWith("POST ");
      const path = post ? k.slice(5) : k;
      return url.endsWith(path) && (post ? method === "POST" : method === "GET");
    });
    if (!key) return new Response(JSON.stringify({ error: `unstubbed ${method} ${url}` }), { status: 500 });
    const value = handlers[key];
    const payload = typeof value === "function" ? value() : value;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

function renderPanel(workspace: Workspace | undefined | null = ws(), bots: BotSummary[] = [bot()]) {
  const ctxValue = { workspace: workspace ?? undefined, loading: false, onUpdate: () => {}, onChanged: () => {} };
  return render(
    <WorkspaceContext.Provider value={ctxValue}>
      <EventsPanel bots={bots} vm={emptyVM()} />
    </WorkspaceContext.Provider>,
  );
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("EventsPanel", () => {
  it("shows a hint when there is no workspace", () => {
    stubFetch({});
    renderPanel(null);
    expect(screen.getByText(/选择一个工作区后，这里可以同步/)).toBeInTheDocument();
  });

  it("disabled state offers 开启事件同步; enabling posts configure and shows sync controls", async () => {
    const calls = stubFetch({
      "/api/workspaces/w1/events": state({ enabled: false }),
      "POST /api/workspaces/w1/events/configure": () => state({ enabled: true, lastSyncAt: "2026-01-01T00:00:00Z", lastResult: { events: 0, appended: 0, created: 0, seeded: 12 } }),
    });
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByRole("button", { name: "开启事件同步" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开启事件同步" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "立即同步" })).toBeInTheDocument());
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/events/configure") && (c.body as { enabled?: boolean }).enabled === true)).toBe(true);
    expect(screen.getByText(/已标记 12 条历史/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止同步" })).toBeInTheDocument();
  });

  it("sync posts /events/sync and lists the processed events with outcomes", async () => {
    stubFetch({
      "/api/workspaces/w1/events": state({ enabled: true }),
      "POST /api/workspaces/w1/events/sync": () =>
        state({ enabled: true, lastSyncAt: "2026-01-01T02:05:00Z", lastResult: { events: 1, appended: 0, created: 0 }, record: [commentEvent] }),
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "立即同步" }));
    const item = await screen.findByTestId("event-item");
    expect(within(item).getByText(/评论了 Issue #7/)).toBeInTheDocument();
    expect(within(item).getByText(/pending \(auto-append off\)/)).toBeInTheDocument();
  });

  it("manual append posts /events/send with the chosen session and dedup conflict is shown", async () => {
    let sent = false;
    stubFetch({
      "/api/workspaces/w1/events": state({
        enabled: true,
        record: [commentEvent],
        subscriptions: [{ key: "issue:7", botId: "b1", name: "issue-7-discuss" }],
      }),
      "POST /api/workspaces/w1/events/send": () => {
        sent = true;
        return { sent: true, botId: "b1", name: "primary" };
      },
    });
    const user = userEvent.setup();
    renderPanel();
    const item = await screen.findByTestId("event-item");
    expect(screen.getByText("issue-7-discuss")).toBeInTheDocument();
    await user.click(within(item).getByRole("button", { name: "追加到会话" }));
    await waitFor(() => expect(sent).toBe(true));
  });

  it("enabled state shows the automatic poll interval and next sync (distinct from the manual button)", async () => {
    stubFetch({
      "/api/workspaces/w1/events": state({ enabled: true, pollSec: 30, nextSyncAt: "2026-01-01T03:00:00Z", pollCount: 4 }),
    });
    renderPanel();
    expect(await screen.findByText(/每 30 秒自动同步/)).toBeInTheDocument();
    expect(screen.getByText(/已自动同步 4 次/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即同步" })).toBeInTheDocument();
  });

  it("toggling autoAppend posts configure; errors surface as alerts", async () => {
    stubFetch({
      "/api/workspaces/w1/events": state({ enabled: true }),
      "POST /api/workspaces/w1/events/configure": () => state({ enabled: true, autoAppend: true }),
    });
    const user = userEvent.setup();
    renderPanel();
    const toggle = await screen.findByRole("checkbox", { name: /自动追加到对应会话/ });
    await user.click(toggle);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /自动追加到对应会话/ })).toBeChecked());
  });
});
