/**
 * Line reconstruction.
 *
 * Nothing about the network is sent to the client, so a line has to be worked
 * out from where its trains have been. Per spec §4 a train's line is known once
 * its trail closes (a loop) or it reverses along its own path (a shuttle), and
 * trains whose reconstructed paths match within tolerance belong to the same
 * line.
 *
 * The two detectors are deliberately exclusive: a shuttle that starts mid-track
 * also passes back through its starting point, which would look like a loop, so
 * a train that has ever reversed is never reported as a loop.
 */
import { headingDelta } from "../store/trails";
import { dist, distToPath, pathLength } from "./geometry";
import type { Point } from "./geometry";

export type LineKind = "loop" | "shuttle";

/** A polyline a train has been shown to run on. */
export interface ReconstructedPath {
  kind: LineKind;
  /** For a loop the closing segment is implied, not repeated. */
  points: Point[];
}

/** A line the client has reconstructed, with the trains assigned to it. */
export interface InferredLine {
  id: string;
  kind: LineKind;
  points: Point[];
  trainIds: string[];
  /** Stable colour index, so the renderer can pick from a palette. */
  colorIndex: number;
}

export interface LineInferenceOptions {
  /** Minimum movement before a new point joins a train's path, in world units. */
  step?: number;
  /** How close two paths must be to count as the same line. */
  tolerance?: number;
  /** Heading change that makes a reversal worth checking, in degrees. */
  reversalDegrees?: number;
  /** How far the train must travel past a sharp turn before it is judged. */
  confirmDistance?: number;
  /** How closely the train must retrace itself for a turn to be a reversal. */
  retraceTolerance?: number;
  /**
   * How closely the train's heading must match its heading at the start for a
   * return to the start to count as closing a loop.
   */
  closureDegrees?: number;
  /** A loop must be at least this long, to reject a train shuffling in place. */
  minLoopLength?: number;
}

const DEFAULTS = {
  step: 3,
  tolerance: 18,
  reversalDegrees: 150,
  confirmDistance: 150,
  retraceTolerance: 5,
  closureDegrees: 45,
  minLoopLength: 120,
} satisfies Required<LineInferenceOptions>;

/**
 * Follows one train and reports the path it runs on once that path is complete.
 *
 * A sharp turn alone is not a reversal. Generated tracks tour their stations in
 * nearest-neighbour order, which routinely produces hairpins where a train
 * swings through more than 150 degrees and then carries on down fresh track. A
 * real reversal is distinguishable because the train afterwards runs back over
 * the ground it just covered, so every candidate turn is held open until the
 * train has travelled `confirmDistance` further and can be judged on whether it
 * retraced itself.
 */
export class TrainPath {
  readonly #opts: Required<LineInferenceOptions>;
  readonly #points: Point[] = [];
  /** Indices in #points where the train turned around. */
  readonly #reversals: number[] = [];

  #lastHeading: number | null = null;
  #startHeading: number | null = null;
  #maxFromStart = 0;
  #result: ReconstructedPath | null = null;
  /** A sharp turn awaiting confirmation, as an index into #points. */
  #pending: number | null = null;
  /**
   * Where the loop looked closed while a sharp turn was still being judged. The
   * verdict on that turn decides whether it really was a loop.
   */
  #pendingClose: number | null = null;

  constructor(options: LineInferenceOptions = {}) {
    this.#opts = { ...DEFAULTS, ...options };
  }

  /** The reconstructed path, or null while the train is still being watched. */
  get result(): ReconstructedPath | null {
    return this.#result;
  }

  /** Points collected so far, for debugging and for the trails overlay. */
  get points(): readonly Point[] {
    return this.#points;
  }

  /** How many times the train has been seen to turn around. */
  get reversals(): number {
    return this.#reversals.length;
  }

