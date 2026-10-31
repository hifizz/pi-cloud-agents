import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceContext } from "../src/lib/workspaces";
import { SessionHeader } from "../src/shell/SessionHeader";
import { LoopsList } from "../src/components/LoopsList";
import { LoopRuns } from "../src/components/LoopRuns";
import { LoopEditor } from "../src/components/LoopEditor";
import { emptyVM } from "../src/lib/reducer";
import { type BotSummary } from "../src/types";
import type { Workspace } from "../src/lib/workspaces";
import { loopsApi, RUN_STATUS_LABEL, triggerLabel, type Loop, type LoopQueueView, type LoopRun } from "../src/lib/loops";

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  name: "ws",
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

const loop = (over: Partial<Loop> = {}): Loop => ({
  id: "L1",
  workspaceId: "w1",
  name: "nightly-review",
  instructions: "Review every night.",
  trigger: { kind: "schedule", freq: "daily", interval: 1, at: "18:30", tz: "UTC", startAt: 1730000000000 },
  capabilities: { code: "read", web: false, scopeToTrigger: false, github: { comment: false, label: false, openIssue: false, openPr: false }, tools: [] },
  reasoning: "auto",
  enabled: true,
  editPolicy: "owner",
  version: 2,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  ...over,
});

const run = (over: Partial<LoopRun> = {}): LoopRun => ({
  id: "r1",
  loopId: "L1",
  loopVersion: 2,
  workspaceId: "w1",
  triggerKind: "schedule",
  triggerKey: "schedule:1",
  status: "queued",
  enqueuedAt: "2026-10-31T00:00:00Z",
  ...over,
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const renderHeader = (b: BotSummary, over: Record<string, unknown> = {}) =>
  render(
    <WorkspaceContext.Provider value={{ workspace: ws(), loading: false, onUpdate: vi.fn(), onChanged: vi.fn() }}>
      <SessionHeader
        bot={b}
        vm={emptyVM()}
        status="open"
        workspace={ws()}
        bots={[b]}
        onSelectBot={vi.fn()}
        onOpenLoop={vi.fn()}
        railOpen={false}
        panelOpen={false}
        onExpandRail={vi.fn()}
        onTogglePanel={vi.fn()}
        onCompact={vi.fn()}
        onReset={vi.fn()}
        {...over}
      />
    </WorkspaceContext.Provider>,
  );

describe("loops: triggerLabel", () => {
  it("manual / schedule / webhook / github labels", () => {
    expect(triggerLabel({ kind: "manual" })).toBe("手动");
    expect(triggerLabel({ kind: "webhook" })).toBe("Webhook");
    expect(triggerLabel({ kind: "github_issue", event: "opened" })).toContain("GitHub issue");
    expect(triggerLabel({ kind: "schedule", freq: "daily", interval: 1, at: "18:30", tz: "UTC", startAt: 1 })).toBe("每天 18:30 UTC");
    expect(triggerLabel({ kind: "schedule", freq: "hourly", interval: 2, tz: "Asia/Shanghai", startAt: 1 })).toBe("每 2 小时  Asia/Shanghai");
    expect(triggerLabel({ kind: "schedule", freq: "weekly", interval: 1, at: "09:00", tz: "UTC", startAt: 1, days: [1, 3] })).toContain("一/三");
  });
});

describe("loops: SessionHeader backlink", () => {
  it("a loop-run session shows 来自 Loop and calls onOpenLoop", async () => {
    const onOpenLoop = vi.fn();
    const b = bot({ loopRun: { loopId: "L1", runId: "r9", version: 2 } });
    renderHeader(b, { onOpenLoop });
    const back = screen.getByTestId("backlink-to-loop");
    expect(back).toHaveTextContent("来自 Loop");
    await userEvent.click(back);
    expect(onOpenLoop).toHaveBeenCalledWith("L1");
  });

  it("a normal session shows no loop backlink", () => {
    renderHeader(bot());
    expect(screen.queryByTestId("backlink-to-loop")).toBeNull();
  });
});

describe("loops: list + queue positions", () => {
  it("LoopsList renders loops with trigger label, enabled switch and Run now", async () => {
    vi.spyOn(loopsApi, "list").mockResolvedValue([loop()]);
    const runSpy = vi.spyOn(loopsApi, "run").mockResolvedValue({ runId: "r1", status: "queued" });
    render(<LoopsList workspaceId="w1" onEdit={vi.fn()} onShowRuns={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("nightly-review")).toBeInTheDocument());
    expect(screen.getByText(/每天 18:30 UTC/)).toBeInTheDocument();
    expect(screen.getByTestId("loop-last-L1")).toHaveTextContent("从未运行");
    await userEvent.click(screen.getByTestId("loop-run-L1"));
    expect(runSpy).toHaveBeenCalledWith("L1");
  });

  it("queued runs show their FIFO position; running/queued runs have a cancel button; done runs do not", async () => {
    const runs = [
      run({ id: "r9", status: "succeeded", triggerKind: "manual", botId: "b9" }),
      run({ id: "r0", status: "running" }),
      run({ id: "r1", status: "queued" }),
      run({ id: "r2", status: "queued" }),
    ];
    const queue: LoopQueueView = {
      maxConcurrent: 3,
      running: [run({ id: "r0", status: "running" })],
      queued: [run({ id: "r1", status: "queued", position: 1 }), run({ id: "r2", status: "queued", position: 2 })],
    };
    vi.spyOn(loopsApi, "runs").mockResolvedValue(runs);
    vi.spyOn(loopsApi, "queue").mockResolvedValue(queue);
    const cancelSpy = vi.spyOn(loopsApi, "cancelRun").mockResolvedValue(run({ id: "r1", status: "canceled" }));
    render(<LoopRuns loop={loop()} onOpenSession={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("run-status-r1")).toHaveTextContent("排队中 #1"));
    expect(screen.getByTestId("run-status-r2")).toHaveTextContent("排队中 #2");
    expect(screen.getByTestId("run-status-r0")).toHaveTextContent("运行中");
    expect(screen.getByTestId("run-status-r9")).toHaveTextContent(RUN_STATUS_LABEL.succeeded);
    // cancel buttons exist on the 3 active runs only
    expect(screen.getByTestId("run-cancel-r0")).toBeInTheDocument();
    expect(screen.getByTestId("run-cancel-r1")).toBeInTheDocument();
    expect(screen.getByTestId("run-cancel-r2")).toBeInTheDocument();
    expect(screen.queryByTestId("run-cancel-r9")).toBeNull();
    // open-session button on a completed run that created a bot
    expect(screen.getByTestId("run-open-r9")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("run-cancel-r1"));
    expect(cancelSpy).toHaveBeenCalledWith("r1");
  });
});

describe("loops: webhook secret acknowledge flow", () => {
  it("create-with-webhook: navigation waits for the secret acknowledge; reveal/copy/ack sequence", async () => {
    vi.spyOn(loopsApi, "create").mockResolvedValue({ loop: loop({ id: "Lw", trigger: { kind: "webhook" } }), webhookSecret: "whsec_one-time" });
    const onSaved = vi.fn();
    render(<LoopEditor workspaceId="w1" onSaved={onSaved} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), "hook-loop");
    await userEvent.selectOptions(screen.getByTestId("trigger-kind"), "webhook");
    await userEvent.type(screen.getByTestId("loop-instructions"), "do it");
    await userEvent.click(screen.getByTestId("loop-save"));

    await waitFor(() => expect(screen.getByTestId("webhook-secret")).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled(); // still in the editor — navigation is gated on the ack
    expect(screen.queryByTestId("secret-value")).toBeNull(); // hidden until reveal
    // ack is disabled until the secret was revealed (or copied)
    const ack = screen.getByTestId("ack-secret");
    expect(ack).toBeDisabled();
    await userEvent.click(screen.getByTestId("reveal-secret"));
    expect(screen.getByTestId("secret-value")).toHaveTextContent("whsec_one-time");
    expect(ack).toBeEnabled();
    await userEvent.click(ack);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "Lw" }));
  });

  it("rotate on an existing webhook loop goes through the same reveal/ack gate", async () => {
    const existing = loop({ id: "Lw", trigger: { kind: "webhook" }, hasWebhookSecret: true });
    vi.spyOn(loopsApi, "get").mockResolvedValue(existing);
    vi.spyOn(loopsApi, "rotateSecret").mockResolvedValue({ webhookSecret: "whsec_rotated" });
    const onSaved = vi.fn();
    render(<LoopEditor workspaceId="w1" loopId="Lw" onSaved={onSaved} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("rotate-secret")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("rotate-secret"));
    await waitFor(() => expect(screen.getByTestId("webhook-secret")).toBeInTheDocument());
    expect(loopsApi.rotateSecret).toHaveBeenCalledWith("Lw");
    expect(onSaved).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("reveal-secret"));
    expect(screen.getByTestId("secret-value")).toHaveTextContent("whsec_rotated");
    await userEvent.click(screen.getByTestId("ack-secret"));
    expect(onSaved).toHaveBeenCalled();
  });
});

