import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanelHost } from "../src/shell/PanelHost";
import { usePanelState } from "../src/shell/usePanelState";
import { useState } from "react";
import { WorkspaceShell } from "../src/shell/WorkspaceShell";
import { setMockViewportWidth } from "./helpers/viewport";
import { BotList } from "../src/components/BotList";
import { RoutinesPanel } from "../src/components/RoutinesPanel";
import { EnvironmentPane } from "../src/components/EnvironmentPane";
import { PANELS } from "../src/panels";
import { emptyVM } from "../src/lib/reducer";
import type { PanelDefinition } from "../src/panels/types";
import type { BotSummary } from "../src/types";
import type { Workspace } from "../src/lib/workspaces";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "tars",
  conversationId: 1,
  model: { provider: "tokenrouter", modelId: "swe-2" },
  busy: false,
  queued: 0,
  ...over,
});

const fakePanels: PanelDefinition[] = [
  { id: "a", title: "Alpha", icon: "diff", Component: ({ focus }) => <p>alpha body {focus ? `focus:${focus.path}:${focus.seq}` : ""}</p>, badge: () => 3 },
  { id: "b", title: "Beta", icon: "box", Component: () => <p>beta body</p> },
];
const ctx = { bots: [], vm: emptyVM() };

describe("PanelHost", () => {
  it("renders a tab per panel with badge, shows only the active body, and switches", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<PanelHost panels={fakePanels} active="b" onSelect={onSelect} onClose={vi.fn()} ctx={ctx} />);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /Beta/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Alpha/ })).toHaveTextContent("3");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("beta body");
    expect(screen.queryByText("alpha body")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Alpha/ }));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("falls back to the first panel when active is unknown; close button calls back", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PanelHost panels={fakePanels} active="nope" onSelect={vi.fn()} onClose={onClose} ctx={ctx} focus={{ path: "x.ts", seq: 2 }} />);
    expect(screen.getByRole("tab", { name: /Alpha/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("alpha body focus:x.ts:2");
    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("registers the integrated session panels", () => {
    // Events / Integrations / Routines moved to the workspace home; a stored removed-tab selection falls back to the first panel.
    expect(PANELS.map((p) => p.id)).toEqual(["diff", "git", "files", "preview", "terminal", "environment", "search", "delegation"]);
    render(<PanelHost panels={PANELS} active="routines" onSelect={vi.fn()} onClose={vi.fn()} ctx={ctx} />);
    expect(screen.getByRole("tab", { name: /Changes/ })).toHaveAttribute("aria-selected", "true");
  });
});

describe("usePanelState", () => {
  it("defaults to open with the given active panel", () => {
    const { result } = renderHook(() => usePanelState("a"));
    expect(result.current.open).toBe(true);
    expect(result.current.active).toBe("a");
    expect(result.current.focus).toBeUndefined();
  });

  it("openPanel opens, switches, bumps focus.seq and persists", () => {
    const { result } = renderHook(() => usePanelState("a"));
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    act(() => result.current.openPanel("b", { path: "f.ts" }));
    expect(result.current.open).toBe(true);
    expect(result.current.active).toBe("b");
    expect(result.current.focus).toEqual({ path: "f.ts", seq: 1 });
    act(() => result.current.openPanel("b", { path: "f.ts" }));
    expect(result.current.focus?.seq).toBe(2);
    expect(JSON.parse(localStorage.getItem("pca.panel")!)).toEqual({ open: true, active: "b" });

    // focus is only delivered while its target panel is active
    act(() => result.current.select("a"));
    expect(result.current.focus).toBeUndefined();
    act(() => result.current.select("b"));
    expect(result.current.focus?.seq).toBe(2);

    const again = renderHook(() => usePanelState("a"));
    expect(again.result.current.active).toBe("b");
  });

  it("falls back to defaults on corrupt storage", () => {
    localStorage.setItem("pca.panel", "{not json");
    const { result } = renderHook(() => usePanelState("a"));
    expect(result.current.open).toBe(true);
    expect(result.current.active).toBe("a");
    localStorage.setItem("pca.panel", JSON.stringify({ open: "yes", active: 5 }));
    const second = renderHook(() => usePanelState("a"));
    expect(second.result.current.open).toBe(true);
    expect(second.result.current.active).toBe("a");
  });
});

describe("WorkspaceShell", () => {
  const slots = { rail: <p>RAIL</p>, main: <p>MAIN</p>, panel: <p>PANEL</p> };
  it("renders all three columns", () => {
    render(<WorkspaceShell railOpen panelOpen {...slots} />);
    expect(screen.getByText("RAIL")).toBeInTheDocument();
    expect(screen.getByText("MAIN")).toBeInTheDocument();
    expect(screen.getByText("PANEL")).toBeInTheDocument();
  });
  it("omits closed columns", () => {
    render(<WorkspaceShell railOpen={false} panelOpen={false} {...slots} />);
    expect(screen.queryByText("RAIL")).not.toBeInTheDocument();
    expect(screen.queryByText("PANEL")).not.toBeInTheDocument();
    expect(screen.getByText("MAIN")).toBeInTheDocument();
  });

  it("renders a labeled separator for each open column boundary", () => {
    // xl+ width so the panel is an inline column with its own separator.
    setMockViewportWidth(1440);
    render(<WorkspaceShell railOpen panelOpen {...slots} />);
    expect(screen.getByRole("separator", { name: "调整侧边栏宽度" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整面板宽度" })).toBeInTheDocument();
  });

  it("leaves no stray separator next to a closed column", () => {
    setMockViewportWidth(1440);
    const { rerender } = render(<WorkspaceShell railOpen panelOpen {...slots} />);
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    rerender(<WorkspaceShell railOpen={false} panelOpen={false} {...slots} />);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    rerender(<WorkspaceShell railOpen panelOpen={false} {...slots} />);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(screen.getByRole("separator", { name: "调整侧边栏宽度" })).toBeInTheDocument();
  });

  it("keeps each column mounted exactly once (no duplicated business content)", () => {
    render(<WorkspaceShell railOpen panelOpen {...slots} />);
    expect(screen.getAllByText("MAIN")).toHaveLength(1);
    expect(screen.getAllByText("PANEL")).toHaveLength(1);
    expect(screen.getAllByText("RAIL")).toHaveLength(1);
  });

  it("tolerates corrupt stored layout and still renders", () => {
    localStorage.setItem("pca.shell.layout.v1", "{not json");
    const first = render(<WorkspaceShell railOpen panelOpen {...slots} />);
    expect(first.getByText("MAIN")).toBeInTheDocument();
    first.unmount();
    localStorage.setItem("pca.shell.layout.v1", JSON.stringify({ rail: "wide", panel: null }));
    const second = render(<WorkspaceShell railOpen panelOpen {...slots} />);
    expect(second.getByText("MAIN")).toBeInTheDocument();
    second.unmount();
  });

  it("reads stored layout without crashing; invalid shapes fall back to defaults", () => {
    // A well-formed stored layout is accepted (rendered without error) and a corrupt one falls back.
    // jsdom has no real layout, so we can't assert the measured pixel width here — only that the
    // stored value path is exercised and the shell still renders all three columns.
    localStorage.setItem("pca.shell.layout.v1", JSON.stringify({ rail: 300, panel: 500 }));
    render(<WorkspaceShell railOpen panelOpen {...slots} />);
    expect(screen.getByText("RAIL")).toBeInTheDocument();
    expect(screen.getByText("PANEL")).toBeInTheDocument();
  });

  it("keeps mount identity for stateful content across the md and xl breakpoints", () => {
    // A stateful child must not remount when the viewport crosses a breakpoint — the whole point of
    // the single-tree layout is that chat input and PTY state survive. Count mounts via useState
    // initializers (runs once per real mount, not per render or per DOM node).
    const mounts: Record<string, number> = {};
    function Probe({ id }: { id: string }) {
      const [n] = useState(() => (mounts[id] = (mounts[id] ?? 0) + 1));
      return <span data-probe={id}>{id}:{n}</span>;
    }
    const stateful = { rail: <Probe id="rail" />, main: <Probe id="main" />, panel: <Probe id="panel" /> };
    setMockViewportWidth(1440);
    render(<WorkspaceShell railOpen panelOpen {...stateful} />);
    expect(mounts).toEqual({ rail: 1, main: 1, panel: 1 });
    // Cross below xl (panel inline -> overlay drawer), then below md (rail inline -> drawer), back up.
    setMockViewportWidth(900);
    setMockViewportWidth(390);
    setMockViewportWidth(1440);
    expect(mounts).toEqual({ rail: 1, main: 1, panel: 1 });
  });

  it("keeps the previous panel width stored while it is an overlay (md..xl)", () => {
    // At 1024 the panel is below xl (an overlay, ~0 size in the group). Persisting must not
    // overwrite the stored panel width with ~0 — it keeps the last inline value.
    localStorage.setItem("pca.shell.layout.v1", JSON.stringify({ rail: 272, panel: 500 }));
    setMockViewportWidth(1024);
    render(<WorkspaceShell railOpen panelOpen {...slots} />);
    const persisted = JSON.parse(localStorage.getItem("pca.shell.layout.v1")!);
    expect(persisted.panel).toBe(500);
  });
});

describe("BotList search", () => {
  it("filters workspaces by name", async () => {
    const user = userEvent.setup();
    const mk = (id: string, name: string, botId: string): Workspace => ({
      id, name, repo: "o/r", baseBranch: "main", branch: `tarsbot/${id}`, status: "ready", steps: [], botId,
    });
    const workspaces = [mk("w1", "tars", "b1"), mk("w2", "reviewer", "b2"), mk("w3", "Builder", "b3")];
    const bots = [bot(), bot({ id: "b2", name: "reviewer" }), bot({ id: "b3", name: "Builder" })];
    render(<BotList workspaces={workspaces} bots={bots} onSelectWorkspace={vi.fn()} onSelectBot={vi.fn()} onNewWorkspace={vi.fn()} />);
    await user.type(screen.getByLabelText("搜索工作区"), "rev");
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.queryByText("tars")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("搜索工作区"));
    await user.type(screen.getByLabelText("搜索工作区"), "BUILD");
    expect(screen.getByText("Builder")).toBeInTheDocument();
    expect(screen.queryByText("reviewer")).not.toBeInTheDocument();
  });
});

describe("RoutinesPanel embedded", () => {
  it("loads on mount without a toggle button", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "r1", bot: "tars", botId: "b1", prompt: "ping", everyMs: 60_000, enabled: true }]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    render(<RoutinesPanel bots={[bot()]} embedded />);
    expect(await screen.findByTestId("routine-item")).toHaveTextContent("ping");
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^routines/i })).not.toBeInTheDocument();
  });
});

