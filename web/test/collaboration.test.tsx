// AMP13-collaboration: session deep links (?bot=<id>), share link, narrow-screen shell, opt-in notifications.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import { readSessionLink, sessionUrl, copySessionLink, useSessionLink } from "../src/hooks/useSessionLink";
import { useSessionNotifications } from "../src/hooks/useSessionNotifications";
import { WorkspaceShell } from "../src/shell/WorkspaceShell";
import { setMockViewportWidth } from "./helpers/viewport";
import { SidebarProvider } from "../src/components/ui/sidebar";
import { SessionHeader } from "../src/shell/SessionHeader";
import { emptyVM } from "../src/lib/reducer";
import type { BotSummary } from "../src/types";
import type { Workspace } from "../src/lib/workspaces";

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

/** Boot App with the fake fetch + WebSocket of workspaces.test.tsx. */
function boot(workspaces: Workspace[], bots: BotSummary[], extra: (c: { method: string; path: string }) => Response | undefined = () => undefined) {
  vi.stubGlobal("WebSocket", FakeWS);
  const calls: { method: string; path: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const call = { method: (init as RequestInit | undefined)?.method ?? "GET", path: url.pathname + url.search };
    calls.push(call);
    return (
      (await extra(call)) ??
      (call.path === "/api/bots"
        ? json(bots)
        : call.path === "/api/workspaces" && call.method === "GET"
          ? json(workspaces)
          : call.path === "/api/routines"
            ? json([])
            : call.path === "/api/workspaces/w1/loops"
              ? json([])
              : call.path === "/api/workspaces/w1/env"
                ? json({ enabled: true, vars: [] })
                : json({ error: `unexpected ${call.method} ${call.path}` }, 404))
    );
  });
  return calls;
}

describe("useSessionLink", () => {
  it("reads ?bot= from the URL and builds absolute share URLs", () => {
    window.history.replaceState(null, "", "/?bot=b42");
    expect(readSessionLink()).toBe("b42");
    window.history.replaceState(null, "", "/?bot=%20");
    expect(readSessionLink()).toBeUndefined();
    window.history.replaceState(null, "", "/");
    expect(readSessionLink()).toBeUndefined();
    expect(sessionUrl("b42")).toBe("http://localhost:3000/?bot=b42");
  });

  it("setLink pushes history entries and popstate moves the link back", async () => {
    const { result } = renderHook(() => useSessionLink());
    act(() => result.current.setLink("b1"));
    expect(window.location.search).toBe("?bot=b1");
    act(() => result.current.setLink("b2"));
    act(() => result.current.setLink(undefined));
    expect(window.location.search).toBe("");
    act(() => window.history.back());
    await waitFor(() => expect(result.current.linkBot).toBe("b2"));
    act(() => window.history.back());
    await waitFor(() => expect(result.current.linkBot).toBe("b1"));
  });

  it("copySessionLink writes the URL via clipboard and falls back to execCommand", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, get: () => ({ writeText }) });
    window.history.replaceState(null, "", "/?bot=b9");
    await copySessionLink("b9");
    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/?bot=b9");
    delete (window.navigator as { clipboard?: unknown }).clipboard;

    // No clipboard API: the hidden-textarea + execCommand fallback runs.
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    try {
      await copySessionLink("b9");
      expect(exec).toHaveBeenCalledWith("copy");
    } finally {
      delete (document as { execCommand?: unknown }).execCommand;
    }
  });
});

