/**
 * Bounded per-train trails.
 *
 * A trail is the client's raw evidence for reconstructing a line, so it keeps
 * only points that carry information: a point is appended when the train has
 * moved more than `epsilon` or turned more than `delta`. Every trail has a hard
 * cap, and appending stops entirely once the train's line has been
 * reconstructed — at that point the trail has served its purpose and would
 * otherwise grow without bound.
 */

export interface Point {
  x: number;
  y: number;
}

export interface TrailOptions {
  /** Minimum movement in world units before a point is appended. */
  epsilon?: number;
  /** Minimum heading change in degrees before a point is appended. */
  delta?: number;
  /** Hard cap on points per trail; the oldest are dropped first. */
  cap?: number;
}

const DEFAULTS = {
  epsilon: 4,
  delta: 8,
  // Per train. A trail stops growing once its line is reconstructed, so this
  // only bounds the trains still being worked out, but at 500 trains the cap is
  // what keeps the total bounded rather than merely finite.
  cap: 512,
} satisfies Required<TrailOptions>;

/** Smallest signed difference between two headings, in degrees. */
export function headingDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

interface Trail {
  points: Point[];
  lastHeading: number;
  /** Set once the line is reconstructed; no more points are appended. */
  frozen: boolean;
  /** Points dropped by the cap, so callers can tell a trail is truncated. */
  evicted: number;
}

export class TrailStore {
  readonly #trails = new Map<string, Trail>();
  readonly #opts: Required<TrailOptions>;

  constructor(options: TrailOptions = {}) {
    this.#opts = { ...DEFAULTS, ...options };
  }

  get options(): Required<TrailOptions> {
    return this.#opts;
  }

  /** Number of trains with a trail. */
  get size(): number {
    return this.#trails.size;
  }

  /**
   * Offers a position to a train's trail. Returns true if it was appended.
   */
  append(id: string, x: number, y: number, heading: number): boolean {
    let trail = this.#trails.get(id);
    if (trail === undefined) {
      trail = { points: [{ x, y }], lastHeading: heading, frozen: false, evicted: 0 };
      this.#trails.set(id, trail);
      return true;
    }
    if (trail.frozen) return false;

    const last = trail.points[trail.points.length - 1];
    if (last !== undefined) {
      const moved = Math.hypot(x - last.x, y - last.y);
      const turned = Math.abs(headingDelta(trail.lastHeading, heading));
      if (moved < this.#opts.epsilon && turned < this.#opts.delta) return false;
    }

    trail.points.push({ x, y });
    trail.lastHeading = heading;
    if (trail.points.length > this.#opts.cap) {
      // Drop from the front in one splice rather than shift-per-point.
      const excess = trail.points.length - this.#opts.cap;
      trail.points.splice(0, excess);
      trail.evicted += excess;
    }
    return true;
  }

  /** The points recorded for a train, oldest first. */
  points(id: string): readonly Point[] {
    return this.#trails.get(id)?.points ?? [];
  }

  /** How many points have been dropped by the cap for a train. */
  evicted(id: string): number {
    return this.#trails.get(id)?.evicted ?? 0;
  }

  /** Whether a train's trail is frozen. */
  isFrozen(id: string): boolean {
    return this.#trails.get(id)?.frozen ?? false;
  }

  /**
   * Stops recording for a train, called once its line is reconstructed. The
   * points already collected stay available for drawing.
   */
  freeze(id: string): void {
    const trail = this.#trails.get(id);
    if (trail !== undefined) trail.frozen = true;
  }

  /** Resumes recording, e.g. if the reconstruction was thrown away. */
  unfreeze(id: string): void {
    const trail = this.#trails.get(id);
    if (trail !== undefined) trail.frozen = false;
  }

  /** Drops a train's trail entirely. */
  clear(id: string): void {
    this.#trails.delete(id);
  }

  /** Drops every trail. */
  clearAll(): void {
    this.#trails.clear();
  }

  /** Total points held across all trails, for the HUD's memory readout. */
  totalPoints(): number {
    let n = 0;
    for (const trail of this.#trails.values()) n += trail.points.length;
    return n;
  }

  /** Train ids that have a trail. */
  ids(): IterableIterator<string> {
    return this.#trails.keys();
  }
}
