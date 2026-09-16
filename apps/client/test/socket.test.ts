import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../src/net/emitter";
import { StreamSocket } from "../src/net/socket";

/** A hand-rolled WebSocket stand-in; the tests drive its callbacks directly. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;

  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closedWith = { code, reason };
  }

  // --- test helpers ---
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  serverClose(code = 1006, reason = "gone"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function latest(): FakeWebSocket {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (ws === undefined) throw new Error("no socket was created");
  return ws;
}

describe("Emitter", () => {
  it("delivers to every listener and honours unsubscribe", () => {
    const em = new Emitter<{ tick: number }>();
    const seen: number[] = [];
    const off = em.on("tick", (n) => seen.push(n));
    em.on("tick", (n) => seen.push(n * 10));

    em.emit("tick", 1);
    off();
    em.emit("tick", 2);
    expect(seen).toEqual([1, 10, 20]);
  });

  it("supports once", () => {
    const em = new Emitter<{ tick: number }>();
    const seen: number[] = [];
    em.once("tick", (n) => seen.push(n));
    em.emit("tick", 1);
    em.emit("tick", 2);
    expect(seen).toEqual([1]);
  });

  it("tolerates a listener unsubscribing during dispatch", () => {
    const em = new Emitter<{ tick: number }>();
    const seen: number[] = [];
    const off = em.on("tick", (n) => {
      seen.push(n);
      off();
    });
    em.on("tick", (n) => seen.push(n + 100));
    em.emit("tick", 1);
    em.emit("tick", 2);
    expect(seen).toEqual([1, 101, 102]);
  });

  it("clears listeners", () => {
    const em = new Emitter<{ a: number; b: number }>();
    let hits = 0;
    em.on("a", () => hits++);
    em.on("b", () => hits++);
    em.off("a");
    em.emit("a", 1);
    em.emit("b", 1);
    expect(hits).toBe(1);

    em.off();
    em.emit("b", 1);
    expect(hits).toBe(1);
  });
});

describe("StreamSocket", () => {
  it("emits text and binary frames separately", () => {
    const sock = new StreamSocket("ws://x/stream");
    const text: string[] = [];
    const bin: ArrayBuffer[] = [];
    sock.on("text", (t) => text.push(t));
    sock.on("binary", (b) => bin.push(b));
    sock.connect();

    const ws = latest();
    expect(ws.binaryType).toBe("arraybuffer");
    ws.open();
    expect(sock.state).toBe("open");

    ws.message("hello");
    ws.message(new ArrayBuffer(8));
    ws.message(42); // neither; ignored
    expect(text).toEqual(["hello"]);
    expect(bin).toHaveLength(1);
  });

  it("sends JSON only while open", () => {
    const sock = new StreamSocket("ws://x/stream");
    sock.connect();
    const ws = latest();

    expect(sock.send({ type: "ping", id: 1 })).toBe(false);
    ws.open();
    expect(sock.send({ type: "ping", id: 1 })).toBe(true);
    expect(ws.sent).toEqual([`{"type":"ping","id":1}`]);
  });

  it("reconnects with growing backoff after an unexpected close", () => {
    const sock = new StreamSocket("ws://x/stream", { baseDelayMs: 100, jitter: 0 });
    const delays: number[] = [];
    sock.on("reconnecting", ({ delayMs }) => delays.push(delayMs));
    sock.connect();

    latest().open();
    latest().serverClose();
    expect(sock.state).toBe("reconnecting");
    expect(delays).toEqual([100]);

    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // A second failure without ever opening doubles the delay.
    latest().serverClose();
    vi.advanceTimersByTime(200);
    expect(delays).toEqual([100, 200]);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // A successful open resets the backoff.
    latest().open();
    latest().serverClose();
    expect(delays).toEqual([100, 200, 100]);
  });

  it("caps the backoff delay", () => {
    const sock = new StreamSocket("ws://x/stream", {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: 0,
    });
    expect(sock.backoffDelay(1)).toBe(100);
    expect(sock.backoffDelay(4)).toBe(800);
    expect(sock.backoffDelay(5)).toBe(1000);
    expect(sock.backoffDelay(50)).toBe(1000);
  });

  it("gives up after maxAttempts", () => {
    const sock = new StreamSocket("ws://x/stream", {
      baseDelayMs: 10,
      jitter: 0,
      maxAttempts: 2,
    });
    const closes: boolean[] = [];
    sock.on("close", ({ final }) => closes.push(final));
    sock.connect();

    latest().serverClose();
    vi.advanceTimersByTime(10);
    latest().serverClose();
    vi.advanceTimersByTime(20);
    latest().serverClose();

    expect(closes).toEqual([false, false, true]);
    expect(sock.state).toBe("closed");
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("does not reconnect after an explicit close", () => {
    const sock = new StreamSocket("ws://x/stream", { baseDelayMs: 10, jitter: 0 });
    sock.connect();
    latest().open();
    sock.close();

    expect(latest().closedWith).toEqual({ code: 1000, reason: "" });
    expect(sock.state).toBe("closed");
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // connect() after close() stays a no-op.
    sock.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("ignores a second connect while one is in flight", () => {
    const sock = new StreamSocket("ws://x/stream");
    sock.connect();
    sock.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