describe("loops: delete with confirm", () => {
  it("delete requires a second click; the loop disappears after loopsApi.remove", async () => {
    const l = loop();
    vi.spyOn(loopsApi, "list").mockResolvedValue([l]);
    const removeSpy = vi.spyOn(loopsApi, "remove").mockResolvedValue({ ok: true, id: l.id });
    render(<LoopsList workspaceId="w1" onEdit={vi.fn()} onShowRuns={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("loop-delete-L1")).toBeInTheDocument());
    expect(removeSpy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("loop-delete-L1")); // arm
    expect(screen.getByTestId("loop-delete-L1")).toHaveTextContent("确认删除？");
    expect(removeSpy).not.toHaveBeenCalled(); // nothing deleted on the first click
    await userEvent.click(screen.getByTestId("loop-delete-L1")); // confirm
    expect(removeSpy).toHaveBeenCalledWith("L1");
    expect(loopsApi.list).toHaveBeenCalledTimes(2); // reloaded
  });
});

describe("loops: github trigger editor", () => {
  it("github_issue trigger builds events[] + filters", async () => {
    const create = vi.spyOn(loopsApi, "create").mockResolvedValue({ loop: loop({ id: "Lg" }) });
    render(<LoopEditor workspaceId="w1" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), "issue-bot");
    await userEvent.selectOptions(screen.getByTestId("trigger-kind"), "github_issue");
    expect(screen.getByTestId("github-trigger")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "labeled" }));
    await userEvent.type(screen.getByLabelText(/Label 过滤/), "bug");
    await userEvent.type(screen.getByTestId("loop-instructions"), "triage it");
    await userEvent.click(screen.getByTestId("loop-save"));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const input = create.mock.calls[0][1];
    expect(input.trigger).toEqual({ kind: "github_issue", events: ["opened", "labeled"], filters: { label: "bug" } });
  });
});

