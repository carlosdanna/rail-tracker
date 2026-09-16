/**
 * The parser worker owns the WebSocket. Frames are decoded here, coalesced to
 * the latest update per train, and posted to the main thread at most once per
 * animation frame — the main thread asks for a flush from inside its rAF
 * callback, which is the closest a worker can get to frame pacing.
 */
/// <reference lib="webworker" />
import { parseBinaryBatch, parseBatchValue, parseHello, ProtocolError } from "../protocol";
import { StreamSocket } from "../net/socket";
import { transferables } from "./arrays";
import { Ingest } from "./ingest";
import type { FromWorker, ToWorker } from "./messages";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const ingest = new Ingest();
let socket: StreamSocket | null = null;

function post(msg: FromWorker, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

function fail(err: unknown): void {
  post({ type: "error", message: err instanceof Error ? err.message : String(err) });
}

/**
 * Routes a text frame. Only `batch` carries updates; `hello` and `pong` are
 * forwarded as-is.
 */
function onText(text: string): void {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    fail(err);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const type = (value as { type?: unknown }).type;
  try {
    if (type === "batch") {
      // The byte count is approximate for text frames, but close enough for a
      // throughput readout.
      ingest.add(parseBatchValue(value), text.length);
    } else if (type === "hello") {
      post({ type: "hello", hello: parseHello(value) });
    } else if (type === "pong") {
      const pong = value as { id?: unknown; t?: unknown };
      post({
        type: "pong",
        id: typeof pong.id === "number" ? pong.id : 0,
        t: typeof pong.t === "number" ? pong.t : 0,
      });
    }
  } catch (err) {
    if (err instanceof ProtocolError) fail(err);
    else throw err;
  }
}

function onBinary(buffer: ArrayBuffer): void {
  try {
    ingest.add(parseBinaryBatch(buffer), buffer.byteLength);
  } catch (err) {
    fail(err);
  }
}

function connect(url: string): void {
  disconnect();
  ingest.resetSequence();

  const s = new StreamSocket(url);
  socket = s;

  s.on("open", ({ attempt }) => {
    ingest.resetSequence();
    post({ type: "status", state: "open", attempt });
  });
  s.on("text", onText);
  s.on("binary", onBinary);
  s.on("close", ({ code, reason, final }) => {
    post({ type: "status", state: final ? "closed" : "closing", attempt: code });
    if (reason) post({ type: "error", message: reason });
  });
  s.on("reconnecting", ({ attempt, delayMs }) => {
    post({ type: "status", state: "reconnecting", attempt, delayMs });
  });
  s.on("error", ({ message }) => {
    post({ type: "error", message });
  });

  s.connect();
}

function disconnect(): void {
  socket?.close();
  socket = null;
}

/** Posts the coalesced batch, handing ownership of the arrays to the caller. */
function flush(): void {
  const drained = ingest.drain();
  if (drained === null) return;
  post(
    {
      type: "batch",
      count: drained.count,
      t: drained.t,
      arrays: drained.arrays,
      stats: drained.stats,
      flushedAt: Date.now(),
    },
    transferables(drained.arrays),
  );
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "connect":
      connect(msg.url);
      break;
    case "disconnect":
      disconnect();
      break;
    case "flush":
      flush();
      break;
    case "recycle":
      ingest.recycle(msg.arrays);
      break;
    case "send":
      socket?.send(msg.message);
      break;
  }
};
