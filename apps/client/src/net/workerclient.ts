/**
 * Main-thread side of the parser worker.
 *
 * It asks for a flush once per animation frame, hands the arrays to a callback,
 * and posts them straight back so the worker can reuse them. Latency is
 * measured by pinging through the worker on a timer.
 */
import { Emitter } from "./emitter";
import type { Hello } from "../protocol";
import type { UpdateArrays } from "../worker/arrays";
import type { FromWorker, ToWorker } from "../worker/messages";
import type { IngestStats } from "../worker/ingest";

export interface WorkerClientEvents extends Record<string, unknown> {
  hello: Hello;
  batch: { arrays: UpdateArrays; count: number; t: number; stats: IngestStats };
  status: { state: string };
  latency: { ms: number };
  error: { message: string };
}

export class WorkerClient extends Emitter<WorkerClientEvents> {
  readonly #worker: Worker;
  /** Ping id to the client clock when it was sent. */
  readonly #pings = new Map<number, number>();
  #nextPing = 1;
  #pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(worker: Worker) {
    super();
    this.#worker = worker;
    this.#worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      this.#onMessage(ev.data);
    };
  }

  /** Opens a connection; replaces any existing one. */
  connect(url: string): void {
    this.#post({ type: "connect", url });
  }

  disconnect(): void {
    this.#post({ type: "disconnect" });
  }

  /** Asks the worker for the coalesced batch. Call once per frame. */
  flush(): void {
    this.#post({ type: "flush" });
  }

  /** Returns the arrays so the worker's pool can reuse them. */
  recycle(arrays: UpdateArrays): void {
    this.#worker.postMessage({ type: "recycle", arrays } satisfies ToWorker, [
      arrays.index.buffer as ArrayBuffer,
      arrays.x.buffer as ArrayBuffer,
      arrays.y.buffer as ArrayBuffer,
      arrays.heading.buffer as ArrayBuffer,
      arrays.speed.buffer as ArrayBuffer,
      arrays.state.buffer as ArrayBuffer,
      arrays.seq.buffer as ArrayBuffer,
    ]);
  }

  /** Changes this connection's rate without reconnecting. */
  setRate(rate: number): void {
    this.#post({ type: "send", message: { type: "setRate", rate } });
  }

  /** Starts measuring round-trip latency every `intervalMs`. */
  startPings(intervalMs = 2000): void {
    this.stopPings();
    this.#pingTimer = setInterval(() => this.ping(), intervalMs);
    this.ping();
  }

  stopPings(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  ping(): void {
    const id = this.#nextPing++;
    this.#pings.set(id, performance.now());
    // Keep the map from growing if answers stop coming back.
    if (this.#pings.size > 64) {
      const oldest = this.#pings.keys().next();
      if (!oldest.done) this.#pings.delete(oldest.value);
    }
    this.#post({ type: "send", message: { type: "ping", id } });
  }

  /** Shuts the worker down. */
  terminate(): void {
    this.stopPings();
    this.#worker.terminate();
  }

  #post(msg: ToWorker): void {
    this.#worker.postMessage(msg);
  }

  #onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case "hello":
        this.emit("hello", msg.hello);
        break;
      case "batch":
        this.emit("batch", {
          arrays: msg.arrays,
          count: msg.count,
          t: msg.t,
          stats: msg.stats,
        });
        break;
      case "pong": {
        const sentAt = this.#pings.get(msg.id);
        if (sentAt !== undefined) {
          this.#pings.delete(msg.id);
          this.emit("latency", { ms: performance.now() - sentAt });
        }
        break;
      }
      case "status":
        this.emit("status", { state: msg.state });
        break;
      case "error":
        this.emit("error", { message: msg.message });
        break;
    }
  }
}