// Closeout: a loop run's executionResult renders REAL artifact content in EnvironmentPane (not a string check).
describe("loop run artifact render", () => {
  it("EnvironmentPane renders a loop-produced PR link from executionResult", async () => {
    const { EnvironmentPane } = await import("../src/components/EnvironmentPane");
    const ws = {
      id: "w1", name: "w", repo: "o/r", baseBranch: "main", branch: "b", cwd: "/w",
      status: "ready", binding: { provider: "sprites", runtimeId: "s", version: 1 },
      installCommand: null, testCommand: null, createdAt: "", updatedAt: "",
    } as unknown as import("../src/lib/workspaces").Workspace;
    const bot = {
      id: "b1", name: "run", status: "idle", conversationId: "c1", workspaceId: "w1",
      model: { modelId: "m" },
      loopRun: { loopId: "l", runId: "run_x", version: 1, dir: "/w/run", pinnedSha: "abc" },
      executionResult: {
        summary: "Loop run run_x opened PR #15",
        testsReportedByHuman: null,
        pull: { number: 15, title: "Loop PR #15", url: "https://github.com/o/r/pull/15" },
        issue: 5, sourceBotId: "b1", reportedAt: "2026-10-30T00:00:00Z",
      },
    } as unknown as BotSummary;
    render(<EnvironmentPane workspace={ws} bot={bot} vm={{ agent: { modelId: "m" } }} />);
    const pr = screen.getByRole("link", { name: /#15/ });
    expect(pr.getAttribute("href")).toBe("https://github.com/o/r/pull/15");
    expect(screen.getByText(/Loop run run_x opened PR #15/)).toBeTruthy();
    expect(screen.getByText("未记录")).toBeTruthy(); // automated artifact shows 未记录, never a fake human-test pass
  });
});
