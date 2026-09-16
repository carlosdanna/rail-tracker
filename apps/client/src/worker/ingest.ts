/**
 * Ingest sits between the socket and the main thread. It keeps only the latest
 * update per train, so a flush costs one entry per train no matter how many
 * updates arrived, and it counts sequence gaps as the server's drops.
 */
import { STATE_AT_STATION, STATE_HIDDEN, STATE_RUNNING } from "../protocol";
import type { Batch, TrainState, TrainUpdate } from "../protocol";
import { ArrayPool, capacityOf } from "./arrays";
import type { UpdateArrays } from "./arrays";

/** Cumulative counters since the connection opened. */
export interface IngestStats {
  /** Batch frames received. */
  frames: number;
  /** Updates received. */
  updates: number;
  /** Number of discontinuities in `seq`. */
  gaps: number;
  /** Updates the server dropped, summed across gaps. */
  dropped: number;
  /** Bytes received, where the transport reported a size. */
  bytes: number;
  /** Updates skipped because their train id was not `T-<n>`. */
  malformed: number;
}

/** A flush: the coalesced updates plus the counters at that moment. */
export interface Flush {
  /** How many entries of each array are valid. */
  count: number;
  /** Server wall-clock ms of the most recent frame in this flush. */
  t: number;
  arrays: UpdateArrays;
  stats: IngestStats;
}

/** Maps the normalised state back to its binary code. */
export function stateCode(state: TrainState): number {
  switch (state) {
    case "running":
      return STATE_RUNNING;
    case "at_station":
      return STATE_AT_STATION;
    default:
      return STATE_HIDDEN;
  }
}

/** Maps a binary state code back to the normalised state. */
export function stateFromCode(code: number): TrainState {
  switch (code) {
    case STATE_RUNNING:
      return "running";
    case STATE_AT_STATION:
      return "at_station";
    default:
      return "unknown";
  }
}

export class Ingest {
  /** Latest update per train index. Insertion order is stable across flushes. */
  readonly #latest = new Map<number, TrainUpdate>();
  readonly #pool: ArrayPool;

  #lastSeq = -1;
  #latestT = 0;
  #stats: IngestStats = {
    frames: 0,
    updates: 0,
    gaps: 0,
    dropped: 0,
    bytes: 0,
    malformed: 0,
  };

  constructor(pool = new ArrayPool()) {
    this.#pool = pool;
  }

  /** Cumulative counters. */
  get stats(): IngestStats {
    return { ...this.#stats };
  }

  /** How many distinct trains are waiting to be flushed. */
  get pending(): number {
    return this.#latest.size;
  }

  /** Forgets the sequence cursor, e.g. after a reconnect. */
  resetSequence(): void {
    this.#lastSeq = -1;
  }

  /** Takes one decoded batch. `byteLength` is counted when known. */
  add(batch: Batch, byteLength = 0): void {
    this.#stats.frames += 1;
    this.#stats.bytes += byteLength;
    this.#latestT = batch.t;

    for (const u of batch.updates) {
      this.#stats.updates += 1;

      // A gap in seq is the server telling us it dropped a frame for us.
      if (this.#lastSeq >= 0 && u.seq !== this.#lastSeq + 1) {
        this.#stats.gaps += 1;
        if (u.seq > this.#lastSeq) {
          this.#stats.dropped += u.seq - this.#lastSeq - 1;
        }
      }
      this.#lastSeq = u.seq;

      if (u.index < 0) {
        this.#stats.malformed += 1;
        continue;
      }
      // Later updates for the same train simply replace earlier ones.
      this.#latest.set(u.index, u);
    }
  }

  /**
   * Produces the coalesced batch and clears the pending set. Returns null when
   * nothing has arrived since the last flush.
   */
  drain(): Flush | null {
    const count = this.#latest.size;
    if (count === 0) return null;

    const arrays = this.#pool.acquire(count);
    let i = 0;
    for (const u of this.#latest.values()) {
      arrays.index[i] = u.index;
      arrays.x[i] = u.x;
      arrays.y[i] = u.y;
      arrays.heading[i] = u.heading;
      arrays.speed[i] = u.speed;
      arrays.state[i] = stateCode(u.state);
      arrays.seq[i] = u.seq;
      i++;
    }
    this.#latest.clear();

    return { count, t: this.#latestT, arrays, stats: this.stats };
  }

  /** Hands a set of arrays back to the pool once the main thread is done. */
  recycle(arrays: UpdateArrays): void {
    if (capacityOf(arrays) > 0) this.#pool.release(arrays);
  }
}
