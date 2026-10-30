import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mapBotsToWorkspaces, type Workspace } from "../src/lib/workspaces";
import { BotList } from "../src/components/BotList";
import { SessionHeader } from "../src/shell/SessionHeader";
import { emptyVM } from "../src/lib/reducer";
import type { BotSummary } from "../src/types";

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  name: "issue-loop ws",
  repo: "hifizz/tars-sandbox-playground",
  baseBranch: "main",
  baseCommit: "3157db095cb9344e5b9cf0669657bf613d036b46",
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
  conversationId: 5000,
  model: { provider: "faux", modelId: "faux-1" },
  busy: false,
  queued: 0,
  ...over,
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("issue-loop: direct workspace association", () => {
  it("a session that carries workspaceId belongs to that workspace without being a fork", () => {
    const discussion = bot({ id: "d1", name: "issue-12-discuss", workspaceId: "w1", issueLoop: { issue: 12, baseBranch: "main", pinnedSha: "3157db09".padEnd(40, "0"), dir: "/home/sprite/issue-loop/w1/discussion-x" } });
    const map = mapBotsToWorkspaces([bot(), discussion], [ws()]);
    expect(map.get("b1")).toBe("w1");
    expect(map.get("d1")).toBe("w1");
    // not a fork: no parent needed to associate
    expect(discussion.parent).toBeUndefined();
  });

  it("fork ancestry still resolves when there is no direct workspaceId", () => {
    const fork = bot({ id: "f1", name: "fork", parent: { botId: "b1" } });
    const map = mapBotsToWorkspaces([bot(), fork], [ws()]);
    expect(map.get("f1")).toBe("w1");
  });

  it("a workspaceId pointing at an unknown workspace does not associate", () => {
    const stray = bot({ id: "s1", name: "stray", workspaceId: "other-ws" });
    const map = mapBotsToWorkspaces([bot(), stray], [ws()]);
    expect(map.has("s1")).toBe(false);
  });
});

