import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "../src/components/AuthGate";
import { api } from "../src/lib/api";

vi.mock("../src/App", async () => {
  const { api: a, auth } = await import("../src/lib/api");
  return {
    default: ({ email, onLoggedOut }: { email: string; onLoggedOut: () => void }) => (
      <div>
        <span>main for {email}</span>
        <button onClick={() => void auth.logout().finally(onLoggedOut)}>退出</button>
        <button onClick={() => void a.listBots().catch(() => {})}>load</button>
      </div>
    ),
  };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let routes: Record<string, () => Response>;
let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  routes = {};
  fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const r = routes[key];
    return r ? r() : json({ error: "nope" }, 404);
  });
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

describe("AuthGate", () => {
  it("renders the login page when /me is 401", async () => {
    routes["GET /api/auth/me"] = () => json({ error: "unauthenticated" }, 401);
    render(<AuthGate />);
    expect(await screen.findByRole("heading", { name: "pi-cloud-agents" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "使用 Google 登录" })).toHaveAttribute("href", "/api/auth/google");
    expect(screen.getByLabelText("邮箱")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("密码")).toHaveAttribute("type", "password");
  });

  it("renders the main UI when /me succeeds", async () => {
    routes["GET /api/auth/me"] = () => json({ email: "a@b.c" });
    render(<AuthGate />);
    expect(await screen.findByText("main for a@b.c")).toBeInTheDocument();
  });

  it("logs in with email + password and shows the main UI", async () => {
    routes["GET /api/auth/me"] = () => json({ error: "x" }, 401);
    routes["POST /api/auth/login"] = () => json({ email: "a@b.c" });
    const user = userEvent.setup();
    render(<AuthGate />);
    await user.type(await screen.findByLabelText("邮箱"), "a@b.c");
    await user.type(screen.getByLabelText("密码"), "pw{Enter}");
    expect(await screen.findByText("main for a@b.c")).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u]: [unknown]) => String(u) === "/api/auth/login")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ email: "a@b.c", password: "pw" });
  });

  it("shows an alert on bad credentials", async () => {
    routes["GET /api/auth/me"] = () => json({ error: "x" }, 401);
    routes["POST /api/auth/login"] = () => json({ error: "invalid email or password" }, 401);
    const user = userEvent.setup();
    render(<AuthGate />);
    await user.type(await screen.findByLabelText("邮箱"), "a@b.c");
    await user.type(screen.getByLabelText("密码"), "bad{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("邮箱或密码错误");
  });

  it("explains auth_error=denied and clears the param", async () => {
    window.history.replaceState(null, "", "/?auth_error=denied");
    routes["GET /api/auth/me"] = () => json({ error: "x" }, 401);
    render(<AuthGate />);
    expect(await screen.findByRole("alert")).toHaveTextContent("该邮箱不在允许名单");
    expect(window.location.search).toBe("");
  });

  it("shows the retry message for auth_error=state", async () => {
    window.history.replaceState(null, "", "/?auth_error=state");
    routes["GET /api/auth/me"] = () => json({ error: "x" }, 401);
    render(<AuthGate />);
    expect(await screen.findByRole("alert")).toHaveTextContent("登录失败，请重试");
  });

  it("returns to the login page when any request gets 401", async () => {
    routes["GET /api/auth/me"] = () => json({ email: "a@b.c" });
    routes["GET /api/bots"] = () => json({ error: "unauthenticated" }, 401);
    const user = userEvent.setup();
    render(<AuthGate />);
    await user.click(await screen.findByRole("button", { name: "load" }));
    expect(await screen.findByLabelText("邮箱")).toBeInTheDocument();
  });

  it("logout button calls /api/auth/logout and shows login", async () => {
    routes["GET /api/auth/me"] = () => json({ email: "a@b.c" });
    routes["POST /api/auth/logout"] = () => json({ ok: true });
    const user = userEvent.setup();
    render(<AuthGate />);
    await user.click(await screen.findByRole("button", { name: "退出" }));
    await waitFor(() => expect(screen.getByLabelText("邮箱")).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([u, i]: [unknown, unknown]) => String(u) === "/api/auth/logout" && (i as RequestInit).method === "POST")).toBe(true);
  });
});

describe("api 401 handling", () => {
  it("still throws ApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "unauthenticated" }, 401));
    await expect(api.listBots()).rejects.toMatchObject({ status: 401 });
  });
});
