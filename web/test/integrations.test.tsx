// AMP13-integrations (revised): install/enable/uninstall UI — direct render, fetch mock.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { integrationsPanel, type IntegrationInstall } from "../src/panels/integrations";
import { WorkspaceContext, type Workspace, type WorkspaceContextValue } from "../src/lib/workspaces";
import type { PanelContext } from "../src/panels/types";
import type { BotSummary, ConversationVM } from "../src/types";

const vm = { messages: [], busy: false, inbox: [], usage: {}, agent: {}, compacting: 0, toolStash: {} } as unknown as ConversationVM;
const bot = { id: "b1", name: "main", conversationId: 1, model: { provider: "faux", modelId: "m" }, busy: false, queued: 0 } as BotSummary;
const ws = { id: "ws1", name: "ws", repo: "acme/app", baseBranch: "main", branch: "tarsbot/x", status: "ready", steps: [] } as unknown as Workspace;
const wsCtx: WorkspaceContextValue = { workspace: ws, onUpdate: () => {}, onChanged: () => {} };

const INFO = {
  kinds: ["skill", "skill-file", "mcp"],
  mcp: { protocolVersion: "2025-03-26", transport: "streamable-http", oauth: false },
  skills: { scanDirs: ["."], file: "SKILL.md" },
  slack: { implemented: false, reason: "Slack 集成未配置、未实现。" },
};

const SKILL_INSTALL: IntegrationInstall = {
  id: "int_s1",
  kind: "skill",
  workspaceId: "ws1",
  name: "review-code",
  description: "review code",
  enabled: true,
  source: { type: "upload" },
};

const MCP_INSTALL: IntegrationInstall = {
  id: "int_m1",
  kind: "mcp",
  workspaceId: "ws1",
  name: "exa",
  enabled: true,
  source: { type: "http", url: "https://mcp.exa.ai/mcp", transport: "streamable-http" },
  tools: [{ name: "mcp__exa__search_web" }],
  toolCount: 1,
};

function ctxOf(extra: Partial<PanelContext> = {}): PanelContext {
  return { bots: [bot], vm, bot, ...extra };
}

function renderPanel(ctx = ctxOf(), wsValue: WorkspaceContextValue | null = wsCtx) {
  const body = <integrationsPanel.Component {...ctx} />;
  return render(wsValue ? <WorkspaceContext.Provider value={wsValue}>{body}</WorkspaceContext.Provider> : body);
}

let fetches: { url: string; method: string; body?: unknown }[];
let responder: (url: string, body?: unknown) => { status: number; data: unknown };

function mockFetch(handler: (url: string, body?: unknown) => { status: number; data: unknown }) {
  responder = handler;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fetches.push({ url, method: init?.method ?? "GET", body });
    const r = responder(url, body);
    return new Response(JSON.stringify(r.data), { status: r.status, headers: { "content-type": "application/json" } });
  });
}