describe("issue-loop: session header git state", () => {
  const renderHeader = (b: BotSummary) =>
    render(
      <SessionHeader
        bot={b}
        vm={emptyVM()}
        status="open"
        workspace={ws()}
        bots={[b]}
        railOpen
        panelOpen={false}
        onExpandRail={vi.fn()}
        onTogglePanel={vi.fn()}
        onCompact={vi.fn()}
        onReset={vi.fn()}
      />,
    );

  it("a detached discussion shows its pinned commit, not the workspace feature branch", () => {
    renderHeader(
      bot({ id: "d1", name: "discuss", issueLoop: { issue: 12, baseBranch: "main", pinnedSha: "3157db095cb9344e5b9cf0669657bf613d036b46", dir: "/d" } }),
    );
    const branch = screen.getByTestId("header-branch");
    expect(branch).toHaveTextContent("detached @ 3157db0");
    expect(branch).not.toHaveTextContent("tarsbot/ws-abc123");
    expect(screen.queryByTestId("backlink-to-discussion")).toBeNull();
  });

  it("an execution session shows its own branch and the grey backlink to its source discussion", async () => {
    const source = bot({ id: "d1", name: "issue-12-discuss" });
    const exec = bot({
      id: "e1",
      name: "issue-12-exec",
      issueLoop: { issue: 12, baseBranch: "main", pinnedSha: "3157db095cb9344e5b9cf0669657bf613d036b46", dir: "/e", branch: "tarsbot/issue-12-d1", sourceBotId: "d1" },
    });
    const onSelectBot = vi.fn();
    render(
      <SessionHeader
        bot={exec}
        vm={emptyVM()}
        status="open"
        workspace={ws()}
        bots={[source, exec]}
        onSelectBot={onSelectBot}
        railOpen
        panelOpen={false}
        onExpandRail={vi.fn()}
        onTogglePanel={vi.fn()}
        onCompact={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTestId("header-branch")).toHaveTextContent("tarsbot/issue-12-d1");
    const back = screen.getByTestId("backlink-to-discussion");
    expect(back).toHaveTextContent("来自讨论：issue-12-discuss");
    await userEvent.click(back);
    expect(onSelectBot).toHaveBeenCalledWith("d1");
  });
});

describe("issue-loop: environment pane", () => {
  it("an issue-loop session shows its own worktree and git state, and hides the workspace PR/checkpoint/rebuild actions", async () => {
    const { EnvironmentPane } = await import("../src/components/EnvironmentPane");
    const { WorkspaceContext } = await import("../src/lib/workspaces");
    const discussion = bot({
      id: "d1",
      name: "issue-12-discuss",
      issueLoop: { issue: 12, baseBranch: "main", pinnedSha: "3157db095cb9344e5b9cf0669657bf613d036b46", dir: "/home/sprite/issue-loop/w1/discussion-x" },
    });
    render(
      <WorkspaceContext.Provider value={{ workspace: ws(), loading: false, onUpdate: vi.fn(), onChanged: vi.fn() }}>
        <EnvironmentPane bot={discussion} vm={{ agent: {} }} />
      </WorkspaceContext.Provider>,
    );
    expect(screen.getByText("会话目录")).toBeInTheDocument();
    expect(screen.getByText("/home/sprite/issue-loop/w1/discussion-x")).toBeInTheDocument();
    expect(screen.getByText("detached @ 3157db0")).toBeInTheDocument();
    expect(screen.queryByText("工作分支")).toBeNull(); // the workspace feature branch is not shown as this session's state
    expect(screen.queryByRole("region", { name: "工作区操作" })).toBeNull(); // PR / checkpoint / rebuild hidden
  });

  it("a normal session still shows the workspace branch and the workspace actions", async () => {
    const { EnvironmentPane } = await import("../src/components/EnvironmentPane");
    const { WorkspaceContext } = await import("../src/lib/workspaces");
    const normal = bot({ id: "b1", name: "primary" });
    render(
      <WorkspaceContext.Provider value={{ workspace: ws(), loading: false, onUpdate: vi.fn(), onChanged: vi.fn() }}>
        <EnvironmentPane bot={normal} vm={{ agent: {} }} />
      </WorkspaceContext.Provider>,
    );
    expect(screen.getByText("工作分支")).toBeInTheDocument();
    expect(screen.getByText("tarsbot/ws-abc123")).toBeInTheDocument();
  });
});

describe("add session (SPIKE-add-session): workspace menu", () => {
  it("the ⋯ menu offers 添加 Session, opens an in-page name form defaulting to 新 Session, and creates the session with the typed name", async () => {
    const user = userEvent.setup();
    const onSessionAdded = vi.fn();
    const addCalls: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      addCalls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(
        JSON.stringify({ session: { botId: "new1", name: "研究 Session", conversationId: 9001, workspaceId: "w1", baseBranch: "main", pinnedSha: "3157db095cb9344e5b9cf0669657bf613d036b46", dir: "/home/sprite/sessions/w1/session-ab12cd34" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    render(
      <BotList
        workspaces={[ws()]}
        bots={[bot()]}
        selectedWorkspaceId="w1"
        selectedBotId="b1"
        onSelectWorkspace={vi.fn()}
        onSelectBot={vi.fn()}
        onNewWorkspace={vi.fn()}
        onSessionAdded={onSessionAdded}
      />,
    );
    // the ⋯ button is a sibling of the row button, never nested inside it (a button cannot contain a button)
    const more = screen.getByRole("button", { name: "更多操作" });
    const row = screen.getByRole("button", { name: /issue-loop ws/ });
    expect(row.contains(more)).toBe(false);
    // no ancestor of the ⋯ button is a button (closest() counts the element itself, so start from its parent)
    expect(more.parentElement?.closest("button")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "添加 Session" })).toBeNull();
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "添加 Session" }));

    // in-page dialog, not a native prompt
    const dialog = screen.getByRole("dialog", { name: "添加 Session" });
    const input = screen.getByLabelText("名称");
    expect(input).toHaveValue("新 Session");
    await user.clear(input);
    await user.type(input, "研究 Session");
    await user.click(screen.getByRole("button", { name: "创建" }));

    // exactly one POST to the add route with the typed name; the caller selects the new session
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].url).toBe("/api/workspaces/w1/sessions");
    expect(addCalls[0].body).toEqual({ name: "研究 Session" });
    expect(onSessionAdded).toHaveBeenCalledWith("w1", "new1");
    expect(dialog).not.toBeInTheDocument();
  });

  it("a manual session shows its own detached SHA and directory, offers no publish button, and hides the workspace PR/checkpoint actions", async () => {
    const { EnvironmentPane } = await import("../src/components/EnvironmentPane");
    const { WorkspaceContext } = await import("../src/lib/workspaces");
    const manual = bot({
      id: "m1",
      name: "研究 Session",
      workspaceId: "w1",
      worktree: { baseBranch: "main", pinnedSha: "3157db095cb9344e5b9cf0669657bf613d036b46", dir: "/home/sprite/sessions/w1/session-ab12cd34" },
    });
    render(
      <WorkspaceContext.Provider value={{ workspace: ws(), loading: false, onUpdate: vi.fn(), onChanged: vi.fn() }}>
        <EnvironmentPane bot={manual} vm={{ agent: {} }} />
      </WorkspaceContext.Provider>,
    );
    expect(screen.getByText("/home/sprite/sessions/w1/session-ab12cd34")).toBeInTheDocument();
    expect(screen.getByText("detached @ 3157db0")).toBeInTheDocument();
    expect(screen.queryByText("工作分支")).toBeNull();
    expect(screen.queryByRole("region", { name: "工作区操作" })).toBeNull();
  });

  it("the header of a manual session shows its own detached commit, not the workspace feature branch", () => {
    const manual = bot({
      id: "m1",
      name: "研究 Session",
      worktree: { baseBranch: "main", pinnedSha: "3157db095cb9344e5b9cf0669657bf613d036b46", dir: "/d" },
    });
    render(
      <SessionHeader bot={manual} vm={emptyVM()} status="open" workspace={ws()} bots={[manual]} railOpen panelOpen={false} onExpandRail={vi.fn()} onTogglePanel={vi.fn()} onCompact={vi.fn()} onReset={vi.fn()} />,
    );
    const branch = screen.getByTestId("header-branch");
    expect(branch).toHaveTextContent("detached @ 3157db0");
    expect(branch).not.toHaveTextContent("tarsbot/ws-abc123");
  });

  it("publish stays on discussions only: the real App shows 发布任务 for a discussion and never for a manual session", async () => {
    const user = userEvent.setup();
    const { default: App } = await import("../src/App");
    vi.stubGlobal("WebSocket", class {
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      constructor(public url: string) {}
      close() {}
    });
    const pinned = "3157db095cb9344e5b9cf0669657bf613d036b46";
    const manual = bot({ id: "m1", name: "研究 Session", workspaceId: "w1", worktree: { baseBranch: "main", pinnedSha: pinned, dir: "/home/sprite/sessions/w1/session-ab12cd34" } });
    const discussion = bot({ id: "d1", name: "issue-12-discuss", workspaceId: "w1", issueLoop: { issue: 12, baseBranch: "main", pinnedSha: pinned, dir: "/home/sprite/issue-loop/w1/discussion-x" } });
    const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/bots") return jsonRes([manual, discussion]);
      if (path === "/api/workspaces") return jsonRes([ws()]);
      if (path === "/api/routines") return jsonRes([]);
      return jsonRes({});
    });
    localStorage.setItem("pca.workspace", "w1");
    render(<App />);
    // the workspace's sessions are listed under its row: pick each one by name
    await user.click(await screen.findByRole("button", { name: /^研究 Session/ }));
    await screen.findByLabelText("Message");
    expect(screen.queryByTestId("open-publish-task")).toBeNull();
    expect(screen.queryByRole("button", { name: "发布任务" })).toBeNull();
    // the discussion does show the publish action
    await user.click(screen.getByRole("button", { name: /^issue-12-discuss/ }));
    expect(await screen.findByTestId("open-publish-task")).toBeInTheDocument();
  });
});

