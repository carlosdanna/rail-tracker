/**
 * Station inference.
 *
 * A station is where trains stop. With state visible that is simply
 * `state === "at_station"`; in hide-state mode the client has to notice that a
 * train's speed sat at ~0 across several consecutive updates instead.
 *
 * The distinction that matters is the one spec §4 calls out: waypoints change a
 * train's heading without stopping it, so they must never turn into stations.
 * Nothing here looks at heading at all, which is what keeps that true.
 */
import { dist } from "./geometry";
import type { Point } from "./geometry";
import type { TrainState } from "../protocol";

/** A cluster of stop points, i.e. one inferred station. */
export interface InferredStation {
  id: string;
  x: number;
  y: number;
  /** How many separate stop events landed in this cluster. */
  stops: number;
  /** Distinct trains that have stopped here. */
  trains: number;
}

export interface StationInferenceOptions {
  /** Cluster radius in world units. */
  radius?: number;
  /** Speed at or below which a train counts as stopped. */
  speedEpsilon?: number;
  /**
   * How many consecutive slow updates make a stop in hide-state mode. One
   * update is not enough: a train can be momentarily slow through a tight
   * waypoint when acceleration is enabled.
   */
  minConsecutive?: number;
  /** Stop events needed before a cluster is reported as a station. */
  minStops?: number;
}

const DEFAULTS = {
  radius: 20,
  speedEpsilon: 0.5,
  minConsecutive: 3,
  minStops: 1,
} satisfies Required<StationInferenceOptions>;

/** Per-train state while watching for a stop. */
interface Watch {
  /** Consecutive updates seen at ~0 speed. */
  slow: number;
  /** Whether the current stop has already been recorded. */
  recorded: boolean;
  /** Running mean of the position during the current stop. */
  sumX: number;
  sumY: number;
  n: number;
}

interface Cluster {
  x: number;
  y: number;
  stops: number;
  trains: Set<string>;
}

export class StationInference {
  readonly #opts: Required<StationInferenceOptions>;
  readonly #watch = new Map<string, Watch>();
  readonly #clusters: Cluster[] = [];

  constructor(options: StationInferenceOptions = {}) {
    this.#opts = { ...DEFAULTS, ...options };
  }

  get options(): Required<StationInferenceOptions> {
    return this.#opts;
  }

  /** The stations inferred so far, most-visited first. */
  stations(): InferredStation[] {
    return this.#clusters
      .filter((c) => c.stops >= this.#opts.minStops)
      .map((c, i) => ({
        id: `station-${i}`,
        x: c.x,
        y: c.y,
        stops: c.stops,
        trains: c.trains.size,
      }))
      .sort((a, b) => b.stops - a.stops);
  }

  /** Raw cluster count, including ones below the reporting threshold. */
  get clusterCount(): number {
    return this.#clusters.length;
  }

  /**
   * Feeds one update. Returns true when this update completed a stop and fed a
   * point into the clusters.
   */
  observe(trainId: string, x: number, y: number, speed: number, state: TrainState): boolean {
    let w = this.#watch.get(trainId);
    if (w === undefined) {
      w = { slow: 0, recorded: false, sumX: 0, sumY: 0, n: 0 };
      this.#watch.set(trainId, w);
    }

    const stopped =
      state === "at_station" || (state === "unknown" && speed <= this.#opts.speedEpsilon);

    if (!stopped) {
      // Leaving a station ends the stop and arms the next one.
      w.slow = 0;
      w.recorded = false;
      w.sumX = 0;
      w.sumY = 0;
      w.n = 0;
      return false;
    }

    w.slow += 1;
    w.sumX += x;
    w.sumY += y;
    w.n += 1;

    // With the state visible one update is proof enough; inferring from speed
    // needs a run of them so a slow corner is not mistaken for a stop.
    const needed = state === "at_station" ? 1 : this.#opts.minConsecutive;
    if (w.recorded || w.slow < needed) return false;

    w.recorded = true;
    this.#addStop(trainId, { x: w.sumX / w.n, y: w.sumY / w.n });
    return true;
  }

  /** Adds a stop point to the nearest cluster within the radius, or a new one. */
  #addStop(trainId: string, p: Point): void {
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (const c of this.#clusters) {
      const d = dist(p, c);
      if (d <= this.#opts.radius && d < bestD) {
        best = c;
        bestD = d;
      }
    }

    if (best === null) {
      this.#clusters.push({ x: p.x, y: p.y, stops: 1, trains: new Set([trainId]) });
      return;
    }

    // Incremental mean, so a cluster converges on the platform the trains
    // actually stop at rather than on wherever the first one happened to halt.
    best.stops += 1;
    best.x += (p.x - best.x) / best.stops;
    best.y += (p.y - best.y) / best.stops;
    best.trains.add(trainId);
  }

  reset(): void {
    this.#watch.clear();
    this.#clusters.length = 0;
  }
}
