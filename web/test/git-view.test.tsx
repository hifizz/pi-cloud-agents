// AMP13-git: the Git panel renders the real status/log/compare payloads from the git-view API, lets the user pick
// a file / commit / base ref to load the matching diff, and refreshes. Fetch is faked at the boundary; assertions
// are on rendered UI and the actual request paths.
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitPanel } from "../src/panels/git";
import type { PanelContext } from "../src/panels/types";
import type { BotSummary, ConversationVM } from "../src/types";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

interface Call {
  method: string;
  path: string;
}

function fakeFetch(handler: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const call: Call = { method: (init as RequestInit | undefined)?.method ?? "GET", path: url.pathname + url.search };
    calls.push(call);
    return (await handler(call)) ?? json({ error: `unexpected ${call.method} ${call.path}` }, 404);
  });
  return calls;
}

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "session-1",
  conversationId: 42,
  model: { provider: "faux", modelId: "faux-1" },
  busy: false,
  queued: 0,
  ...over,
});

const vm = { messages: [], busy: false, inbox: [], usage: {}, agent: {}, compacting: 0, toolStash: {} } as unknown as ConversationVM;
const ctx = (over: Partial<PanelContext> = {}): PanelContext => ({ bots: [bot()], bot: bot(), vm, ...over });

const STATUS = {
  dir: "/home/sprite/sessions/w1/s-1",
  head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  branch: null,
  files: [
    { path: "src/app.ts", status: " M", kind: "unstaged" },
    { path: "notes.md", status: "??", kind: "untracked" },
    { path: "gone.ts", status: "D ", kind: "staged" },
  ],
  filesTruncated: false,
};

const LOG = {
  commits: [{ sha: "b".repeat(40), short: "bbbbbbb", author: "fizz", email: "f@x", at: "2026-01-01", subject: "first commit", parents: [] }],
};

const REFS = { refs: [{ name: "main", sha: "c".repeat(40), kind: "branch" }], truncated: false };

const DIFF = { diff: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n", truncated: false };

afterEach(() => vi.restoreAllMocks());

describe("GitPanel", () => {
  it("loads status + log on mount, shows classified files and commits", async () => {
    const calls = fakeFetch((c) => {
      if (c.path === "/api/bots/b1/git/status") return json(STATUS);
      if (c.path === "/api/bots/b1/git/log?limit=50") return json(LOG);
      if (c.path === "/api/bots/b1/git/refs") return json(REFS);
      return undefined;
    });
    render(<GitPanel {...ctx()} />);
    expect(await screen.findByText("detached @ aaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("first commit")).toBeInTheDocument();
    expect(calls.map((c) => c.path).sort()).toEqual(["/api/bots/b1/git/log?limit=50", "/api/bots/b1/git/refs", "/api/bots/b1/git/status"]);
  });

  it("clicking an unstaged file requests its diff and renders it; untracked uses the untracked scope", async () => {
    const calls = fakeFetch((c) => {
      if (c.path === "/api/bots/b1/git/status") return json(STATUS);
      if (c.path.startsWith("/api/bots/b1/git/log")) return json(LOG);
      if (c.path === "/api/bots/b1/git/refs") return json(REFS);
      if (c.path === "/api/bots/b1/git/diff?scope=unstaged&path=src%2Fapp.ts") return json(DIFF);
      if (c.path === "/api/bots/b1/git/diff?scope=untracked&path=notes.md") return json({ diff: "diff --git a/notes.md b/notes.md\n@@ -0,0 +1 @@\n+hi\n" });
      return undefined;
    });
    const user = userEvent.setup();
    render(<GitPanel {...ctx()} />);
    await screen.findByText("src/app.ts");
    await user.click(screen.getByText("src/app.ts"));
    expect(await screen.findByText("new")).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toContain("/api/bots/b1/git/diff?scope=unstaged&path=src%2Fapp.ts");
    await user.click(screen.getByText("notes.md"));
    expect(await screen.findByText("hi")).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toContain("/api/bots/b1/git/diff?scope=untracked&path=notes.md");
  });

  it("clicking a commit loads its diff; picking a base ref loads the compare file list", async () => {
    const calls = fakeFetch((c) => {
      if (c.path === "/api/bots/b1/git/status") return json(STATUS);
      if (c.path.startsWith("/api/bots/b1/git/log")) return json(LOG);
      if (c.path.startsWith("/api/bots/b1/git/commit/")) return json({ diff: "diff --git a/f b/f\n@@ -1 +1 @@\n-x\n+y\n" });
      if (c.path === "/api/bots/b1/git/refs") return json(REFS);
      if (c.path === "/api/bots/b1/git/compare?base=main&nameStatus=1") return json({ files: [{ status: "M", path: "src/app.ts" }], truncated: false });
      if (c.path === "/api/bots/b1/git/compare?base=main") return json({ diff: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-o\n+n\n" });
      return undefined;
    });
    const user = userEvent.setup();
    render(<GitPanel {...ctx()} />);
    await screen.findByText("first commit");
    await user.click(screen.getByText("first commit"));
    expect(await screen.findByText("y")).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toContain(`/api/bots/b1/git/commit/${"b".repeat(40)}/diff`);

    await user.selectOptions(screen.getByLabelText("比较基线"), "main");
    expect(await screen.findByText("n")).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toContain("/api/bots/b1/git/compare?base=main&nameStatus=1");
    expect(calls.map((c) => c.path)).toContain("/api/bots/b1/git/compare?base=main");
  });

  it("refresh re-requests status; a failed load shows the error", async () => {
    let statusCalls = 0;
    fakeFetch((c) => {
      if (c.path === "/api/bots/b1/git/status") {
        statusCalls++;
        return statusCalls === 1 ? json({ error: "workspace is not ready" }, 409) : json(STATUS);
      }
      if (c.path === "/api/bots/b1/git/refs") return json(REFS);
      if (c.path.startsWith("/api/bots/b1/git/log")) return json(LOG);
      return undefined;
    });
    const user = userEvent.setup();
    render(<GitPanel {...ctx()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("workspace is not ready");
    await user.click(screen.getByRole("button", { name: /刷新/ }));
    expect(await screen.findByText("detached @ aaaaaaa")).toBeInTheDocument();
    expect(statusCalls).toBe(2);
  });

  it("deleted and truncated diffs are labelled", async () => {
    fakeFetch((c) => {
      if (c.path === "/api/bots/b1/git/status") return json(STATUS);
      if (c.path.startsWith("/api/bots/b1/git/log")) return json(LOG);
      if (c.path === "/api/bots/b1/git/refs") return json(REFS);
      if (c.path.includes("scope=staged")) return json({ diff: "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 111..000\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n", truncated: true });
      return undefined;
    });
    const user = userEvent.setup();
    render(<GitPanel {...ctx()} />);
    await screen.findByText("gone.ts");
    await user.click(screen.getByText("gone.ts"));
    expect(await screen.findByText("deleted file mode 100644")).toBeInTheDocument();
    expect(screen.getByText("已截断")).toBeInTheDocument();
  });
});