describe("EnvironmentPane", () => {
  const ws: Workspace = {
    id: "w1", name: "fix upload", repo: "hifizz/demo", baseBranch: "main", baseCommit: "abcdef1234567", branch: "tarsbot/fix-1a2b3c",
    status: "ready", steps: [], model: "swe-2", binding: { provider: "sprites", runtimeId: "pca-0123456789abcdef", version: 2 },
  };

  it("shows loading / empty state without a workspace", () => {
    const { rerender } = render(<EnvironmentPane loading />);
    expect(screen.getByText("加载中…")).toBeInTheDocument();
    rerender(<EnvironmentPane />);
    expect(screen.getByText(/还没有工作区/)).toBeInTheDocument();
  });

  it("renders the workspace: repo, base branch + commit, work branch, environment name, binding version, model", () => {
    const vm = { agent: { modelId: "glm-5.3", thinkingLevel: "high" } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    render(<EnvironmentPane workspace={ws} bot={bot()} vm={vm} />);
    const card = screen.getByTestId("sprite-card");
    expect(card).toHaveAttribute("data-sandbox", "sprites");
    expect(card).toHaveTextContent("hifizz/demo");
    expect(card).toHaveTextContent("main");
    expect(card).toHaveTextContent("abcdef1");
    expect(card).not.toHaveTextContent("abcdef12");
    expect(card).toHaveTextContent("tarsbot/fix-1a2b3c");
    expect(card).toHaveTextContent("sprites · abcdef");
    expect(card).toHaveTextContent("v2");
    expect(card).toHaveTextContent("glm-5.3");
    expect(card).toHaveTextContent("high");
  });

  it("never requests /api/space", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    render(<EnvironmentPane workspace={ws} />);
    for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toContain("/api/space");
  });
});
