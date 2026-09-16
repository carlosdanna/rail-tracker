/**
 * A WebSocket wrapper with exponential-backoff reconnect and a typed event
 * stream. It deliberately knows nothing about the protocol: frames come out as
 * strings or ArrayBuffers and are parsed downstream, which keeps this usable
 * from inside the worker.
 */
import { Emitter } from "./emitter";

/** Events a StreamSocket emits. */
export interface StreamSocketEvents extends Record<string, unknown> {
  /** The socket is open; `attempt` is 0 on the first connect. */
  open: { attempt: number };
  /** A text frame arrived. */
  text: string;
  /** A binary frame arrived. */
  binary: ArrayBuffer;
  /** The socket closed; a reconnect is scheduled unless `final` is true. */
  close: { code: number; reason: string; final: boolean };
  /** A reconnect is pending. */
  reconnecting: { attempt: number; delayMs: number };
  /** Something went wrong; the socket may still recover. */
  error: { message: string };
}

/** Backoff and lifecycle settings. */
export interface StreamSocketOptions {
  /** Base delay for the first reconnect. */
  baseDelayMs?: number;
  /** Ceiling for the exponential backoff. */
  maxDelayMs?: number;
  /** Random fraction added to each delay, to avoid a thundering herd. */
  jitter?: number;
  /** Give up after this many consecutive failures; 0 means never. */
  maxAttempts?: number;
}

const DEFAULTS = {
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  jitter: 0.25,
  maxAttempts: 0,
} satisfies Required<StreamSocketOptions>;

/** Connection lifecycle state. */
export type SocketState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export class StreamSocket extends Emitter<StreamSocketEvents> {
  readonly #url: string;
  readonly #opts: Required<StreamSocketOptions>;

  #ws: WebSocket | null = null;
  #attempt = 0;
  #state: SocketState = "idle";
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Set by close() so a deliberate shutdown does not reconnect. */
  #stopped = false;

  constructor(url: string, options: StreamSocketOptions = {}) {
    super();
    this.#url = url;
    this.#opts = { ...DEFAULTS, ...options };
  }

  get state(): SocketState {
    return this.#state;
  }

  get url(): string {
    return this.#url;
  }

  /** Opens the connection. Calling it twice is a no-op. */
  connect(): void {
    if (this.#ws !== null || this.#stopped) return;
    this.#state = this.#attempt === 0 ? "connecting" : "reconnecting";

    const ws = new WebSocket(this.#url);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;

    ws.onopen = () => {
      this.#state = "open";
      const attempt = this.#attempt;
      this.#attempt = 0;
      this.emit("open", { attempt });
    };

    ws.onmessage = (ev: MessageEvent<unknown>) => {
      const data: unknown = ev.data;
      if (typeof data === "string") this.emit("text", data);
      else if (data instanceof ArrayBuffer) this.emit("binary", data);
    };

    ws.onerror = () => {
      // The event carries nothing useful; the close that follows has the detail.
      this.emit("error", { message: "websocket error" });
    };

    ws.onclose = (ev: CloseEvent) => {
      this.#ws = null;
      const final = this.#stopped || this.#exhausted();
      this.#state = final ? "closed" : "reconnecting";
      this.emit("close", { code: ev.code, reason: ev.reason, final });
      if (!final) this.#scheduleReconnect();
    };
  }

  /** Sends a JSON message if the socket is open; returns whether it went out. */
  send(message: unknown): boolean {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(message));
    return true;
  }

  /** Closes for good; no reconnect follows. */
  close(code = 1000, reason = ""): void {
    this.#stopped = true;
    this.#state = "closed";
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#ws?.close(code, reason);
    this.#ws = null;
  }

  #exhausted(): boolean {
    return this.#opts.maxAttempts > 0 && this.#attempt >= this.#opts.maxAttempts;
  }

  #scheduleReconnect(): void {
    this.#attempt += 1;
    const delay = this.backoffDelay(this.#attempt);
    this.emit("reconnecting", { attempt: this.#attempt, delayMs: delay });
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.connect();
    }, delay);
  }

  /**
   * Exponential backoff with jitter: base × 2^(attempt−1), capped, plus up to
   * `jitter` of that value.
   */
  backoffDelay(attempt: number): number {
    const exp = this.#opts.baseDelayMs * 2 ** Math.max(0, attempt - 1);
    const capped = Math.min(exp, this.#opts.maxDelayMs);
    return Math.round(capped * (1 + Math.random() * this.#opts.jitter));
  }
}
