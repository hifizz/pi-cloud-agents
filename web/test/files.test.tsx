// Files panel tests (AMP13-files): the panel talks to /api/bots/:id/files/* (mocked fetch); nothing
// else is stubbed. These are render-level checks only — path confinement itself is tested on the
// backend in test/files.test.mjs.
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { filesPanel } from "../src/panels/files";
import type { PanelContext } from "../src/panels/types";
import type { BotSummary, ConversationVM } from "../src/types";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "b1",
  conversationId: "conv-1",
  model: { provider: "faux", modelId: "m" },
  busy: false,
  queued: 0,
  ...over,
});

const vm = { messages: [], busy: false, inbox: [], usage: {}, agent: {}, compacting: 0, toolStash: {} } as unknown as ConversationVM;
const ctxOf = (b?: BotSummary): PanelContext => ({ bots: b ? [b] : [], bot: b, vm });

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const listing = (entries: { name: string; path: string; kind: string; size?: number; mtimeMs?: number }[]) => ({
  path: ".",
  root: "/home/sprite/sessions/x",
  truncated: false,
  entries: entries.map((e) => ({ size: 0, mtimeMs: 0, ...e })),
});

afterEach(() => vi.restoreAllMocks());

describe("filesPanel", () => {
  it("asks to select a session when there is no bot", () => {
    render(<filesPanel.Component {...ctxOf()} />);
    expect(screen.getByText(/Select a session/)).toBeInTheDocument();
  });

  it("lists the session root, reads a file on click, navigates into a directory", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/files/list?path=.")) {
        return jsonRes(
          listing([
            { name: "sub", path: "sub", kind: "directory" },
            { name: "note.txt", path: "note.txt", kind: "file", size: 12 },
            { name: ".env", path: ".env", kind: "file", size: 3 },
          ]),
        );
      }
      if (url.endsWith(`/files/list?path=${encodeURIComponent("sub")}`)) {
        return jsonRes({ path: "sub", root: "/home/sprite/sessions/x", truncated: false, entries: [] });
      }
      if (url.endsWith(`/files/read?path=${encodeURIComponent("note.txt")}`)) {
        return jsonRes({ path: "note.txt", size: 12, mtimeMs: 0, base64: btoa("hello world\n") });
      }
      return jsonRes({ error: "not found" }, 404);
    });
    render(<filesPanel.Component {...ctxOf(bot())} />);
    expect(await screen.findByText("note.txt")).toBeInTheDocument();
    expect(screen.getByText("sub")).toBeInTheDocument();
    expect(screen.getByText(".env")).toBeInTheDocument();

    await user.click(screen.getByText("note.txt"));
    expect(await screen.findByText("hello world")).toBeInTheDocument();

    await user.click(screen.getByText("sub"));
    await waitFor(() => expect(calls.some((c) => c.includes(`list?path=sub`))).toBe(true));
    expect(screen.getByText("(empty)")).toBeInTheDocument();
  });

  it("uploads a picked file into the current directory and shows its content back", async () => {
    const user = userEvent.setup();
    const posts: { path: string; body: { path: string; base64: string; overwrite?: boolean } }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/files/write")) {
        const body = JSON.parse(String(init.body));
        posts.push({ path: url, body });
        return jsonRes({ path: body.path, size: 5 });
      }
      if (url.endsWith("/files/list?path=.")) return jsonRes(listing([]));
      if (url.includes("/files/read?path=up.txt")) return jsonRes({ path: "up.txt", size: 5, mtimeMs: 0, base64: btoa("data!") });
      return jsonRes({ error: "not found" }, 404);
    });
    render(<filesPanel.Component {...ctxOf(bot())} />);
    await screen.findByText("(empty)");
    const file = new File(["data!"], "up.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("Choose file"), file);
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].body.path).toBe("up.txt");
    expect(posts[0].body.base64).toBe(btoa("data!"));
    expect(await screen.findByText("data!")).toBeInTheDocument();
  });

  it("confirms before overwriting an existing file (409 -> confirm -> overwrite:true)", async () => {
    const user = userEvent.setup();
    const bodies: { path: string; overwrite?: boolean }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (!body.overwrite) return jsonRes({ error: "File exists; pass overwrite to replace it" }, 409);
        return jsonRes({ path: body.path, size: 1 });
      }
      if (url.endsWith("/files/list?path=.")) return jsonRes(listing([]));
      if (url.includes("/files/read")) return jsonRes({ path: "x", size: 1, mtimeMs: 0, base64: btoa("x") });
      return jsonRes({});
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<filesPanel.Component {...ctxOf(bot())} />);
    await screen.findByText("(empty)");
    await user.upload(screen.getByLabelText("Choose file"), new File(["x"], "x.txt"));
    await waitFor(() => expect(bodies.length).toBe(2));
    expect(bodies[0].overwrite).toBeUndefined();
    expect(bodies[1].overwrite).toBe(true);
    expect(window.confirm).toHaveBeenCalled();
  });

  it("shows the server error instead of a silent failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes({ error: "session not ready" }, 409));
    render(<filesPanel.Component {...ctxOf(bot())} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("session not ready");
  });
});