describe("App deep link", () => {
  it("opens a workspace URL ahead of local storage and preserves overview after reload", async () => {
    localStorage.setItem("pca.workspace", "w1");
    window.history.replaceState(null, "", "/?workspace=w2");
    boot([ws(), ws({ id: "w2", name: "other", botId: "b2" })], [bot(), bot({ id: "b2" })]);
    const view = render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /other/ })).toHaveAttribute("aria-current", "true"));
    expect(screen.queryByRole("button", { name: /分享/ })).not.toBeInTheDocument();
    expect(window.location.search).toBe("?workspace=w2");
    view.unmount();
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /other/ })).toHaveAttribute("aria-current", "true"));
    expect(window.location.search).toBe("?workspace=w2");
  });

  it("workspace clicks, back and forward restore both overview and sidebar selection", async () => {
    const user = userEvent.setup();
    boot([ws(), ws({ id: "w2", name: "other", botId: "b2" })], [bot(), bot({ id: "b2" })]);
    render(<App />);
    await screen.findByRole("heading", { name: "main" });
    await user.click(screen.getByRole("button", { name: /fix upload/ }));
    await waitFor(() => expect(window.location.search).toBe("?workspace=w1"));
    await user.click(screen.getByRole("button", { name: /other/ }));
    await waitFor(() => expect(window.location.search).toBe("?workspace=w2"));
    act(() => window.history.back());
    await waitFor(() => expect(screen.getByRole("button", { name: /fix upload/ })).toHaveAttribute("aria-current", "true"));
    expect(window.location.search).toBe("?workspace=w1");
    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByRole("button", { name: /other/ })).toHaveAttribute("aria-current", "true"));
    expect(window.location.search).toBe("?workspace=w2");
    expect(screen.queryByRole("button", { name: /分享/ })).not.toBeInTheDocument();
  });

  it("keeps an unknown workspace URL and allows recovery by selecting a workspace", async () => {
    window.history.replaceState(null, "", "/?workspace=missing");
    boot([ws()], [bot()]);
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("链接中的工作区不存在：missing");
    expect(window.location.search).toBe("?workspace=missing");
    expect(screen.getByRole("button", { name: /fix upload/ })).not.toHaveAttribute("aria-current");
    await userEvent.setup().click(screen.getByRole("button", { name: /fix upload/ }));
    await waitFor(() => expect(window.location.search).toBe("?workspace=w1"));
    expect(screen.queryByText("链接中的工作区不存在：missing")).not.toBeInTheDocument();
  });
  it("opens the session of ?bot=<id> in its workspace, even when another workspace is persisted", async () => {
    const second = ws({ id: "w2", name: "other", branch: "tarsbot/other", botId: "b2" });
    localStorage.setItem("pca.workspace", "w1");
    window.history.replaceState(null, "", "/?bot=b2");
    boot([ws(), second], [bot(), bot({ id: "b2", name: "exec-2", conversationId: 2 })]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "exec-2" })).toBeInTheDocument());
    // The rail marks w2 selected and the URL stays on the session for refresh/sharing.
    expect(window.location.search).toBe("?bot=b2");
  });

  it("an unknown bot id shows an explicit error and the URL settles on the actual session", async () => {
    window.history.replaceState(null, "", "/?bot=nope");
    boot([ws()], [bot()]);
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("链接中的会话不存在：nope");
    // The failed link is replaced with the session App actually opened, so a refresh does not re-alert.
    await waitFor(() => expect(window.location.search).toBe("?bot=b1"));
  });

  it("picking a session updates the URL and browser back reopens the previous one", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/");
    boot([ws()], [bot(), bot({ id: "b2", name: "exec-2", conversationId: 2, workspaceId: "w1" })]);
    render(<App />);
    await screen.findByRole("heading", { name: "main" });
    await waitFor(() => expect(window.location.search).toBe("?bot=b1"));
    await user.click(screen.getByRole("button", { name: /exec-2/ }));
    await waitFor(() => expect(window.location.search).toBe("?bot=b2"));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe("?bot=b1"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "main" })).toBeInTheDocument());
  });
});

describe("share link", () => {
  it("copies the session link and shows feedback", async () => {
    const user = userEvent.setup();
    // userEvent.installs its own clipboard stub on navigator during setup; spy on it afterwards.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, get: () => ({ writeText }) });
    window.history.replaceState(null, "", "/?bot=b1");
    // The share entry point is hidden in the toolbar (SHOW_SESSION_TOOLBAR_ACTIONS in SessionHeader),
    // so render the header directly and click the hidden control to prove the wiring still works.
    const props = {
      bot: bot(),
      vm: emptyVM(),
      status: "open" as const,
      workspace: ws(),
      railOpen: true,
      panelOpen: false,
      onExpandRail: vi.fn(),
      onTogglePanel: vi.fn(),
      onCompact: vi.fn(),
      onReset: vi.fn(),
      onShare: () => void copySessionLink("b1"),
    };
    const view = render(<SessionHeader {...props} />);
    const shareBtn = document.querySelector<HTMLButtonElement>("button[title*='深链接']");
    expect(shareBtn).not.toBeNull();
    expect(shareBtn!.closest("[hidden]")).not.toBeNull();
    await user.click(shareBtn!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("?bot=b1")));
    // …and the feedback prop still renders (hidden with the cluster, like App passes it).
    view.rerender(<SessionHeader {...props} shareFeedback="已复制链接" />);
    const feedback = screen.getByTestId("share-feedback");
    expect(feedback).toHaveTextContent("已复制链接");
    expect(feedback.closest("[hidden]")).not.toBeNull();
  });
});

