import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotStream, nextBackoff } from "../src/lib/stream";
import type { Frame } from "../src/lib/reducer";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}
const Impl = FakeSocket as unknown as typeof WebSocket;

describe("stream backoff", () => {
  it("doubles from 0.5s up to 8s", () => {
    const seq: number[] = [];
    let d = 0;
    for (let i = 0; i < 8; i++) seq.push((d = nextBackoff(d)));
    expect(seq).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  });
});

describe("BotStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("reconnects with exponential backoff, resets the delay after a successful open, and forwards frames", () => {
    const frames: Frame[] = [];
    const statuses: string[] = [];
    const s = new BotStream({ botId: "b1", url: "ws://x/stream", WebSocketImpl: Impl, onFrame: (f) => frames.push(f), onStatus: (st) => statuses.push(st) });
    s.start();
    const sock = () => FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(FakeSocket.instances).toHaveLength(1);

    sock().onopen?.();
    sock().onmessage?.({ data: JSON.stringify({ type: "snapshot", entries: [] }) });
    expect(frames).toEqual([{ type: "snapshot", entries: [] }]);

    sock().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    sock().onclose?.({ code: 1006 }); // never opened: delay doubles
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    sock().onopen?.(); // success resets
    sock().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(4);
    expect(statuses).toContain("reconnecting");
    expect(statuses).toContain("open");

    s.stop();
    sock().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("gives up when the bot does not exist (close code 4404)", () => {
    const s = new BotStream({ botId: "nope", url: "ws://x", WebSocketImpl: Impl, onFrame: () => {} });
    s.start();
    FakeSocket.instances[0].onclose?.({ code: 4404 });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
