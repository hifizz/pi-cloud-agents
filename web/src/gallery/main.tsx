// Dev-only gallery of the chat component library: `npm run dev` -> http://localhost:5173/gallery.html
// Not part of the production build (vite only builds index.html). Use it to eyeball every part / tool renderer.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer, MessageList } from "../components/Chat";
import type { ChatMessage, ToolPart } from "../types";
import "../index.css";

const T0 = Date.now() - 95_000;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#27272a"/><rect x="0" y="0" width="640" height="28" fill="#3f3f46"/><text x="24" y="120" fill="#a1a1aa" font-size="28" font-family="sans-serif">desktop screenshot</text></svg>`;
const PNG = btoa(SVG);

const tool = (id: string, name: string, args: Record<string, unknown>, output = "", extra: Partial<ToolPart> = {}): ToolPart => ({
  type: "tool",
  id,
  name,
  args,
  status: "done",
  output,
  resultText: output,
  ...extra,
});

const settled: ChatMessage[] = [
  { id: "u1", entryId: 1, role: "user", at: T0, parts: [{ type: "text", text: "Open the docs site, find the install steps and patch our README accordingly." }] },
  {
    id: "a1",
    entryId: 2,
    role: "assistant",
    at: T0 + 80_000,
    parts: [
      { type: "thinking", text: "I should search first, then look at the page, then edit README.md." },
      { type: "text", text: "On it — I'll **search**, look at the page, then update the README." },
      tool("s1", "web_search", { query: "pi durable install" }, "1. Pi Durable — install\n   https://pi.dev/docs/install\n   Published: 2026-05-01\n   Install with npm i @earendil-works/pi-durable and open a harness.\n\n2. Examples\n   https://github.com/earendil-works/examples\n   Sample projects."),
      tool("d1", "desktop_launch", { name: "chromium", urls: ["https://pi.dev/docs/install"] }, "launched pid 4242"),
      tool("d2", "desktop_screenshot", {}, "", { images: [{ type: "image", data: PNG, mimeType: "image/svg+xml" }] }),
      tool("d3", "desktop_click", { pid: 4242, element_token: "s00000001:13" }, "clicked"),
      tool("d4", "desktop_type", { pid: 4242, text: "npm install" }, "typed"),
      tool("d5", "desktop_key", { keys: ["ctrl", "l"] }, "key sent"),
      tool("r1", "read", { path: "/home/cua/project/README.md", offset: 1, limit: 40 }, "# Project\n\nOld install steps\n"),
      tool("b1", "bash", { command: "cd /home/cua/project && git status --short\nnpm test" }, "M README.md\n\n> test\nall 12 tests passed"),
      tool("e1", "edit", { path: "/home/cua/project/README.md", edits: [{ oldText: "Old install steps", newText: "npm i @earendil-works/pi-durable" }] }, "Successfully replaced 1 block(s) in /home/cua/project/README.md.", {
        details: { diff: " 1 # Project\n 2 \n-3 Old install steps\n+3 npm i @earendil-works/pi-durable\n 4 " },
      }),
      tool("w1", "write", { path: "/home/cua/project/INSTALL.md", content: "# Install\n\n```sh\nnpm i @earendil-works/pi-durable\n```\n" }, "Wrote 54 bytes"),
      tool("h1", "search_history", { query: "install" }, "1. [user] (entry 4) …install steps…"),
      tool("m1", "mcp__github__create_issue", { title: "Docs drift", body: "README was stale" }, '{"number": 12}'),
      { type: "text", text: "Done. The README now points at the **npm** install command, and I added `INSTALL.md`.\n\n```sh\nnpm i @earendil-works/pi-durable\n```\n\n| file | change |\n|---|---|\n| README.md | updated |\n| INSTALL.md | new |" },
    ],
  },
];

const live: ChatMessage[] = [
  { id: "u2", entryId: 3, role: "user", at: T0, parts: [{ type: "text", text: "Now run the full test suite and keep going until it's green." }] },
  {
    id: "pending",
    role: "assistant",
    pending: true,
    parts: [
      { type: "thinking", text: "Run tests first." },
      tool("b2", "bash", { command: "npm test" }, "running 12 tests…\n", { status: "running" }),
      tool("b3", "bash", { command: "exit 3" }, "partial output\noops\n", { status: "error", diagnostics: ["Command exited with code 3"] }),
      tool("b4", "bash", { command: "sleep 100" }, "", { status: "interrupted", diagnostics: ["Tool bash was aborted"] }),
      { type: "text", text: "Tests are failing in `reducer.test.ts`, looking into it" },
    ],
  },
];

const notes: ChatMessage[] = [
  { id: "c1", entryId: 9, role: "compaction", parts: [{ type: "text", text: "Earlier the user asked for README changes; all were applied." }] },
  { id: "s1", role: "system", tone: "error", parts: [{ type: "text", text: "Task failed (generation): provider timeout" }] },
  { id: "s2", role: "system", parts: [{ type: "text", text: "Context reset." }] },
  { id: "u3", entryId: 10, role: "user", at: T0, parts: [{ type: "text", text: "and now?" }] },
  { id: "a3", entryId: 11, role: "assistant", at: T0 + 2000, stopReason: "aborted", parts: [{ type: "text", text: "Partial answer before abort" }] },
  { id: "u4", entryId: 12, role: "user", at: T0, parts: [{ type: "text", text: "again" }] },
  { id: "a4", entryId: 13, role: "assistant", at: T0 + 2000, error: "429 rate limited", parts: [] },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col border-b border-zinc-800">
      <h2 className="border-b border-zinc-900 bg-zinc-900/50 px-4 py-1.5 font-mono text-xs text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

function Gallery() {
  const [log, setLog] = useState("");
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Section title="settled turn (folded behind “Worked for …”)">
        <div className="h-[1000px] flex flex-col"><MessageList messages={settled} busy={false} onFork={() => {}} /></div>
      </Section>
      <Section title="live turn (running / failed / interrupted)">
        <div className="h-[520px] flex flex-col"><MessageList messages={live} busy /></div>
      </Section>
      <Section title="notes: compaction, system, aborted, error">
        <div className="h-[460px] flex flex-col"><MessageList messages={notes} busy={false} /></div>
      </Section>
      <Section title="composer (idle / busy)">
        <Composer busy={false} model="tokenrouter/glm-5.3-flash" onSend={(t) => setLog(t)} onAbort={() => {}} />
        <Composer busy queued={2} model="tokenrouter/glm-5.3-flash" onSend={(t) => setLog(t)} onAbort={() => {}} />
        <p className="px-4 pb-2 font-mono text-xs text-zinc-600">last: {log}</p>
      </Section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
