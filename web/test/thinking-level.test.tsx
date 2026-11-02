import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../src/lib/api";
import { Composer } from "../src/components/Chat/Composer";
import type { BotSummary } from "../src/types";
import type { Workspace } from "../src/lib/workspaces";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

const swe2Bot = { id: "b1", name: "s", conversationId: 1, model: { provider: "tokenrouter", modelId: "swe-2" }, busy: false, queued: 0 };

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("thinking-level cross-session race", () => {
  it("a save finishing after the user switched sessions never lands on the new session's selector", async () => {
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

    const botA: BotSummary = { id: "ba", name: "session-a", conversationId: 1, model: { provider: "tokenrouter", modelId: "swe-2" }, busy: false, queued: 0, workspaceId: "w1" };
    const botB: BotSummary = { id: "bb", name: "session-b", conversationId: 2, model: { provider: "tokenrouter", modelId: "swe-2" }, busy: false, queued: 0, workspaceId: "w1" };
    const w: Workspace = { id: "w1", name: "ws", repo: "o/r", baseBranch: "main", baseCommit: "3157db095cb9344e5b9cf0669657bf613d036b46", branch: "b", status: "ready", steps: [], botId: "ba", binding: { provider: "sprites", runtimeId: "pca-x", version: 1 } };

    // A's first capability GET, PATCH and refresh GET are delayed so the switch to B lands mid-load/save.
    const getA1 = deferred<Response>();
    const patchA = deferred<Response>();
    const getA2 = deferred<Response>();
    let getACount = 0;
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/bots") return Promise.resolve(json([botA, botB]));
      if (path === "/api/workspaces") return Promise.resolve(json([w]));
      if (path === "/api/routines") return Promise.resolve(json([]));
      if (method === "PATCH" && path === "/api/bots/ba/thinking-level") return patchA.promise;
      if (method === "GET" && path === "/api/bots/ba/thinking-levels") {
        getACount += 1;
        return getACount === 1 ? getA1.promise : getA2.promise;
      }
      if (method === "GET" && path === "/api/bots/bb/thinking-levels") return Promise.resolve(json({ levels: ["medium", "high", "max"], current: "medium" }));
      return Promise.resolve(json({}));
    });
    localStorage.setItem("pca.workspace", "w1");
    render(<App />);

    // Open session A while its capability GET is in flight; deliver it so the selector appears.
    await screen.findByRole("button", { name: /^session-a/ });
    await user.click(screen.getByRole("button", { name: /^session-a/ }));
    getA1.resolve(json({ levels: ["medium", "high", "max"], current: "off" }));
    await user.click(await screen.findByRole("button", { name: "思考强度：默认" }));
    await user.click(await screen.findByRole("option", { name: /^最大/ }));

    // Switch to B before A's save resolves.
    await user.click(await screen.findByRole("button", { name: /^session-b/ }));
    await screen.findByRole("button", { name: "思考强度：中" });

    // A's save now resolves: its refresh GET and finally must not touch B's selector state.
    patchA.resolve(json({ bot: { ...botA, thinkingLevel: "max" } }));
    getA2.resolve(json({ levels: ["medium", "high", "max"], current: "max" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "思考强度：中" })).not.toBeDisabled());

    // B is interactive: its selector was never stuck in the saving state A left behind.
    await user.click(screen.getByRole("button", { name: "思考强度：中" }));
    expect(await screen.findByRole("option", { name: /^最大/ })).toBeInTheDocument();
  });

  it("a failed capability load shows a retry pill, not a disabled unsupported state", async () => {
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
    const botA: BotSummary = { id: "ba", name: "session-a", conversationId: 1, model: { provider: "tokenrouter", modelId: "swe-2" }, busy: false, queued: 0, workspaceId: "w1" };
    const w: Workspace = { id: "w1", name: "ws", repo: "o/r", baseBranch: "main", baseCommit: "3157db095cb9344e5b9cf0669657bf613d036b46", branch: "b", status: "ready", steps: [], botId: "ba", binding: { provider: "sprites", runtimeId: "pca-x", version: 1 } };
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    let thinkingGetCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/bots") return Promise.resolve(json([botA]));
      if (path === "/api/workspaces") return Promise.resolve(json([w]));
      if (path === "/api/routines") return Promise.resolve(json([]));
      if (path === "/api/bots/ba/thinking-levels") {
        thinkingGetCount += 1;
        return thinkingGetCount === 1
          ? Promise.resolve(new Response("boom", { status: 500 }))
          : Promise.resolve(json({ levels: ["medium", "high", "max"], current: "high" }));
      }
      return Promise.resolve(json({}));
    });
    localStorage.setItem("pca.workspace", "w1");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^session-a/ }));

    // First load failed: a retry affordance, never a fake unsupported state.
    const retry = await screen.findByRole("button", { name: /加载失败/ });
    expect(retry).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "思考强度：当前模型不支持配置" })).toBeNull();
    await user.click(retry);
    await screen.findByRole("button", { name: "思考强度：高" });
    expect(thinkingGetCount).toBe(2);
  });
});