beforeEach(() => {
  fetches = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("integrations panel", () => {
  it("exports a PanelDefinition with a direct-renderable Component", () => {
    expect(integrationsPanel.id).toBe("integrations");
    expect(integrationsPanel.title).toBeTruthy();
  });

  it("lists installed integrations with scope/source and enable/disable/uninstall", async () => {
    const user = userEvent.setup();
    let installs = [SKILL_INSTALL, MCP_INSTALL];
    mockFetch((url, body) => {
      if (url === "/api/integrations") return { status: 200, data: INFO };
      if (url === `/api/workspaces/${ws.id}/integrations` && !body) return { status: 200, data: { installs } };
      if (url.endsWith("/enable")) {
        installs = installs.map((i) => (i.id === "int_s1" ? { ...i, enabled: false } : i));
        return { status: 200, data: { install: { ...SKILL_INSTALL, enabled: false }, applied: { configured: 1, failed: [] } } };
      }
      if (url.endsWith("/uninstall")) {
        installs = installs.filter((i) => i.id !== "int_m1");
        return { status: 200, data: { removed: { id: "int_m1" }, applied: { configured: 1, failed: [] } } };
      }
      return { status: 404, data: { error: "nope" } };
    });
    renderPanel();
    const skill = await screen.findByTestId("install-int_s1");
    expect(within(skill).getByText("review-code")).toBeInTheDocument();
    const mcp = screen.getByTestId("install-int_m1");
    expect(within(mcp).getByText(/mcp\.exa\.ai/)).toBeInTheDocument();
    expect(within(mcp).getByText(/1 工具/)).toBeInTheDocument();
    expect(within(mcp).getByText("mcp__exa__search_web")).toBeInTheDocument();

    await user.click(within(skill).getByRole("button", { name: "停用 review-code" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/已停用/));
    expect(fetches.find((f) => f.url.endsWith("/int_s1/enable"))?.body).toEqual({ enabled: false });

    await user.click(within(screen.getByTestId("install-int_m1")).getByRole("button", { name: "卸载 exa" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/已卸载 exa/));
    expect(screen.queryByTestId("install-int_m1")).not.toBeInTheDocument();
  });

  it("installs a pasted skill: POST kind=skill with content snapshot", async () => {
    const user = userEvent.setup();
    let installs: IntegrationInstall[] = [];
    mockFetch((url, body) => {
      if (url === "/api/integrations") return { status: 200, data: INFO };
      if (url === `/api/workspaces/${ws.id}/integrations` && body === undefined) return { status: 200, data: { installs } };
      if (url === `/api/workspaces/${ws.id}/integrations` && (body as { kind?: string })?.kind === "skill") {
        installs = [SKILL_INSTALL];
        return { status: 200, data: { install: SKILL_INSTALL } };
      }
      return { status: 404, data: { error: "nope" } };
    });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "安装 Skill（粘贴）" }));
    await user.type(screen.getByLabelText("SKILL.md 内容"), "---\nname: review-code\n---\nbody");
    await user.click(screen.getByRole("button", { name: "安装 Skill" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Skill 已安装/));
    const post = fetches.find((f) => f.method === "POST" && f.url === `/api/workspaces/${ws.id}/integrations`);
    expect(post?.body).toMatchObject({ kind: "skill", content: expect.stringContaining("review-code") });
    expect(await screen.findByTestId("install-int_s1")).toBeInTheDocument();
  });

  it("installs an MCP endpoint: POST kind=mcp with url + tokenEnv name, no secret field", async () => {
    const user = userEvent.setup();
    mockFetch((url, body) => {
      if (url === "/api/integrations") return { status: 200, data: INFO };
      if (url === `/api/workspaces/${ws.id}/integrations` && body === undefined) return { status: 200, data: { installs: [] } };
      if ((body as { kind?: string })?.kind === "mcp") return { status: 200, data: { install: MCP_INSTALL } };
      return { status: 404, data: { error: "nope" } };
    });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "添加 MCP 服务端" }));
    await user.type(screen.getByLabelText("服务端名称"), "exa");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://mcp.exa.ai/mcp");
    await user.type(screen.getByLabelText("凭据环境变量名（可选）"), "EXA_API_KEY");
    await user.click(screen.getByRole("button", { name: "校验并安装" }));
    const post = fetches.find((f) => f.method === "POST" && (f.body as { kind?: string })?.kind === "mcp");
    expect(post?.body).toEqual({ kind: "mcp", name: "exa", url: "https://mcp.exa.ai/mcp", tokenEnv: "EXA_API_KEY" });
    expect(JSON.stringify(post?.body)).not.toMatch(/secret|password|token["']?:/i);
  });

  it("shows an error from the server instead of silent failure", async () => {
    const user = userEvent.setup();
    mockFetch((url, body) => {
      if (url === "/api/integrations") return { status: 200, data: INFO };
      if (url === `/api/workspaces/${ws.id}/integrations` && body === undefined) return { status: 200, data: { installs: [] } };
      if ((body as { kind?: string })?.kind === "mcp") return { status: 502, data: { error: "MCP server answered HTTP 500" } };
      return { status: 404, data: { error: "nope" } };
    });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "添加 MCP 服务端" }));
    await user.type(screen.getByLabelText("服务端名称"), "exa");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://mcp.exa.ai/mcp");
    await user.click(screen.getByRole("button", { name: "校验并安装" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("MCP server answered HTTP 500");
  });

  it("states clearly when no workspace is selected and Slack is not implemented", async () => {
    mockFetch((url) => (url === "/api/integrations" ? { status: 200, data: INFO } : { status: 404, data: { error: "nope" } }));
    renderPanel(ctxOf({ bot: undefined }), { workspace: undefined, onUpdate: () => {}, onChanged: () => {} });
    expect(await screen.findByText(/选择一个工作区后管理集成/)).toBeInTheDocument();
    expect(await screen.findByText(/未配置、未实现。/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /slack/i })).not.toBeInTheDocument();
  });
});
