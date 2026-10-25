// WebSocket client for WS /api/asks/stream (ask_user questions), mirroring lib/approvals.ts: full-replacement
// frames, same reconnect backoff.
import type { AskItem } from "../types";
import { nextBackoff } from "./stream";

export function asksUrl(): string {
  const { protocol, host } = globalThis.location ?? { protocol: "http:", host: "127.0.0.1:8090" };
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/asks/stream`;
}

function normalize(raw: unknown): AskItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.id === undefined || r.id === null) return undefined;
  return {
    id: String(r.id),
    ...(r.conversationId !== undefined && r.conversationId !== null ? { conversationId: String(r.conversationId) } : {}),
    question: typeof r.question === "string" ? r.question : "",
    options: Array.isArray(r.options) ? r.options.map((o) => String(o)) : [],
    ...(typeof r.askedAt === "string" ? { askedAt: r.askedAt } : {}),
  };
}

/** Parse one wire frame; undefined for anything that is not an asks frame. */
export function parseAsksFrame(data: unknown): AskItem[] | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(String(data));
  } catch {
    return undefined;
  }
  const f = frame as { type?: unknown; items?: unknown } | null;
  if (!f || f.type !== "asks" || !Array.isArray(f.items)) return undefined;
  return f.items.map(normalize).filter((i): i is AskItem => i !== undefined);
}

export class AsksStream {
  private ws?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private delay = 0;
  private stopped = false;

  constructor(private readonly onItems: (items: AskItem[]) => void) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(asksUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 0;
    };
    ws.onmessage = (ev: MessageEvent) => {
      const items = parseAsksFrame(ev.data);
      if (items) this.onItems(items);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.stopped) return;
      this.delay = nextBackoff(this.delay);
      this.timer = setTimeout(() => this.connect(), this.delay);
    };
  }
}
