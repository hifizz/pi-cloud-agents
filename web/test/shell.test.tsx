import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanelHost } from "../src/shell/PanelHost";
import { usePanelState } from "../src/shell/usePanelState";
import { WorkspaceShell } from "../src/shell/WorkspaceShell";
import { BotList } from "../src/components/BotList";
import { RoutinesPanel } from "../src/components/RoutinesPanel";
import { EnvironmentPane } from "../src/components/EnvironmentPane";
import { PANELS } from "../src/panels";
import { emptyVM } from "../src/lib/reducer";
import type { PanelDefinition } from "../src/panels/types";
import type { BotSummary } from "../src/types";

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

  it("registers diff, environment, routines and teammate panels", () => {
    expect(PANELS.map((p) => p.id)).toEqual(["diff", "environment", "routines", "teammate"]);
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
});

describe("BotList search", () => {
  it("filters bots by name", async () => {
    const user = userEvent.setup();
    const bots = [bot(), bot({ id: "b2", name: "reviewer" }), bot({ id: "b3", name: "Builder" })];
    render(<BotList bots={bots} onSelect={vi.fn()} onCreate={vi.fn()} />);
    await user.type(screen.getByLabelText("Search bots"), "rev");
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.queryByText("tars")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Search bots"));
    await user.type(screen.getByLabelText("Search bots"), "BUILD");
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
  it("shows loading / unavailable without space", () => {
    const { rerender } = render(<EnvironmentPane />);
    expect(screen.getByText("加载中…")).toBeInTheDocument();
    rerender(<EnvironmentPane failed />);
    expect(screen.getByText("执行环境信息不可用")).toBeInTheDocument();
  });

  it("renders sprites and e2b, cwd fallback and bot model", () => {
    const { rerender } = render(<EnvironmentPane space={{ sandbox: "sprites", name: "pca" }} bot={bot()} />);
    let card = screen.getByTestId("sprite-card");
    expect(card).toHaveAttribute("data-sandbox", "sprites");
    expect(card).toHaveTextContent("Sprite");
    expect(card).toHaveTextContent("pca");
    expect(card).toHaveTextContent("/home/sprite/workspace");
    expect(card).toHaveTextContent("swe-2");

    const vm = { agent: { modelId: "glm-5.3", thinkingLevel: "high", cwd: "/work" } };
    rerender(<EnvironmentPane space={{ sandbox: "e2b", name: "pca", cwd: "/home/user/workspace" }} bot={bot()} vm={vm} />);
    card = screen.getByTestId("sprite-card");
    expect(card).toHaveAttribute("data-sandbox", "e2b");
    expect(card).toHaveTextContent("E2B");
    expect(card).toHaveTextContent("/work");
    expect(card).toHaveTextContent("glm-5.3");
    expect(card).toHaveTextContent("high");

    rerender(<EnvironmentPane space={{ sandbox: "e2b", name: null, cwd: "/home/user/workspace" }} />);
    expect(screen.getByTestId("sprite-card")).toHaveTextContent("/home/user/workspace");
  });
});
