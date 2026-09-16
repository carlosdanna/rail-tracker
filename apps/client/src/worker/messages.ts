/** The message contract between the main thread and the parser worker. */
import type { Hello } from "../protocol";
import type { UpdateArrays } from "./arrays";
import type { IngestStats } from "./ingest";

/** Main thread → worker. */
export type ToWorker =
  | { type: "connect"; url: string }
  | { type: "disconnect" }
  /** Ask for the coalesced batch; sent once per animation frame. */
  | { type: "flush" }
  /** Give the arrays back so the worker can reuse them. */
  | { type: "recycle"; arrays: UpdateArrays }
  /** Forward a control message (setRate, ping) to the server. */
  | { type: "send"; message: unknown };

/** Worker → main thread. */
export type FromWorker =
  | { type: "hello"; hello: Hello }
  | { type: "pong"; id: number; t: number }
  | {
      type: "batch";
      count: number;
      /** Server wall-clock ms of the newest frame in this flush. */
      t: number;
      arrays: UpdateArrays;
      stats: IngestStats;
      /** Client clock in ms when the worker flushed, for latency accounting. */
      flushedAt: number;
    }
  | { type: "status"; state: string; attempt?: number; delayMs?: number }
  | { type: "error"; message: string };
