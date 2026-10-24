import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import { api } from "../src/lib/api";
import { NewWorkspaceDialog } from "../src/components/NewWorkspaceDialog";
import { EnvironmentPane } from "../src/components/EnvironmentPane";
import { WorkspaceActions, WorkspaceStatus } from "../src/components/WorkspaceStatus";
import { SessionHeader } from "../src/shell/SessionHeader";
import { emptyVM } from "../src/lib/reducer";
import { envName, mapBotsToWorkspaces, mergeWorkspaceList, useWorkspacePoll, type LocalWorkspace, type Workspace } from "../src/lib/workspaces";
import type { BotSummary } from "../src/types";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}
type Handler = (call: Call) => Response | Promise<Response> | undefined;

/** Fake fetch: records every call; `handler` answers, unmatched requests are a 404. */
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

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  name: "fix upload",
  repo: "hifizz/demo",
  baseBranch: "main",
  baseCommit: "abcdef1234567",
  branch: "tarsbot/fix-1a2b3c",
  status: "ready",
  steps: [],
  botId: "b1",
  binding: { provider: "sprites", runtimeId: "pca-0123456789abcdef", version: 1 },
  ...over,
});

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "main",
  conversationId: 1,
  model: { provider: "tokenrouter", modelId: "swe-2" },
  busy: false,
  queued: 0,
  ...over,
});

const repos = [
  { fullName: "hifizz/demo", defaultBranch: "main", private: false },
  { fullName: "hifizz/other", defaultBranch: "develop", private: true },
];

describe("NewWorkspaceDialog", () => {
  const baseHandler: Handler = ({ method, path }) => {
    if (method === "GET" && path === "/api/github/repos") return json(repos);
    if (method === "GET" && path.startsWith("/api/github/branches")) {
      return json(path.includes("other") ? [{ name: "develop", sha: "1" }, { name: "next", sha: "2" }] : [{ name: "main", sha: "1" }, { name: "dev", sha: "2" }]);
    }
    return undefined;
  };

  it("loads repos, filters them, defaults the branch to the repo default, and submits the chosen values", async () => {
    const user = userEvent.setup();
    const calls = fakeFetch((c) => baseHandler(c) ?? (c.method === "POST" ? json(ws(), 202) : undefined));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewWorkspaceDialog onCreated={onCreated} onClose={onClose} />);

    const repoSelect = await screen.findByRole("combobox", { name: "仓库" });
    await waitFor(() => expect(repoSelect).toHaveValue("hifizz/demo"));
    await waitFor(() => expect(screen.getByLabelText("起始分支")).toHaveValue("main"));

    await user.type(screen.getByLabelText("过滤仓库"), "other");
    await user.selectOptions(repoSelect, "hifizz/other");
    await waitFor(() => expect(screen.getByLabelText("起始分支")).toHaveValue("develop"));
    expect(calls.some((c) => c.path === "/api/github/branches?repo=hifizz%2Fother")).toBe(true);

    await user.type(screen.getByLabelText("需求"), "  补齐校验  ");
    await user.selectOptions(screen.getByLabelText("模型"), "glm-5.3");
    await user.click(screen.getByText("展开设置"));
    await user.type(screen.getByLabelText("安装命令"), "npm ci");
    await user.click(screen.getByRole("button", { name: "创建工作区" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/workspaces");
    expect(post.body).toMatchObject({ repo: "hifizz/other", baseBranch: "develop", task: "补齐校验", modelId: "glm-5.3", installCommand: "npm ci" });
    expect(typeof post.body!.requestId).toBe("string");
    expect(onClose).toHaveBeenCalled();
  });

  it("model options start with swe-2", async () => {
    fakeFetch(baseHandler);
    render(<NewWorkspaceDialog onCreated={vi.fn()} onClose={vi.fn()} />);
    const options = within(screen.getByLabelText("模型")).getAllByRole("option");
    expect(options[0]).toHaveValue("swe-2");
    expect(screen.getByLabelText("模型")).toHaveValue("swe-2");
  });

  it("a failed submit shows the server error, keeps the input, and the retry reuses the same requestId", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const calls = fakeFetch((c) => {
      const base = baseHandler(c);
      if (base) return base;
      if (c.method === "POST") return ++attempt === 1 ? json({ error: "GitHub 凭据不可用" }, 502) : json(ws(), 202);
      return undefined;
    });
    const onCreated = vi.fn();
    render(<NewWorkspaceDialog onCreated={onCreated} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "仓库" })).toHaveValue("hifizz/demo"));
    await user.type(screen.getByLabelText("需求"), "do it");
    await user.click(screen.getByRole("button", { name: "创建工作区" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub 凭据不可用");
    expect(screen.getByLabelText("需求")).toHaveValue("do it");
    expect(onCreated).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "创建工作区" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1].body!.requestId).toBe(posts[0].body!.requestId);
  });

  it("repeated clicks while the request is in flight send one request, and the button is disabled", async () => {
    const user = userEvent.setup();
    let release!: (r: Response) => void;
    const calls = fakeFetch((c) => {
      const base = baseHandler(c);
      if (base) return base;
      if (c.method === "POST") return new Promise<Response>((r) => (release = r));
      return undefined;
    });
    render(<NewWorkspaceDialog onCreated={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "仓库" })).toHaveValue("hifizz/demo"));
    const submit = screen.getByRole("button", { name: "创建工作区" });
    await user.click(submit);
    expect(await screen.findByRole("button", { name: "创建中…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "创建中…" }));
    await user.keyboard("{Enter}");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await act(async () => release(json(ws(), 202)));
  });

  it("two separate dialogs use different requestIds", async () => {
    const user = userEvent.setup();
    const calls = fakeFetch((c) => baseHandler(c) ?? (c.method === "POST" ? json(ws(), 202) : undefined));
    for (let i = 0; i < 2; i++) {
      const { unmount } = render(<NewWorkspaceDialog onCreated={vi.fn()} onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("combobox", { name: "仓库" })).toHaveValue("hifizz/demo"));
      await user.click(screen.getByRole("button", { name: "创建工作区" }));
      await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(i + 1));
      unmount();
    }
    const [a, b] = calls.filter((c) => c.method === "POST");
    expect(a.body!.requestId).not.toBe(b.body!.requestId);
  });

  it("shows an error when the repo list cannot be loaded and blocks submitting", async () => {
    fakeFetch(({ path }) => (path === "/api/github/repos" ? json({ error: "GitHub 凭据不可用" }, 502) : undefined));
    render(<NewWorkspaceDialog onCreated={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub 凭据不可用");
    expect(screen.getByRole("button", { name: "创建工作区" })).toBeDisabled();
  });
});

