// Workspace home (web/src/home/WorkspaceHome.tsx): the six summary cards over the workspace's real APIs.
// Covers event ordering (server record is unshift-ordered, newest first), per-source failure/retry states
// (a failed source is never rendered as empty/0 or stuck on "loading"), and the summary refresh after a
// drawer surface mutates data and closes.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceHome, type HomeDrawer } from "../src/home/WorkspaceHome";
import { WorkspaceContext, type Workspace } from "../src/lib/workspaces";
import type { BotSummary } from "../src/types";
import type { EventsSyncState, SyncEvent } from "../src/panels/events";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  name: "home ws",
  repo: "hifizz/demo",
  baseBranch: "main",
  branch: "tarsbot/home-1",
  status: "ready",
  steps: [],
  botId: "b1",
  binding: { provider: "sprites", runtimeId: "pca-0123456789abcdef", version: 1 },
  ...over,
});

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "primary",
  conversationId: 1,
  model: { provider: "faux", modelId: "faux-1" },
  busy: false,
  queued: 0,
  workspaceId: "w1",
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}
type Handler = (call: Call) => Response | Promise<Response> | undefined;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const call: Call = {
      method: (init as RequestInit | undefined)?.method ?? "GET",
      path: url.pathname + url.search,
      body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
    };
    calls.push(call);
    return (await handler(call)) ?? json({ error: `unexpected ${call.method} ${call.path}` }, 404);
  });
  return calls;
}

const eventsState = (over: Partial<EventsSyncState> = {}): EventsSyncState => ({
  enabled: true,
  autoCreate: false,
  autoAppend: false,
  lastSyncAt: "2026-01-01T02:00:00Z",
  nextSyncAt: null,
  pollSec: 60,
  lastError: null,
  lastResult: null,
  baseline: null,
  prChecks: [],
  subscriptions: [],
  record: [],
  ...over,
});

const comment = (id: string, title: string): SyncEvent => ({
  id,
  kind: "comment",
  number: 7,
  title,
  url: null,
  actor: "alice",
  at: "2026-01-01T02:00:00Z",
  isPr: false,
  outcome: "seen",
});

const baseHandler: Handler = (c) => {
  if (c.path === "/api/workspaces/w1/overview?prs=all") return json({ issues: [], pulls: [] });
  if (c.path === "/api/workspaces/w1/loops") return json([]);
  if (c.path === "/api/workspaces/w1/events") return json(eventsState());
  if (c.path === "/api/workspaces/w1/integrations") return json({ installs: [] });
  if (c.path === "/api/routines") return json([]);
  return undefined;
};

function renderHome(bots: BotSummary[] = [bot()], workspace = ws()) {
  function Wrapper() {
    const [drawer, setDrawer] = useState<HomeDrawer>();
    return (
      <WorkspaceContext.Provider value={{ workspace, loading: false, onUpdate: () => {}, onChanged: () => {} }}>
        <WorkspaceHome
          workspace={workspace}
          railOpen
          bots={bots}
          onExpandRail={() => {}}
          onOpenIssue={async () => {}}
          onOpenSession={() => {}}
          onReview={async () => {}}
          onOpenLoops={() => {}}
          onOpenLoopRuns={() => {}}
          drawer={drawer}
          onDrawerChange={setDrawer}
        />
      </WorkspaceContext.Provider>
    );
  }
  return render(<Wrapper />);
}