describe("useSessionNotifications", () => {
  class FakeNotification {
    static instances: { title: string; body?: string }[] = [];
    static permission: NotificationPermission = "default";
    static requestPermission = vi.fn(async () => FakeNotification.permission);
    constructor(public title: string, opts?: { body?: string }) {
      FakeNotification.instances.push({ title, body: opts?.body });
    }
  }

  function setup(permission: NotificationPermission) {
    FakeNotification.instances = [];
    FakeNotification.permission = permission;
    FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
    vi.stubGlobal("Notification", FakeNotification);
  }

  it("asks permission on explicit toggle and enables once granted", async () => {
    setup("default");
    FakeNotification.requestPermission = vi.fn(async () => {
      FakeNotification.permission = "granted";
      return "granted";
    });
    const { result } = renderHook(({ busy }) => useSessionNotifications({ botId: "b1", botName: "main", busy }), { initialProps: { busy: true } });
    expect(result.current.enabled).toBe(false);
    await act(() => result.current.onToggle());
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(result.current.enabled).toBe(true);
    expect(localStorage.getItem("pca.notify")).toBe("1");
  });

  it("notifies only on a real busy->idle transition, not on first idle render, and never twice for one edge", async () => {
    setup("granted");
    const { result, rerender } = renderHook(({ busy }) => useSessionNotifications({ botId: "b1", botName: "main", busy }), { initialProps: { busy: false } });
    await act(() => result.current.onToggle()); // permission already granted -> enable
    expect(result.current.enabled).toBe(true);
    rerender({ busy: false });
    expect(FakeNotification.instances).toHaveLength(0); // initial idle is not a completion
    rerender({ busy: true });
    rerender({ busy: false });
    expect(FakeNotification.instances).toEqual([{ title: "main", body: "运行结束，等待你的下一步。" }]);
    rerender({ busy: false });
    expect(FakeNotification.instances).toHaveLength(1); // no repeat without a new busy edge
    rerender({ busy: true });
    rerender({ busy: false });
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it("a denied permission is reported and the toggle stays disabled", async () => {
    setup("denied");
    const { result, rerender } = renderHook(({ busy }) => useSessionNotifications({ botId: "b1", busy }), { initialProps: { busy: true } });
    expect(result.current.permission).toBe("denied");
    await act(() => result.current.onToggle());
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(false);
    rerender({ busy: false });
    expect(FakeNotification.instances).toHaveLength(0);
  });
});

describe("narrow-screen shell", () => {
  const slots = { rail: <p>RAIL</p>, main: <p>MAIN</p>, panel: <p>PANEL</p> };
  it("the open rail is a sidebar column; below md it is a Sheet drawer closed via the provider", () => {
    const onOpenRail = vi.fn();
    // Desktop viewport: the rail is an inline column inside the resizable group.
    render(<WorkspaceShell railOpen panelOpen={false} onOpenRail={onOpenRail} {...slots} />);
    expect(screen.getByText("RAIL").closest("aside")).toBeInTheDocument();
    expect(screen.getByText("MAIN")).toBeInTheDocument();
  });

  it("below md the rail is a Sheet drawer whose scrim closes it through onOpenRail", async () => {
    setMockViewportWidth(390);
    const user = userEvent.setup();
    const onOpenRail = vi.fn();
    render(<WorkspaceShell railOpen panelOpen={false} onOpenRail={onOpenRail} {...slots} />);
    // The rail content mounts inside the Sheet (drawer), not the desktop column.
    expect(await screen.findByText("RAIL")).toBeInTheDocument();
    // Escape is the Sheet's close gesture; the provider forwards false to onOpenRail.
    await user.keyboard("{Escape}");
    expect(onOpenRail).toHaveBeenCalledWith(false);
  });

  it("SessionHeader hides the toolbar action cluster (usage/share/notify/Compact/Reset) at every width", () => {
    render(
      <SidebarProvider>
      <SessionHeader
        bot={bot()}
        vm={emptyVM()}
        status="open"
        workspace={ws()}
        railOpen={false}
        panelOpen={false}
        onExpandRail={vi.fn()}
        onTogglePanel={vi.fn()}
        onCompact={vi.fn()}
        onReset={vi.fn()}
        onShare={vi.fn()}
        notifications={{ supported: true, permission: "granted", enabled: false, onToggle: vi.fn() }}
      />
      </SidebarProvider>,
    );
    // The five items live in one `hidden` container: not in the accessibility tree, not tabbable,
    // and the `hidden` attribute beats the `md:inline-flex`/`sm:inline` per-item overrides.
    const cluster = document.querySelector("header div[hidden]");
    expect(cluster).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.queryByRole("button", { name: /分享/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "通知" })).toBeNull();
    const usageBadge = document.querySelector("[aria-label^='Usage:']");
    expect(usageBadge).not.toBeNull();
    expect(usageBadge!.closest("[hidden]")).toBe(cluster);
    expect(usageBadge).not.toBeVisible();
    // …while the rest of the header chrome is untouched.
    expect(screen.getByRole("heading", { name: "main" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle side panel" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "会话状态" })).toBeInTheDocument();
  });
});
