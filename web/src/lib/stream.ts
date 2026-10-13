// WebSocket client with exponential-backoff reconnect (0.5s -> 8s).
// After every (re)connect the server sends a fresh `snapshot` first; the reducer resets from it.
import type { StreamStatus } from "../types";
import type { Frame } from "./reducer";

export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 8000;

export function nextBackoff(previous: number): number {
  return Math.min(BACKOFF_MAX_MS, previous <= 0 ? BACKOFF_MIN_MS : previous * 2);
}

export interface BotStreamOptions {
  botId: string;
  onFrame: (frame: Frame) => void;
  onStatus?: (status: StreamStatus) => void;
  /** Override for tests. */
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}

export function streamUrl(botId: string): string {
  const { protocol, host } = globalThis.location ?? { protocol: "http:", host: "127.0.0.1:8090" };
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/bots/${encodeURIComponent(botId)}/stream`;
}

export class BotStream {
  private ws?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private delay = 0;
  private stopped = false;
  private readonly opts: BotStreamOptions;

  constructor(opts: BotStreamOptions) {
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
    const ws = new Impl(this.opts.url ?? streamUrl(this.opts.botId));
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 0;
      this.opts.onStatus?.("open");
    };
    ws.onmessage = (ev: MessageEvent) => {
      try {
        this.opts.onFrame(JSON.parse(String(ev.data)) as Frame);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.stopped) return;
      if (ev.code === 4404) {
        // Bot does not exist: retrying cannot help.
        this.stopped = true;
        this.opts.onStatus?.("closed");
        return;
      }
      this.delay = nextBackoff(this.delay);
      this.opts.onStatus?.("reconnecting");
      this.timer = setTimeout(() => this.connect(true), this.delay);
    };
  }
}