describe("WorkspaceHome", () => {
  it("shows eight issues and PRs; a PR title and view-all open bottom sheets", async () => {
    const user = userEvent.setup();
    fakeFetch((c) => {
      if (c.path === "/api/workspaces/w1/overview?prs=all") return json({
        issues: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}` })),
        pulls: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, state: "open", url: `https://github.com/example/repo/pull/${i + 1}` })),
      });
      return baseHandler(c);
    });
    renderHome();
    const issues = screen.getByTestId("home-issues");
    expect(await within(issues).findByText("Issue 8")).toBeInTheDocument();
    expect(within(issues).queryByText("Issue 9")).toBeNull();
    const pulls = screen.getByTestId("home-pulls");
    expect(await within(pulls).findByRole("button", { name: "PR 8" })).toBeInTheDocument();
    expect(within(pulls).queryByText("PR 9")).toBeNull();
    await user.click(within(pulls).getByRole("button", { name: "PR 8" }));
    const sheet = await screen.findByTestId("drawer-pulls");
    expect(sheet).toHaveAttribute("data-side", "bottom");
    expect(within(sheet).getByRole("link", { name: "PR 8" })).toHaveAttribute("href", "https://github.com/example/repo/pull/8");
    expect(sheet.querySelector('[data-selected="true"]')).toHaveTextContent("PR 8");
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("open-pulls"));
    expect(await screen.findByTestId("drawer-pulls")).toHaveAttribute("data-side", "bottom");
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("open-issues"));
    expect(await screen.findByTestId("drawer-issues")).toHaveAttribute("data-side", "bottom");
  });

  it("the Events card lists the record's head — the newest 4 in server order — not the tail", async () => {
    // Server record() unshifts, so record[0] is the newest entry. Six entries, newest first.
    const record = ["n6", "n5", "n4", "n3", "n2", "n1"].map((id) => comment(id, `title-${id}`));
    fakeFetch((c) => {
      if (c.path === "/api/workspaces/w1/events") return json(eventsState({ record }));
      return baseHandler(c);
    });
    renderHome();
    const card = await screen.findByTestId("home-events");
    await within(card).findByText(/title-n6/);
    const text = card.textContent!;
    for (const id of ["n6", "n5", "n4", "n3"]) expect(text).toContain(`title-${id}`);
    for (const id of ["n2", "n1"]) expect(text).not.toContain(`title-${id}`);
    // order preserved: newest first
    expect(text.indexOf("title-n6")).toBeLessThan(text.indexOf("title-n3"));
    expect(card).toHaveTextContent("6");
  });

  it("a failed source shows 加载失败 + 重试 inside its own card and never fakes empty/0; retry re-fetches that source", async () => {
    const user = userEvent.setup();
    let eventsCalls = 0;
    const calls = fakeFetch((c) => {
      if (c.path === "/api/workspaces/w1/events") {
        eventsCalls += 1;
        return eventsCalls === 1 ? json({ error: "events down" }, 500) : json(eventsState());
      }
      if (c.path === "/api/routines") return json({ error: "routines down" }, 500);
      return baseHandler(c);
    });
    renderHome();
    const eventsCard = await screen.findByTestId("home-events");
    expect(await within(eventsCard).findByRole("alert")).toHaveTextContent("加载失败");
    // no fake state: the badge and the disabled-hint never render on failure
    expect(within(eventsCard).queryByText("已启用")).toBeNull();
    expect(within(eventsCard).queryByText("尚无事件记录")).toBeNull();
    const routinesCard = screen.getByTestId("home-routines");
    expect(await within(routinesCard).findByRole("alert")).toHaveTextContent("加载失败");
    expect(within(routinesCard).queryByText(/没有 routine/)).toBeNull();
    // healthy sources still render normally
    const issuesCard = screen.getByTestId("home-issues");
    expect(await within(issuesCard).findByText("没有未解决的 issue。")).toBeInTheDocument();
    // retry re-fetches only that source
    await user.click(within(eventsCard).getByRole("button", { name: "重试" }));
    expect(await within(eventsCard).findByText("已启用")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/workspaces/w1/events")).toHaveLength(2);
  });

  it("an overview failure leaves Issues/PR counts unset (no phantom 0)", async () => {
    fakeFetch((c) => {
      if (c.path === "/api/workspaces/w1/overview?prs=all") return json({ error: "overview down" }, 500);
      return baseHandler(c);
    });
    renderHome();
    const issues = await screen.findByTestId("home-issues");
    expect(await within(issues).findByRole("alert")).toHaveTextContent("加载失败");
    const pulls = screen.getByTestId("home-pulls");
    expect(await within(pulls).findByRole("alert")).toHaveTextContent("加载失败");
    // headers show no count digit for the failed source (overview feeds both cards)
    expect(within(issues).queryByText(/^\d+$/)).toBeNull();
  });

  it("closing the routines drawer refreshes the summaries (listRoutines re-fetched)", async () => {
    const user = userEvent.setup();
    const calls = fakeFetch(baseHandler);
    renderHome();
    await screen.findByTestId("home-routines");
    const routineGets = () => calls.filter((c) => c.path === "/api/routines" && c.method === "GET").length;
    await waitFor(() => expect(routineGets()).toBe(1));
    // open the drawer: the embedded RoutinesPanel fetches its own list on mount
    await user.click(screen.getByTestId("open-routines"));
    await screen.findByTestId("drawer-routines");
    await waitFor(() => expect(routineGets()).toBeGreaterThanOrEqual(2));
    const before = routineGets();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(routineGets()).toBeGreaterThan(before));
  });
});