describe("thinking-level api + selector round-trip", () => {
  it("PATCH persists and the returned record carries the level; GET reports the effective level", async () => {
    const calls = fakeFetch((call) => {
      if (call.method === "PATCH" && call.path === "/api/bots/b1/thinking-level") {
        return json({ bot: { ...swe2Bot, thinkingLevel: call.body?.level } });
      }
      if (call.method === "GET" && call.path === "/api/bots/b1/thinking-levels") {
        return json({ levels: ["medium", "high", "max"], current: "max" });
      }
      return undefined;
    });
    const { bot } = await api.setThinkingLevel("b1", "max");
    expect(bot.thinkingLevel).toBe("max");
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/api/bots/b1/thinking-level", body: { level: "max" } });
    const res = await api.thinkingLevels("b1");
    expect(res).toEqual({ levels: ["medium", "high", "max"], current: "max" });
  });

  it("a failed PATCH propagates the error (no silent success)", async () => {
    fakeFetch((call) =>
      call.path === "/api/bots/b1/thinking-level" ? json({ error: "level must be one of: medium, high, max, off" }, 400) : undefined,
    );
    await expect(api.setThinkingLevel("b1", "low")).rejects.toThrow(/level must be one of/);
  });

  it("selector drives a save through onChange and the trigger shows the new level after a refresh", async () => {
    const user = userEvent.setup();
    let current = "high";
    fakeFetch((call) => {
      if (call.method === "PATCH" && call.path === "/api/bots/b1/thinking-level") {
        current = String(call.body?.level);
        return json({ bot: { ...swe2Bot, thinkingLevel: current } });
      }
      if (call.method === "GET" && call.path === "/api/bots/b1/thinking-levels") {
        return json({ levels: ["medium", "high", "max"], current });
      }
      return undefined;
    });
    const onThinkingLevelChange = vi.fn(async (level: string) => {
      await api.setThinkingLevel("b1", level);
      await api.thinkingLevels("b1");
    });
    const { rerender } = render(
      <Composer
        busy={false}
        onSend={() => {}}
        onAbort={() => {}}
        thinkingLevels={["medium", "high", "max"]}
        thinkingLevel="high"
        onThinkingLevelChange={onThinkingLevelChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "思考强度：高" }));
    await user.click(screen.getByRole("option", { name: /^最大/ }));
    await waitFor(() => expect(onThinkingLevelChange).toHaveBeenCalledWith("max"));
    // Parent re-renders with the refreshed effective level from the GET.
    rerender(
      <Composer
        busy={false}
        onSend={() => {}}
        onAbort={() => {}}
        thinkingLevels={["medium", "high", "max"]}
        thinkingLevel={current as "max"}
        onThinkingLevelChange={onThinkingLevelChange}
      />,
    );
    expect(screen.getByRole("button", { name: "思考强度：最大" })).toBeInTheDocument();
  });
});