  /**
   * Feeds one observation. `speed` is used only to ignore headings reported
   * while a train is standing still, which are stale.
   */
  add(x: number, y: number, heading: number, speed = 1): void {
    if (this.#result !== null) return;

    const p = { x, y };
    const last = this.#points[this.#points.length - 1];

    if (last === undefined) {
      this.#points.push(p);
      this.#lastHeading = heading;
      if (speed > 0) this.#startHeading = heading;
      return;
    }
    if (this.#startHeading === null && speed > 0) this.#startHeading = heading;
    if (dist(p, last) < this.#opts.step) return;

    // A stationary train reports whatever heading it last had, so only trust
    // the heading of a train that is actually moving.
    if (speed > 0 && this.#lastHeading !== null) {
      const turn = Math.abs(headingDelta(this.#lastHeading, heading));
      if (turn >= this.#opts.reversalDegrees && this.#pending === null) {
        this.#pending = this.#points.length - 1;
      }
      this.#lastHeading = heading;
    } else if (this.#lastHeading === null) {
      this.#lastHeading = heading;
    }

    this.#points.push(p);

    const start = this.#points[0];
    if (start !== undefined) {
      const fromStart = dist(p, start);
      if (fromStart > this.#maxFromStart) this.#maxFromStart = fromStart;
    }

    this.#judgePending();
    this.#tryClose();
  }

  /**
   * Decides whether the pending sharp turn was a reversal, once the train has
   * gone far enough past it to tell.
   */
  #judgePending(): void {
    const at = this.#pending;
    if (at === null) return;

    const { confirmDistance, retraceTolerance } = this.#opts;
    const after = this.#span(at, 1, confirmDistance);
    // Not enough new track yet to judge; keep waiting.
    if (after === null) return;

    const before = this.#span(at, -1, confirmDistance);
    this.#pending = null;

    // A reversal means the track after the turn lies on the track before it.
    if (before !== null && this.#retraces(after, before, retraceTolerance)) {
      this.#reversals.push(at);
      // The train is a shuttle, so a loop it appeared to close was the hairpin
      // fooling us.
      this.#pendingClose = null;
      return;
    }

    // It was only a corner, so a loop closure held back by it now stands.
    const close = this.#pendingClose;
    this.#pendingClose = null;
    if (close !== null) this.#closeLoop(close);
  }

  /** Does the path after a turn run back over the path before it? */
  #retraces(
    after: { from: number; to: number },
    before: { from: number; to: number },
    tolerance: number,
  ): boolean {
    const beforePath = this.#points.slice(before.from, before.to + 1);
    for (let i = after.from; i <= after.to; i++) {
      const p = this.#points[i];
      if (p === undefined) continue;
      if (distToPath(p, beforePath) > tolerance) return false;
    }
    return true;
  }

  /**
   * Walks `distance` along the path from `at` in `dir`, returning the index
   * range covered, or null if the path does not reach that far yet.
   */
  #span(at: number, dir: 1 | -1, distance: number): { from: number; to: number } | null {
    let travelled = 0;
    let i = at;
    while (travelled < distance) {
      const next = i + dir;
      const a = this.#points[i];
      const b = this.#points[next];
      if (a === undefined || b === undefined) return null;
      travelled += dist(a, b);
      i = next;
    }
    return dir > 0 ? { from: at, to: i } : { from: i, to: at };
  }

  #tryClose(): void {
    // Two reversals bracket a shuttle's full extent: the train has now reached
    // both ends, so everything between them is the whole line.
    if (this.#reversals.length >= 2) {
      const a = this.#reversals[0];
      const b = this.#reversals[1];
      if (a !== undefined && b !== undefined && b > a) {
        this.#result = { kind: "shuttle", points: this.#points.slice(a, b + 1) };
      }
      return;
    }
    // A train that has ever reversed is a shuttle, never a loop, even if it
    // happens to pass back through where it was first seen.
    if (this.#reversals.length > 0) return;

    const start = this.#points[0];
    const current = this.#points[this.#points.length - 1];
    if (start === undefined || current === undefined || this.#points.length < 8) return;

    const tol = this.#opts.tolerance;
    // It must have genuinely gone somewhere before coming back.
    if (this.#maxFromStart < 4 * tol) return;
    if (pathLength(this.#points) < this.#opts.minLoopLength) return;
    if (dist(current, start) > tol) return;

    // Being back where it started is not enough. The two legs of a hairpin run
    // within a few units of each other for a while, so a train that rounded one
    // shortly after being first seen passes the distance test while heading the
    // other way. A loop closes only if it is also pointing the way it first was.
    if (this.#startHeading === null || this.#lastHeading === null) return;
    if (Math.abs(headingDelta(this.#startHeading, this.#lastHeading)) > this.#opts.closureDegrees) {
      return;
    }

    // A sharp turn may still be under judgement. Remember that the loop looked
    // closed here rather than discarding it: a train whose starting point sits
    // just past a hairpin would otherwise be blocked on every single lap.
    if (this.#pending !== null) {
      this.#pendingClose ??= this.#points.length - 1;
      return;
    }
    this.#closeLoop(this.#points.length - 1);
  }

  /**
   * Finishes a loop at `end`, dropping that last point: it duplicates the start,
   * and the closing segment is implied.
   */
  #closeLoop(end: number): void {
    if (this.#result !== null) return;
    this.#result = { kind: "loop", points: this.#points.slice(0, end) };
  }
}

/** Do two reconstructed paths describe the same line? */
export function pathsMatch(a: ReconstructedPath, b: ReconstructedPath, tolerance: number): boolean {
  if (a.kind !== b.kind) return false;
  const closedA = a.kind === "loop";
  const closedB = b.kind === "loop";

  // Every point of each path must lie on the other. Checking both directions
  // stops a short path from matching a long one it happens to sit on.
  return (
    maxDistanceToPath(a.points, b.points, closedB) <= tolerance &&
    maxDistanceToPath(b.points, a.points, closedA) <= tolerance
  );
}

/** Largest distance from any point of `points` to `path`. */
function maxDistanceToPath(
  points: readonly Point[],
  path: readonly Point[],
  closed: boolean,
): number {
  let worst = 0;
  for (const p of points) {
    const d = distToPath(p, path, closed);
    if (d > worst) worst = d;
    // Bail out early once it is clearly not a match.
    if (worst === Infinity) return worst;
  }
  return worst;
}

/**
 * Watches every train and groups the paths it reconstructs into lines.
 */
export class LineInference {
  readonly #opts: Required<LineInferenceOptions>;
  readonly #paths = new Map<string, TrainPath>();
  readonly #lines: InferredLine[] = [];
  /** Which line each train ended up on. */
  readonly #assignment = new Map<string, string>();

  constructor(options: LineInferenceOptions = {}) {
    this.#opts = { ...DEFAULTS, ...options };
  }

  /** The lines reconstructed so far. */
  get lines(): readonly InferredLine[] {
    return this.#lines;
  }

  /** The line a train belongs to, if one is known yet. */
  lineOf(trainId: string): string | null {
    return this.#assignment.get(trainId) ?? null;
  }

  /** Number of trains still being watched. */
  get watching(): number {
    let n = 0;
    for (const [id, path] of this.#paths) {
      if (path.result === null && !this.#assignment.has(id)) n++;
    }
    return n;
  }

  /**
   * Feeds one update. Returns the line id if this update completed the train's
   * reconstruction, otherwise null.
   */
  observe(trainId: string, x: number, y: number, heading: number, speed: number): string | null {
    if (this.#assignment.has(trainId)) return null;

    let path = this.#paths.get(trainId);
    if (path === undefined) {
      path = new TrainPath(this.#opts);
      this.#paths.set(trainId, path);
    }

    path.add(x, y, heading, speed);
    const result = path.result;
    if (result === null) return null;

    const lineId = this.#assign(trainId, result);
    this.#assignment.set(trainId, lineId);
    return lineId;
  }

  /** Puts a completed path on a matching line, or opens a new one. */
  #assign(trainId: string, result: ReconstructedPath): string {
    for (const line of this.#lines) {
      if (pathsMatch(result, { kind: line.kind, points: line.points }, this.#opts.tolerance)) {
        line.trainIds.push(trainId);
        // Keep the longer reconstruction: it is the better description of the
        // line, especially for a shuttle seen from a mid-track start.
        if (result.points.length > line.points.length) line.points = result.points;
        return line.id;
      }
    }

    const line: InferredLine = {
      id: `inferred-${this.#lines.length}`,
      kind: result.kind,
      points: result.points,
      trainIds: [trainId],
      colorIndex: this.#lines.length,
    };
    this.#lines.push(line);
    return line.id;
  }

  /** Forgets everything, e.g. on reconnect with a different world. */
  reset(): void {
    this.#paths.clear();
    this.#lines.length = 0;
    this.#assignment.clear();
  }
}
