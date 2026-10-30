// WebSocket client for WS /api/approvals/stream. The server pushes {type:"approvals", items} on connect and after
// every change, so each frame is a full replacement. Reconnects with the same backoff as the Bot stream.
import type { ApprovalItem } from "../types";
import { nextBackoff } from "./stream";

export type ApprovalsStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ApprovalsStreamOptions {
  onItems: (items: ApprovalItem[]) => void;
  onStatus?: (status: ApprovalsStatus) => void;
  /** Overrides for tests. */
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}

export function approvalsUrl(): string {
  const { protocol, host } = globalThis.location ?? { protocol: "http:", host: "127.0.0.1:8090" };
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/approvals/stream`;
}

function normalize(raw: unknown): ApprovalItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.taskId === undefined || r.taskId === null) return undefined;
  return {
    taskId: String(r.taskId),
    ...(r.conversationId !== undefined && r.conversationId !== null ? { conversationId: String(r.conversationId) } : {}),
    toolName: typeof r.toolName === "string" ? r.toolName : "tool",
    args: r.args,
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    ...(typeof r.requestedAt === "string" ? { requestedAt: r.requestedAt } : {}),
    ...(r.parent && typeof r.parent === "object"
      ? { parent: { callId: String((r.parent as Record<string, unknown>).callId ?? ""), taskId: String((r.parent as Record<string, unknown>).taskId ?? "") } }
      : {}),
  };
}

/** Parse one wire frame. Returns undefined for anything that is not an approvals frame. */
export function parseApprovalsFrame(data: unknown): ApprovalItem[] | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(String(data));
  } catch {
    return undefined;
  }
  const f = frame as { type?: unknown; items?: unknown } | null;
  if (!f || f.type !== "approvals" || !Array.isArray(f.items)) return undefined;
  return f.items.map(normalize).filter((i): i is ApprovalItem => i !== undefined);
}

export class ApprovalsStream {
  private ws?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private delay = 0;
  private stopped = false;
  private readonly opts: ApprovalsStreamOptions;

  constructor(opts: ApprovalsStreamOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.connect(false);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
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
    this.opts.onStatus?.("closed");
  }

  private connect(isRetry: boolean): void {
    if (this.stopped) return;
    this.opts.onStatus?.(isRetry ? "reconnecting" : "connecting");
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.opts.url ?? approvalsUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 0;
      this.opts.onStatus?.("open");
    };
    ws.onmessage = (ev: MessageEvent) => {
      const items = parseApprovalsFrame(ev.data);
      if (items) this.opts.onItems(items);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.stopped) return;
      this.delay = nextBackoff(this.delay);
      this.opts.onStatus?.("reconnecting");
      this.timer = setTimeout(() => this.connect(true), this.delay);
    };
  }
}