describe("WorkspaceStatus", () => {
  const preparing = ws({
    status: "preparing",
    steps: [
      { step: "runtime", state: "done" },
      { step: "init", state: "running" },
    ],
  });

  it("lists the five steps with their states", () => {
    render(<WorkspaceStatus workspace={preparing} />);
    const items = within(screen.getByRole("region", { name: "工作区状态" })).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-step"))).toEqual(["runtime", "init", "code", "deps", "agent"]);
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["done", "running", "pending", "pending", "pending"]);
  });

  it("banner explains the composer is disabled and names the current step", () => {
    render(<WorkspaceStatus workspace={preparing} variant="banner" />);
    expect(screen.getByRole("status")).toHaveTextContent("正在准备工作区：初始化环境（进行中）");
    expect(screen.getByRole("status")).toHaveTextContent("输入框暂时禁用");
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("banner is empty for a ready workspace", () => {
    const { container } = render(<WorkspaceStatus workspace={ws()} variant="banner" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("unknown shows 结果待确认 and a retry that POSTs /retry", async () => {
    const user = userEvent.setup();
    const calls = fakeFetch(({ method, path }) => (method === "POST" && path === "/api/workspaces/w1/retry" ? json(ws({ status: "preparing" }), 202) : undefined));
    const onUpdate = vi.fn();
    const unknown = ws({ status: "preparing", steps: [{ step: "runtime", state: "unknown" }] });
    render(<WorkspaceStatus workspace={unknown} onUpdate={onUpdate} />);
    expect(screen.getByText("结果待确认")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(calls).toEqual([{ method: "POST", path: "/api/workspaces/w1/retry", body: {} }]);
  });

  it("failed: shows the error in the banner with a retry button, and a failed retry shows its own error", async () => {
    const user = userEvent.setup();
    const calls = fakeFetch(() => json({ error: "仍在准备" }, 409));
    const failed = ws({ status: "failed", error: "git clone 失败", steps: [{ step: "code", state: "failed", error: "git clone 失败" }] });
    render(<WorkspaceStatus workspace={failed} variant="banner" />);
    expect(screen.getByRole("alert")).toHaveTextContent("git clone 失败");
    const btn = screen.getByRole("button", { name: "重试" });
    await user.click(btn);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(await screen.findByText(/重试失败：仍在准备/)).toBeInTheDocument();
  });
});

describe("WorkspaceActions", () => {
  it("renders nothing for a workspace that is not ready", () => {
    fakeFetch(() => undefined);
    const { container } = render(<WorkspaceActions workspace={ws({ status: "preparing" })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("create PR: shows the link on success, then 已存在 on a repeated click, each click a fresh requestId", async () => {
    const user = userEvent.setup();
    let n = 0;
    const calls = fakeFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/workspaces/w1/checkpoints") return json([]);
      if (method === "POST" && path === "/api/workspaces/w1/pr") {
        const created = n++ === 0;
        return json({ pull: { number: 7, url: "https://github.com/hifizz/demo/pull/7" }, created });
      }
      return undefined;
    });
    render(<WorkspaceActions workspace={ws()} />);
    await user.click(screen.getByRole("button", { name: "创建 PR" }));
    expect(await screen.findByText(/PR 已创建/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#7" })).toHaveAttribute("href", "https://github.com/hifizz/demo/pull/7");
    await user.click(screen.getByRole("button", { name: "创建 PR" }));
    expect(await screen.findByText(/PR 已存在/)).toBeInTheDocument();
    const prs = calls.filter((c) => c.path.endsWith("/pr"));
    expect(prs).toHaveLength(2);
    expect(prs[0].body!.requestId).not.toBe(prs[1].body!.requestId);
  });

  it("switching to another workspace does not carry over the PR result of the previous one (found in the M1 acceptance run)", async () => {
    const user = userEvent.setup();
    fakeFetch(({ method, path }) => {
      if (method === "GET" && path.endsWith("/checkpoints")) return json([]);
      if (method === "POST" && path === "/api/workspaces/w1/pr") return json({ pull: { number: 11, url: "https://github.com/hifizz/demo/pull/11" }, created: true });
      return undefined;
    });
    const { rerender } = render(<EnvironmentPane workspace={ws({ id: "w1" })} />);
    await user.click(screen.getByRole("button", { name: "创建 PR" }));
    expect(await screen.findByRole("link", { name: "#11" })).toBeInTheDocument();
    rerender(<EnvironmentPane workspace={ws({ id: "w2", branch: "tarsbot/other-9f8e7d" })} />);
    expect(screen.queryByRole("link", { name: "#11" })).not.toBeInTheDocument();
    expect(screen.queryByText(/PR 已/)).not.toBeInTheDocument();
  });

  it("create PR failure shows the error and the retry reuses the requestId", async () => {
    const user = userEvent.setup();
    let n = 0;
    const calls = fakeFetch(({ method, path }) => {
      if (method === "GET") return json([]);
      if (path.endsWith("/pr")) return n++ === 0 ? json({ error: "分支尚未推送，请先让 Bot git push" }, 409) : json({ pull: { number: 8, url: "https://github.com/hifizz/demo/pull/8" }, created: true });
      return undefined;
    });
    render(<WorkspaceActions workspace={ws()} />);
    await user.click(screen.getByRole("button", { name: "创建 PR" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("分支尚未推送");
    await user.click(screen.getByRole("button", { name: "创建 PR" }));
    expect(await screen.findByText(/PR 已创建/)).toBeInTheDocument();
    const prs = calls.filter((c) => c.path.endsWith("/pr"));
    expect(prs[1].body!.requestId).toBe(prs[0].body!.requestId);
  });

  it("saves a checkpoint (time and size shown), lists checkpoints, and rebuild asks for confirmation first", async () => {
    const user = userEvent.setup();
    const cp = { id: "c1", size: 2048, createdAt: "2026-10-25T10:20:00Z", fileCount: 3, bindingVersion: 1 };
    let saved = false;
    const calls = fakeFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/workspaces/w1/checkpoints") return json(saved ? [cp] : []);
      if (method === "POST" && path === "/api/workspaces/w1/checkpoint") {
        saved = true;
        return json(cp);
      }
      if (method === "POST" && path === "/api/workspaces/w1/rebuild") return json({ version: 2 });
      return undefined;
    });
    const onChanged = vi.fn();
    render(<WorkspaceActions workspace={ws()} onChanged={onChanged} />);
    expect(await screen.findByText("还没有检查点。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存检查点" }));
    expect(await screen.findByText(/已保存：/)).toHaveTextContent("2.0 KB");
    expect(await screen.findByTestId("checkpoint-item")).toHaveTextContent("3 个文件");

    await user.click(within(screen.getByTestId("checkpoint-item")).getByRole("button", { name: /重建/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("会新建一台环境并恢复到该检查点");
    expect(calls.some((c) => c.path.endsWith("/rebuild"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "确认重建" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const rebuild = calls.find((c) => c.path.endsWith("/rebuild"))!;
    expect(rebuild.body).toMatchObject({ checkpointId: "c1" });
    expect(typeof rebuild.body!.requestId).toBe("string");
  });

  it("rebuild failure keeps the dialog open with the error; retry reuses the requestId", async () => {
    const user = userEvent.setup();
    let n = 0;
    const calls = fakeFetch(({ method, path }) => {
      if (method === "GET") return json([{ id: 5, size: 10, createdAt: "2026-10-25T10:20:00Z" }]);
      if (path.endsWith("/rebuild")) return n++ === 0 ? json({ error: "检查点校验失败" }, 409) : json({});
      return undefined;
    });
    render(<WorkspaceActions workspace={ws()} />);
    await user.click(await screen.findByRole("button", { name: /重建/ }));
    await user.click(screen.getByRole("button", { name: "确认重建" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("检查点校验失败");
    await user.click(screen.getByRole("button", { name: "重试重建" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const rebuilds = calls.filter((c) => c.path.endsWith("/rebuild"));
    expect(rebuilds[1].body!.requestId).toBe(rebuilds[0].body!.requestId);
  });

  it("checkpoint save failure shows an error", async () => {
    const user = userEvent.setup();
    fakeFetch(({ method }) => (method === "GET" ? json([]) : json({ error: "超过大小上限" }, 500)));
    render(<WorkspaceActions workspace={ws()} />);
    await user.click(await screen.findByRole("button", { name: "保存检查点" }));
    expect(await screen.findByText(/保存检查点失败：超过大小上限/)).toBeInTheDocument();
  });
});

describe("useWorkspacePoll", () => {
  it("polls every 2s while enabled, stops when disabled, and pauses while the page is hidden", async () => {
    vi.useFakeTimers();
    const calls = fakeFetch(({ method }) => (method === "GET" ? json(ws({ status: "preparing" })) : undefined));
    const onData = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useWorkspacePoll("w1", enabled, onData), { initialProps: { enabled: true } });

    await act(() => vi.advanceTimersByTimeAsync(1900));
    expect(calls).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/workspaces/w1");
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(calls).toHaveLength(2);
    expect(onData).toHaveBeenCalledTimes(2);

    // hidden: the pending timer fires but does nothing and does not reschedule
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(calls).toHaveLength(2);
    // visible again: immediate fetch, then the 2s cadence resumes
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toHaveLength(3);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(calls).toHaveLength(4);

    rerender({ enabled: false });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(calls).toHaveLength(4);
  });
});

describe("workspace helpers", () => {
  it("envName is provider plus the last 6 characters of the runtime id", () => {
    expect(envName(ws())).toBe("sprites · cdef".replace("cdef", "abcdef"));
    expect(envName({ binding: null })).toBeUndefined();
  });

  it("forked bots belong to their parent's workspace", () => {
    const bots = [bot(), bot({ id: "b2", name: "fork", parent: { botId: "b1" } }), bot({ id: "b9", name: "orphan" })];
    const map = mapBotsToWorkspaces(bots, [ws()]);
    expect(map.get("b1")).toBe("w1");
    expect(map.get("b2")).toBe("w1");
    expect(map.has("b9")).toBe(false);
  });

  it("mergeWorkspaceList keeps a just-created workspace until a list contains it", () => {
    const local = new Map<string, LocalWorkspace>([["w2", { workspace: ws({ id: "w2" }), at: 1000 }]]);
    expect(mergeWorkspaceList([ws()], local, 2000).map((w) => w.id)).toEqual(["w2", "w1"]);
    expect(local.has("w2")).toBe(true);
    expect(mergeWorkspaceList([ws(), ws({ id: "w2" })], local, 3000)).toHaveLength(2);
    expect(local.has("w2")).toBe(false);
  });
});

describe("SessionHeader", () => {
  it("shows repo, branch and environment name", () => {
    render(
      <SessionHeader
        bot={bot()}
        vm={emptyVM()}
        status="open"
        workspace={ws()}
        railOpen
        panelOpen={false}
        onExpandRail={vi.fn()}
        onTogglePanel={vi.fn()}
        onCompact={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTestId("header-repo")).toHaveTextContent("demo");
    expect(screen.getByTestId("header-branch")).toHaveTextContent("tarsbot/fix-1a2b3c");
    expect(screen.getByTestId("header-env")).toHaveTextContent("sprites · abcdef");
  });
});

describe("api", () => {
  it("has no createBot any more, and forkBot always sends readOnly: true", async () => {
    expect((api as Record<string, unknown>).createBot).toBeUndefined();
    const calls = fakeFetch(() => json(bot({ id: "n" })));
    await api.forkBot("b1", { name: "r", readOnly: false } as unknown as Parameters<typeof api.forkBot>[1]);
    expect(calls[0].body).toMatchObject({ readOnly: true });
  });
});

describe("App", () => {
  class FakeWS {
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {}
    close() {}
  }

  function boot(workspaces: Workspace[], bots: BotSummary[], extra: Handler = () => undefined) {
    vi.stubGlobal("WebSocket", FakeWS);
    return fakeFetch((c) => {
      if (c.path === "/api/bots") return json(bots);
      if (c.path === "/api/workspaces" && c.method === "GET") return json(workspaces);
      if (c.path === "/api/routines") return json([]);
      return extra(c);
    });
  }

  it("with no workspaces: shows the empty state that points at 新建工作区, and no 'New bot' entry anywhere", async () => {
    boot([], []);
    render(<App />);
    expect(await screen.findByText(/还没有工作区。新建一个工作区/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新建工作区" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /new bot/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/new bot/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Instructions (optional)")).not.toBeInTheDocument();
  });

  it("the 新建工作区 button opens the dialog", async () => {
    const user = userEvent.setup();
    boot([], [], ({ path }) => (path === "/api/github/repos" ? json(repos) : path.startsWith("/api/github/branches") ? json([]) : undefined));
    render(<App />);
    await screen.findByText(/还没有工作区。新建一个工作区/);
    await user.click(screen.getAllByRole("button", { name: "新建工作区" })[0]);
    expect(await screen.findByRole("dialog", { name: "新建工作区" })).toBeInTheDocument();
  });

  it("a preparing workspace disables the composer and names the current step", async () => {
    boot([ws({ status: "preparing", steps: [{ step: "runtime", state: "done" }, { step: "init", state: "running" }] })], [bot()]);
    render(<App />);
    expect(await screen.findByLabelText("Message")).toBeDisabled();
    expect(screen.getByText(/正在准备工作区：初始化环境（进行中）/)).toBeInTheDocument();
  });

  it("a failed workspace disables the composer, shows the error and a retry button", async () => {
    boot([ws({ status: "failed", error: "git clone 失败", steps: [{ step: "code", state: "failed", error: "git clone 失败" }] })], [bot()]);
    render(<App />);
    expect(await screen.findByLabelText("Message")).toBeDisabled();
    expect(screen.getByText(/工作区准备失败：git clone 失败/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("an unconfirmed step says 结果待确认 with a retry", async () => {
    boot([ws({ status: "preparing", steps: [{ step: "runtime", state: "unknown" }] })], [bot()]);
    render(<App />);
    expect(await screen.findByText(/结果待确认/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("a ready workspace enables the composer and shows its repo, branch and environment in the header", async () => {
    boot([ws()], [bot()]);
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeEnabled());
    expect(screen.getByTestId("header-repo")).toHaveTextContent("demo");
    expect(screen.getByTestId("header-branch")).toHaveTextContent("tarsbot/fix-1a2b3c");
    expect(screen.getByTestId("header-env")).toHaveTextContent("sprites · abcdef");
    expect(screen.getByRole("navigation", { name: "Workspaces" })).toHaveTextContent("hifizz/demo");
  });

  it("never requests /api/space or POST /api/bots", async () => {
    const calls = boot([ws()], [bot()]);
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeEnabled());
    expect(calls.some((c) => c.path.includes("/api/space"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/bots")).toBe(false);
  });
});
