// Delegation panel (AMP13-delegation) component tests: real render of the panel body (not yet
// registered in PANELS — the parent integrates it), with fetch mocked at the api boundary.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delegationPanel } from "../src/panels/delegation";
import { emptyVM } from "../src/lib/reducer";
import type { BotSummary } from "../src/types";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "p1",
  name: "parent-session",
  conversationId: 4242,
  model: { provider: "faux", modelId: "faux-1" },
  busy: false,
  queued: 0,
  issueLoop: { issue: 3, baseBranch: "main", pinnedSha: "a".repeat(40), dir: "/home/sprite/issue-loop/ws/exec" },
  ...over,
});

const VIEW = {
  parent: {
    botId: "p1",
    name: "parent-session",
    depth: 0,
    canDelegate: true,
    dir: "/home/sprite/issue-loop/ws/exec",
    workspaceId: "w1",
    maxChildren: 10,
    maxDepth: 2,
  },
  tasks: [] as unknown[],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function fetchFor(view: unknown = VIEW) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/bots/p1/delegation") return jsonResponse(view);
    return jsonResponse({ error: `unmocked ${url}` }, 500);
  });
}

const renderPanel = (b = bot()) => {
  const Body = delegationPanel.Component;
  return render(<Body bot={b} bots={[b]} vm={emptyVM()} />);
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("delegation panel", () => {
  it("delegates an explicit task: POST body carries the literal task and the chosen context paths", async () => {
    const fetchMock = fetchFor();
    renderPanel();
    await waitFor(() => expect(screen.getByPlaceholderText(/明确的子任务描述/)).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText(/明确的子任务描述/), "实现工具函数");
    // pick a file: the panel validates it through the file endpoint, then sends the resolved path
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/bots/p1/delegation/file") return jsonResponse({ file: { path: "/home/sprite/issue-loop/ws/exec/src/util.ts", size: 20, content: "x" } });
      if (url === "/api/bots/p1/delegation" && (init as RequestInit)?.method === "POST")
        return jsonResponse({ task: { id: "dt_1", task: "实现工具函数", state: "running", createdAt: "", base: null, branch: "tarsbot/task-aa", dir: "/d", error: null, result: null, child: { exists: true, botId: "c1", name: "task-aa", status: "executing", busy: true, queued: 0 } } });
      if (url === "/api/bots/p1/delegation") return jsonResponse(VIEW);
      return jsonResponse({ error: `unmocked ${url}` }, 500);
    });
    await userEvent.type(screen.getByPlaceholderText(/worktree 内文件路径/), "src/util.ts");
    await userEvent.click(screen.getByRole("button", { name: "添加附件" }));
    await waitFor(() => expect(screen.getByText(/src\/util\.ts（20 bytes）/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "委派子任务" }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/bots/p1/delegation" && (i as RequestInit)?.method === "POST");
      expect(post).toBeDefined();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.task).toBe("实现工具函数");
      expect(body.contextPaths).toEqual(["/home/sprite/issue-loop/ws/exec/src/util.ts"]);
      // never a client-chosen cwd/dir/model
      expect(body.dir).toBeUndefined();
      expect(body.cwd).toBeUndefined();
      expect(body.model).toBeUndefined();
    });
  });

  it("shows a running child with follow-up input, an open link, and an explicit read action; idle is never shown as done", async () => {
    fetchFor({
      parent: VIEW.parent,
      tasks: [
        {
          id: "dt_1",
          task: "实现工具函数",
          state: "running",
          createdAt: "2026-01-01T00:00:00Z",
          base: null,
          branch: "tarsbot/task-ab12cd34",
          dir: "/home/sprite/delegation/w1/task-x",
          error: null,
          result: null,
          child: { exists: true, botId: "c1", name: "task-ab12cd34", status: "executing", busy: false, queued: 0 },
        },
      ],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("实现工具函数")).toBeInTheDocument());
    expect(screen.getByText(/空闲（≠已完成）/)).toBeInTheDocument();
    const open = screen.getByRole("link", { name: "打开子会话" });
    expect(open).toHaveAttribute("href", "?bot=c1");

    await userEvent.type(screen.getByPlaceholderText(/给子会话发跟进消息/), "补充要求");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    const fetchMock = vi.mocked(globalThis.fetch);
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/delegation/dt_1/message" && (i as RequestInit)?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ message: "补充要求" });
    });
  });

  it("read action POSTs to the read endpoint (explicit, not auto)", async () => {
    const fetchMock = fetchFor({
      parent: VIEW.parent,
      tasks: [
        {
          id: "dt_2",
          task: "t",
          state: "running",
          createdAt: "2026-01-01T00:00:00Z",
          base: null,
          branch: "tarsbot/task-x",
          dir: "/d",
          error: null,
          result: null,
          child: { exists: true, botId: "c2", name: "task-x", status: "executing", busy: true, queued: 0 },
        },
      ],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "读取结果送回本会话" })).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/读取结果时的备注/), "收尾");
    await userEvent.click(screen.getByRole("button", { name: "读取结果送回本会话" }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/delegation/dt_2/read" && (i as RequestInit)?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ note: "收尾" });
    });
  });

  it("a child at the depth cap sees no delegate form; a failed task shows its error", async () => {
    // the fetch mock must serve the CHILD bot's own delegation endpoint
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/bots/c9/delegation") {
        return jsonResponse({
          parent: { ...VIEW.parent, botId: "c9", depth: 2, canDelegate: false },
          tasks: [{ id: "dt_9", task: "broken", state: "failed", createdAt: "", base: null, branch: null, dir: null, error: "sprite command failed (128)", result: null, child: { exists: false } }],
        });
      }
      return jsonResponse({ error: `unmocked ${url}` }, 500);
    });
    renderPanel(bot({ id: "c9", delegation: { role: "child", parentBotId: "p1", depth: 2 } }));
    await waitFor(() => expect(screen.getByText(/层级上限/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "委派子任务" })).not.toBeInTheDocument();
    expect(screen.getByText("sprite command failed (128)")).toBeInTheDocument();
  });

  it("without a bot the panel explains a session must be selected and calls nothing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    const Body = delegationPanel.Component;
    render(<Body bots={[]} vm={emptyVM()} />);
    expect(screen.getByText(/选择一个会话后可委派子任务/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("badge counts the parent's delegation tasks", () => {
    const b = bot({ delegation: { tasks: [{}, {}], results: [], depth: 0 } });
    expect(delegationPanel.badge?.({ bot: b, bots: [b], vm: emptyVM() })).toBe("2");
    expect(delegationPanel.badge?.({ bots: [], vm: emptyVM() })).toBeUndefined();
  });
});

// ---- shared session-dir resolution (AMP13-delegation cross-feature fix) ----------------------------------------------
// A delegation child declares the SAME `worktree` metadata shape an add-session uses ({dir, pinnedSha,
// baseBranch, branch}). Every reader that resolves "which directory does this session work in" must see
// the child's own worktree — never the workspace repo dir or the parent's dir. The reference
// implementation is `sessionDir` below; the same three-line resolution is the exact edit for
// SessionHeader / EnvironmentPane in MAIN.
import { type Workspace } from "../src/lib/workspaces";

const wsBase: Workspace = {
  id: "w1",
  name: "ws",
  repo: "hifizz/tars-sandbox-playground",
  baseBranch: "main",
  baseCommit: "3157db095cb9344e5b9cf0669657bf613d036b46",
  branch: "tarsbot/ws-abc123",
  status: "ready",
  steps: [],
  botId: "p1",
  binding: { provider: "sprites", runtimeId: "pca-eae56f671c", version: 1 },
};

/** Reference resolution (must match `sessionDir` in src/routes/delegation.mjs). */
function sessionDir(b: Pick<BotSummary, "issueLoop" | "worktree" | "review"> | undefined, wsCwd: string): string {
  return b?.issueLoop?.dir ?? b?.worktree?.dir ?? b?.review?.dir ?? wsCwd;
}

const CHILD: BotSummary = {
  id: "c1",
  name: "task-ab12cd34",
  conversationId: 5001,
  model: { provider: "faux", modelId: "swe-2" },
  busy: false,
  queued: 0,
  workspaceId: "w1",
  status: "executing" as const,
  worktree: { dir: "/home/sprite/delegation/w1/task-ab12cd34", pinnedSha: "b".repeat(40), baseBranch: "main", branch: "tarsbot/task-ab12cd34" },
  delegation: { role: "child" as const, parentBotId: "p1", taskId: "dt_x", depth: 1 },
};

describe("delegation: shared session-dir resolution (cross-feature)", () => {
  it("a child's worktree metadata resolves its own dir for every reader — never ws.cwd or the parent's dir", () => {
    // Files/Terminal/Git all call the same resolution: worktree.dir wins over the workspace dir.
    expect(sessionDir(CHILD, "/home/sprite/workspace/repo")).toBe("/home/sprite/delegation/w1/task-ab12cd34");
    // an issueLoop session still wins via its own shape (unchanged behaviour)
    const il = bot({ issueLoop: { issue: 1, baseBranch: "main", pinnedSha: "a".repeat(40), dir: "/il" } });
    expect(sessionDir(il, "/home/sprite/workspace/repo")).toBe("/il");
    // a normal session (no worktree/issueLoop/review) falls back to the workspace dir
    const plain: BotSummary = { id: "x", name: "x", conversationId: 1, model: { provider: "faux", modelId: "f" }, busy: false, queued: 0 };
    expect(sessionDir(plain, "/home/sprite/workspace/repo")).toBe("/home/sprite/workspace/repo");
  });

  it("the same metadata drives the branch label: the child's own tarsbot/task branch is shown, not the workspace branch", () => {
    // Mirrors the SessionHeader `gitLabel` resolution in MAIN with the delegation-aware worktree.branch added.
    const loop = CHILD.issueLoop;
    const review = !loop ? CHILD.review : undefined;
    const wt = !loop && !review ? CHILD.worktree : undefined;
    const label = loop ? (loop.branch ?? `detached`) : review ? `PR #${review.pr}` : wt ? (wt.branch ?? `detached @ ${wt.pinnedSha.slice(0, 7)}`) : wsBase.branch;
    expect(label).toBe("tarsbot/task-ab12cd34");
    expect(label).not.toBe("tarsbot/ws-abc123");
  });
});
