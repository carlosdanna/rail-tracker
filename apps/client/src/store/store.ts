/**
 * The client's view of the world: the latest state per train, the trail behind
 * each one, and the counters the HUD reads.
 */
import { trainId } from "../protocol";
import type { TrainState } from "../protocol";
import { stateFromCode } from "../worker/ingest";
import type { UpdateArrays } from "../worker/arrays";
import { TrailStore } from "./trails";
import type { Point, TrailOptions } from "./trails";
import { Stats } from "./stats";

/** The latest known state of one train. */
export interface Train {
  id: string;
  index: number;
  x: number;
  y: number;
  /** Degrees, 0 = north, clockwise. */
  heading: number;
  speed: number;
  state: TrainState;
  seq: number;
  /** Client clock (ms) when this update was applied, for dead reckoning. */
  updatedAt: number;
  /** The inferred line this train belongs to, once one is known. */
  lineId: string | null;
}

export interface StoreOptions {
  trail?: TrailOptions;
}

export class Store {
  readonly #trains = new Map<string, Train>();
  readonly trails: TrailStore;
  readonly stats = new Stats();

  /** World bounds from the hello frame; used by the renderer. */
  bounds = { w: 1000, h: 1000 };
  /** Whether the server is hiding train state. */
  hideState = false;

  constructor(options: StoreOptions = {}) {
    this.trails = new TrailStore(options.trail);
  }

  get size(): number {
    return this.#trains.size;
  }

  get(id: string): Train | undefined {
    return this.#trains.get(id);
  }

  trains(): IterableIterator<Train> {
    return this.#trains.values();
  }

  /** The trail recorded for a train. */
  trail(id: string): readonly Point[] {
    return this.trails.points(id);
  }

  /**
   * Applies a coalesced flush from the worker. `now` is the client clock, kept
   * as a parameter so tests can drive it.
   */
  applyArrays(arrays: UpdateArrays, count: number, now: number = performance.now()): void {
    for (let i = 0; i < count; i++) {
      const index = arrays.index[i] ?? 0;
      const id = trainId(index);
      const x = arrays.x[i] ?? 0;
      const y = arrays.y[i] ?? 0;
      const heading = arrays.heading[i] ?? 0;

      let train = this.#trains.get(id);
      if (train === undefined) {
        train = {
          id,
          index,
          x,
          y,
          heading,
          speed: 0,
          state: "unknown",
          seq: 0,
          updatedAt: now,
          lineId: null,
        };
        this.#trains.set(id, train);
      }
      train.x = x;
      train.y = y;
      train.heading = heading;
      train.speed = arrays.speed[i] ?? 0;
      train.state = stateFromCode(arrays.state[i] ?? 255);
      train.seq = arrays.seq[i] ?? 0;
      train.updatedAt = now;

      this.trails.append(id, x, y, heading);
    }
    this.stats.setTrains(this.#trains.size);
  }

  /**
   * Records that a train's line has been reconstructed. The trail stops growing
   * from here on, as required by spec §4.
   */
  assignLine(id: string, lineId: string): void {
    const train = this.#trains.get(id);
    if (train !== undefined) train.lineId = lineId;
    this.trails.freeze(id);
  }

  /** Forgets everything, e.g. when the format toggle forces a reconnect. */
  reset(): void {
    this.#trains.clear();
    this.trails.clearAll();
  }
}
