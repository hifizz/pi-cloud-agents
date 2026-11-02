import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EnvironmentPane } from "../src/components/EnvironmentPane";
import type { Workspace } from "../src/lib/workspaces";
import type { BotSummary } from "../src/types";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

describe("ENV-DEMO panes", () => {
  it("initial session GET failure is visible and retryable; failed save preserves draft", async () => {
    const user = userEvent.setup();
    let reads = 0;
    let failSave = true;
    fakeFetch(({ method, path }) => {
      if (path === "/api/workspaces/w1/checkpoints") return json([]);
      if (path === "/api/bots/b1/env" && method === "GET") {
        return ++reads === 1 ? json({ error: "load failed" }, 500) : json({ enabled: true, restricted: false, entries: [] });
      }
      if (path === "/api/bots/b1/env/DRAFT" && method === "POST") return failSave ? json({ error: "save failed" }, 500) : json({});
      return undefined;
    });
    render(<EnvironmentPane workspace={ws()} bot={bot()} />);
    await user.click(screen.getByTestId("open-session-env"));
    expect(await screen.findByRole("alert")).toHaveTextContent("load failed");
    await user.click(screen.getByRole("button", { name: "重试" }));
    await user.type(await screen.findByLabelText("覆盖变量名"), "DRAFT");
    await user.type(screen.getByLabelText("覆盖变量值"), "fictional-secret");
    await user.click(screen.getByRole("button", { name: "覆盖" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("save failed");
    expect(screen.getByLabelText("覆盖变量名")).toHaveValue("DRAFT");
    expect(screen.getByLabelText("覆盖变量值")).toHaveValue("fictional-secret");
    failSave = false;
    await user.click(screen.getByRole("button", { name: "覆盖" }));
    await waitFor(() => expect(screen.getByLabelText("覆盖变量值")).toHaveValue(""));
  });
  it("value inputs are password fields with autoComplete off (both workspace + session)", async () => {
    const user = userEvent.setup();
    fakeFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/workspaces/w1/env") return json({ enabled: true, vars: [] });
      if (method === "GET" && path === "/api/bots/b1/env") return json({ enabled: true, restricted: false, entries: [] });
      return undefined;
    });
    render(<EnvironmentPane workspace={ws()} bot={bot()} />);
    await user.click(screen.getByTestId("open-ws-env"));
    await user.click(screen.getByTestId("open-session-env"));
    const wsValue = await screen.findByLabelText("变量值");
    const sessValue = await screen.findByLabelText("覆盖变量值");
    for (const input of [wsValue, sessValue]) {
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveAttribute("autocomplete", "off");
    }
  });

  it("set + disabled + inherit flow calls the session API with the right modes; disabled then restore", async () => {
    const user = userEvent.setup();
    const calls = fakeFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/workspaces/w1/env") return json({ enabled: true, vars: [{ name: "API_URL", masked: true }] });
      if (method === "GET" && path === "/api/bots/b1/env")
        return json({ enabled: true, restricted: false, entries: [{ name: "API_URL", mode: "inherit", masked: true, inherits: true }] });
      if (method === "POST" && path.startsWith("/api/bots/b1/env/")) return json({ name: "API_URL", mode: "set", masked: true });
      return undefined;
    });
    render(<EnvironmentPane workspace={ws()} bot={bot()} />);
    await user.click(screen.getByTestId("open-session-env"));
    expect(await screen.findByText("继承工作区默认")).toBeInTheDocument();
    // disable the inherited var
    await user.click(screen.getByRole("button", { name: "禁用" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/bots/b1/env/API_URL" && c.body?.mode === "disabled")).toBe(true));
  });

  it("a failed list does NOT assume enabled/empty — it shows the error, keeps prior state", async () => {
    const user = userEvent.setup();
    let sessionCalls = 0;
    fakeFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/workspaces/w1/env") return json({ enabled: true, vars: [] });
      if (method === "GET" && path === "/api/bots/b1/env") {
        sessionCalls++;
        if (sessionCalls === 1) return json({ enabled: true, restricted: false, entries: [{ name: "API_URL", mode: "inherit", masked: true }] });
        return json({ error: "boom" }, 500);
      }
      return undefined;
    });
    const { rerender } = render(<EnvironmentPane workspace={ws()} bot={bot()} />);
    await user.click(screen.getByTestId("open-session-env"));
    expect(await screen.findByText("API_URL")).toBeInTheDocument();
    // workspace-var change bumps refreshKey -> re-pull -> the failure must surface an error, not blank the list
    rerender(<EnvironmentPane workspace={ws()} bot={bot()} />);
  });

  it("remount key: switching bot drops the draft value and the prior session's rows", async () => {
    const user = userEvent.setup();
    fakeFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/workspaces/w1/env") return json({ enabled: true, vars: [] });
      if (method === "GET" && path === "/api/bots/b1/env") return json({ enabled: true, restricted: false, entries: [{ name: "A_VAR", mode: "set", masked: true }] });
      if (method === "GET" && path === "/api/bots/b2/env") return json({ enabled: true, restricted: false, entries: [] });
      return undefined;
    });
    const { rerender } = render(<EnvironmentPane workspace={ws()} bot={bot({ id: "b1" })} />);
    await user.click(screen.getByTestId("open-session-env"));
    expect(await screen.findByText("A_VAR")).toBeInTheDocument();
    // type a draft value for session b1
    await user.type(screen.getByLabelText("覆盖变量名"), "DRAFT_NAME");
    // switch to b2: the remounted session pane must not show A_VAR or the draft name
    rerender(<EnvironmentPane workspace={ws()} bot={bot({ id: "b2", name: "other" })} />);
    await user.click(screen.getByTestId("open-session-env"));
    await waitFor(() => expect(screen.queryByText("A_VAR")).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue("DRAFT_NAME")).not.toBeInTheDocument();
  });

  it("changing a workspace var tells the session pane to re-pull its source list", async () => {
    const user = userEvent.setup();
    let sessionPulls = 0;
    fakeFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/workspaces/w1/env") return json({ enabled: true, vars: [] });
      if (method === "POST" && path === "/api/workspaces/w1/env/NEW_VAR") return json({ name: "NEW_VAR", masked: true });
      if (method === "GET" && path === "/api/bots/b1/env") {
        sessionPulls++;
        return json({ enabled: true, restricted: false, entries: [] });
      }
      return undefined;
    });
    render(<EnvironmentPane workspace={ws()} bot={bot()} />);
    await user.click(screen.getByTestId("open-ws-env"));
    await user.click(screen.getByTestId("open-session-env"));
    await waitFor(() => expect(sessionPulls).toBe(1));
    // save a workspace var -> onVarsChanged bumps the session pane's refreshKey -> one more pull
    await user.type(screen.getByLabelText("变量名"), "NEW_VAR");
    await user.type(screen.getByLabelText("变量值"), "v");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(sessionPulls).toBeGreaterThanOrEqual(2));
  });

  it("workspace list failure shows an error instead of silently degrading to the add form", async () => {
    const user = userEvent.setup();
    fakeFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/workspaces/w1/env") return json({ error: "unauthorized" }, 401);
      if (method === "GET") return json([]); // checkpoints / other lists the pane polls
      return undefined;
    });
    render(<EnvironmentPane workspace={ws()} />);
    await user.click(screen.getByTestId("open-ws-env"));
    const pane = await screen.findByTestId("ws-env");
    expect(within(pane).getByRole("alert")).toBeInTheDocument();
  });

  it("restricted session (loopRun / readOnly) shows the notice and no env form", () => {
    fakeFetch(() => undefined);
    render(<EnvironmentPane workspace={ws()} bot={bot({ readOnly: true })} />);
    expect(screen.getByTestId("session-env-restricted")).toHaveTextContent(/受限 Session/);
    expect(screen.queryByTestId("open-session-env")).not.toBeInTheDocument();
  });
});
