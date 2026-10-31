import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EnvironmentPane } from "../src/components/EnvironmentPane";
import { WorkspaceContext, type Workspace } from "../src/lib/workspaces";
import type { BotSummary } from "../src/types";

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  name: "review ws",
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

const exec = (id: string, issue = 12): BotSummary =>
  bot({
    id,
    name: `issue-${issue}-exec-${id}`,
    workspaceId: "w1",
    issueLoop: { issue, baseBranch: "main", pinnedSha: "a".repeat(40), dir: `/e-${id}`, branch: `tarsbot/issue-${issue}-${id}`, sourceBotId: "d1" },
  });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const pane = (b: BotSummary) => (
  <WorkspaceContext.Provider value={{ workspace: ws(), loading: false, onUpdate: vi.fn(), onChanged: vi.fn() }}>
    <EnvironmentPane bot={b} vm={{ agent: {} }} />
  </WorkspaceContext.Provider>
);

describe("review-regression: EnvironmentPane result form across session switches", () => {
  it("a result form opened on execution A does not leak into execution B when the session prop changes", async () => {
    const user = userEvent.setup();
    const calls: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ result: { botId: "e2", summary: "x", testsReportedByHuman: null, pull: null, issue: 12, sourceBotId: "d1", reportedAt: "t" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { rerender } = render(pane(exec("e1")));
    await user.click(screen.getByTestId("open-result-form"));
    await user.type(screen.getByLabelText(/结果摘要/), "属于 e1 的草稿");
    expect(screen.getByLabelText(/结果摘要/)).toHaveValue("属于 e1 的草稿");

    // Switch to another execution session while the form is open (the panel is not keyed by bot).
    rerender(pane(exec("e2")));

    // The draft for e1 must not post to e2: the form is closed/remounted for the new session.
    const summary = screen.queryByLabelText(/结果摘要/);
    if (summary) expect(summary).not.toHaveValue("属于 e1 的草稿");
    // Whatever remains open can only target e2 — never post e1's draft to e2.
    const submit = screen.queryByRole("button", { name: "提交结果" });
    if (submit && !submit.hasAttribute("disabled")) await user.click(submit);
    for (const c of calls) {
      expect(c.url).toBe("/api/workspaces/w1/sessions/e2/result");
      expect((c.body as { summary?: string }).summary).not.toBe("属于 e1 的草稿");
    }
  });

  it("a review session shows the PR review row and its detached worktree", () => {
    const review = bot({ id: "r1", name: "pr-5-review", workspaceId: "w1", review: { pr: 5, title: "Add feature", headSha: "d".repeat(40), dir: "/home/sprite/reviews/w1/pr-5-ab12cd34" } });
    render(pane(review));
    expect(screen.getByText("/home/sprite/reviews/w1/pr-5-ab12cd34")).toBeInTheDocument();
    expect(screen.getByText("detached @ ddddddd")).toBeInTheDocument();
    // review sessions never get the execution result form or the publish button
    expect(screen.queryByTestId("open-result-form")).toBeNull();
    expect(screen.queryByTestId("open-publish-task")).toBeNull();
  });
});