describe("workspace overview (SPIKE-workspace-overview)", () => {
  class FakeWS {
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {}
    close() {}
  }

  const overview = {
    issues: [
      { number: 12, title: "Fix upload", url: "https://github.com/hifizz/tars-sandbox-playground/issues/12", discussionBotId: "d1" },
      { number: 10, title: "Fresh bug", url: "https://github.com/hifizz/tars-sandbox-playground/issues/10", discussionBotId: null },
    ],
    pulls: [{ number: 7, title: "WIP feature", url: "https://github.com/hifizz/tars-sandbox-playground/pull/7", headRef: "feat-a" }],
  };

  it("clicking the workspace row opens the overview (one GET, no chat/composer), issues with a discussion reuse it, new issues go through discuss, PRs link to GitHub only", async () => {
    const user = userEvent.setup();
    const { default: App } = await import("../src/App");
    vi.stubGlobal("WebSocket", FakeWS);
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const discussion = bot({ id: "d1", name: "issue-12-discuss", workspaceId: "w1", issueLoop: { issue: 12, baseBranch: "main", pinnedSha: "3157db095cb9344e5b9cf0669657bf613d036b46", dir: "/d" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.pathname;
      calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/bots") return jsonRes([bot(), discussion]);
      if (path === "/api/workspaces") return jsonRes([ws()]);
      if (path === "/api/routines") return jsonRes([]);
      if (path === "/api/workspaces/w1/overview") return jsonRes(overview);
      if (path === "/api/workspaces/w1/issue-loop/discuss") {
        return jsonRes({ discussion: { botId: "new1", name: "issue-10-discuss", conversationId: 9010, workspaceId: "w1", issue: 10, baseBranch: "main", pinnedSha: "3157db095cb9344e5b9cf0669657bf613d036b46", dir: "/d10" } });
      }
      return jsonRes({});
    });
    localStorage.setItem("pca.workspace", "w1");
    render(<App />);

    // clicking the workspace row opens the overview
    await user.click(await screen.findByRole("button", { name: /issue-loop ws/ }));
    const ov = await screen.findByTestId("workspace-overview");
    expect(ov).toHaveTextContent("#12");
    expect(ov).toHaveTextContent("Fix upload");
    expect(ov).toHaveTextContent("#7");
    expect(ov).toHaveTextContent("WIP feature");
    // no chat input or messages on the overview
    expect(screen.queryByLabelText("Message")).toBeNull();
    // the session chrome is hidden too: no SessionHeader (Compact/Reset), no usage, no approval bar
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.queryByTestId("header-repo")).toBeNull();
    // the overview GET fired once; it is not part of the poll
    const overviewGets = () => calls.filter((c) => c.path === "/api/workspaces/w1/overview" && c.method === "GET");
    expect(overviewGets()).toHaveLength(1);
    // manual refresh fires it again
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByTestId("workspace-overview");
    expect(overviewGets()).toHaveLength(2);

    // PR rows are plain GitHub links — no Code Review button or stub
    const prLink = screen.getByRole("link", { name: /WIP feature/ });
    expect(prLink).toHaveAttribute("href", "https://github.com/hifizz/tars-sandbox-playground/pull/7");
    expect(prLink).toHaveAttribute("target", "_blank");
    expect(screen.queryByText(/Code Review/i)).toBeNull();

    // issue #10 has no discussion: the click goes through the discuss flow, then opens the new session.
    // While the request is in flight every issue button is disabled (no repeated creation clicks).
    const freshBug = screen.getByRole("button", { name: /Fresh bug/ });
    const fixUpload = screen.getByRole("button", { name: /Fix upload/ });
    await user.click(freshBug);
    await waitFor(() => expect(fixUpload).toBeDisabled());
    expect(freshBug).toBeDisabled();
    const discusses = () => calls.filter((c) => c.path === "/api/workspaces/w1/issue-loop/discuss");
    await screen.findByLabelText("Message");
    expect(discusses()).toHaveLength(1);
    expect(discusses()[0].body).toEqual({ issue: 10 });
  });

  it("clicking a session row still opens its chat; the workspace row returns to the overview", async () => {
    const user = userEvent.setup();
    const { default: App } = await import("../src/App");
    vi.stubGlobal("WebSocket", FakeWS);
    const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/bots") return jsonRes([bot()]);
      if (path === "/api/workspaces") return jsonRes([ws()]);
      if (path === "/api/routines") return jsonRes([]);
      if (path === "/api/workspaces/w1/overview") return jsonRes({ issues: [], pulls: [] });
      return jsonRes({});
    });
    localStorage.setItem("pca.workspace", "w1");
    render(<App />);

    // a session row opens the chat directly
    await user.click(await screen.findByRole("button", { name: /^primary/ }));
    await screen.findByLabelText("Message");
    expect(screen.queryByTestId("workspace-overview")).toBeNull();
    // back to the workspace row: the overview shows again (with the empty-state texts)
    await user.click(screen.getByRole("button", { name: /issue-loop ws/ }));
    const ov = await screen.findByTestId("workspace-overview");
    expect(ov).toHaveTextContent("没有未解决的 issue。");
    expect(ov).toHaveTextContent("没有开放的 PR。");
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("switching workspaces remounts the overview: rows of the previous repo never linger while the new one loads", async () => {
    const user = userEvent.setup();
    const { default: App } = await import("../src/App");
    vi.stubGlobal("WebSocket", FakeWS);
    const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const other = ws({ id: "w2", name: "second ws", repo: "hifizz/other-repo" });
    // w2's overview hangs forever: without a remount the w1 rows would stay visible
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/bots") return jsonRes([bot()]);
      if (path === "/api/workspaces") return jsonRes([ws(), other]);
      if (path === "/api/routines") return jsonRes([]);
      if (path === "/api/workspaces/w1/overview") return jsonRes(overview);
      if (path === "/api/workspaces/w2/overview") return new Promise<Response>(() => {});
      return jsonRes({});
    });
    localStorage.setItem("pca.workspace", "w1");
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /issue-loop ws/ }));
    expect(await screen.findByText("Fix upload")).toBeInTheDocument();
    // switch to the second workspace: its own loading state shows, never w1's rows
    await user.click(screen.getByRole("button", { name: /second ws/ }));
    const ov = await screen.findByTestId("workspace-overview");
    expect(ov).toHaveTextContent("second ws");
    expect(ov).toHaveTextContent("hifizz/other-repo");
    expect(screen.queryByText("Fix upload")).toBeNull();
    expect(screen.queryByText("WIP feature")).toBeNull();
  });

  it("with the rail collapsed the overview offers the same Expand sidebar control", async () => {
    const user = userEvent.setup();
    const { default: App } = await import("../src/App");
    vi.stubGlobal("WebSocket", FakeWS);
    const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/bots") return jsonRes([bot()]);
      if (path === "/api/workspaces") return jsonRes([ws()]);
      if (path === "/api/routines") return jsonRes([]);
      if (path === "/api/workspaces/w1/overview") return jsonRes(overview);
      return jsonRes({});
    });
    localStorage.setItem("pca.workspace", "w1");
    render(<App />);

    // open the overview, then collapse the rail while on it
    await user.click(await screen.findByRole("button", { name: /issue-loop ws/ }));
    await screen.findByTestId("workspace-overview");
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    // rail is collapsed: the workspace row is gone, the overview itself offers the expand control
    expect(screen.queryByRole("button", { name: /issue-loop ws/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(await screen.findByRole("button", { name: /issue-loop ws/ })).toBeInTheDocument();
  });
});
