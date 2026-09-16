/**
 * A miniature of the Go simulation, used to build synthetic update streams for
 * the inference tests. It follows the same rules as spec §1: constant speed
 * along a track polyline, dwell at stations only, shuttles reverse at the ends,
 * loops wrap, and waypoints are passed through without stopping.
 */
import type { TrainState, TrainUpdate } from "../src/protocol";

export interface Point {
  x: number;
  y: number;
}

export interface SynthLine {
  kind: "loop" | "shuttle";
  /** The polyline. For a loop the closing segment is implied, not repeated. */
  track: Point[];
  /** Indices into `track` that are stations; the rest are waypoints. */
  stopIndices: number[];
}

export interface SynthOptions {
  line: SynthLine;
  /** World units per second. */
  speed?: number;
  /** Seconds a train waits at each station. */
  dwell?: number;
  /** Seconds between emitted updates for this train. */
  interval?: number;
  /** How long to run, in seconds. */
  duration: number;
  /** Where on the track the train starts, as a fraction of total length. */
  startFraction?: number;
  /** Train id to stamp on the updates. */
  trainId?: string;
  /** Omit the state field, as `--hide-state` does. */
  hideState?: boolean;
  /** First sequence number. */
  startSeq?: number;
}

/** A shuttle line through the given stations with optional bowed waypoints. */
export function line(
  kind: "loop" | "shuttle",
  stops: Point[],
  waypointsPerGap: number[] = [],
): SynthLine {
  const track: Point[] = [];
  const stopIndices: number[] = [];
  const gaps = kind === "loop" ? stops.length : stops.length - 1;

  for (let g = 0; g < gaps; g++) {
    const from = stops[g];
    const to = stops[(g + 1) % stops.length];
    if (from === undefined || to === undefined) continue;

    stopIndices.push(track.length);
    track.push(from);

    const n = waypointsPerGap[g] ?? 0;
    if (n <= 0) continue;

    // Bow the gap to one side so the waypoints are real heading changes.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const px = -dy / len;
    const py = dx / len;
    const amp = len * 0.2;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      const bulge = amp * Math.sin(Math.PI * t);
      track.push({ x: from.x + dx * t + px * bulge, y: from.y + dy * t + py * bulge });
    }
  }

  if (kind === "shuttle") {
    const last = stops[stops.length - 1];
    if (last !== undefined) {
      stopIndices.push(track.length);
      track.push(last);
    }
  }
  return { kind, track, stopIndices };
}

/** Heading in degrees where 0 is north (−Y) and angles increase clockwise. */
export function headingOf(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function segments(l: SynthLine): number {
  return l.kind === "loop" ? l.track.length : l.track.length - 1;
}

function segmentEnds(l: SynthLine, i: number): [Point, Point] {
  const a = l.track[i];
  const b = l.track[(i + 1) % l.track.length];
  if (a === undefined || b === undefined) throw new Error(`bad segment ${i}`);
  return [a, b];
}

function segmentLength(l: SynthLine, i: number): number {
  const [a, b] = segmentEnds(l, i);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Runs one train and returns the updates it would have produced. */
export function simulate(opts: SynthOptions): TrainUpdate[] {
  const {
    line: l,
    speed = 20,
    dwell = 3,
    interval = 0.1,
    duration,
    startFraction = 0,
    trainId = "T-0",
    hideState = false,
    startSeq = 1,
  } = opts;

  const nSeg = segments(l);
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < nSeg; i++) {
    const len = segmentLength(l, i);
    lengths.push(len);
    total += len;
  }

  // Place the train at its starting offset along the track.
  let seg = 0;
  let progress = 0;
  let remainingOffset = startFraction * total;
  while (seg < nSeg - 1 && remainingOffset >= (lengths[seg] ?? 0)) {
    remainingOffset -= lengths[seg] ?? 0;
    seg++;
  }
  progress = remainingOffset;

  let dir: 1 | -1 = 1;
  let dwellLeft = 0;

  const stopSet = new Set(l.stopIndices);
  const updates: TrainUpdate[] = [];
  let seq = startSeq;
  const steps = Math.round(duration / interval);

  for (let step = 0; step < steps; step++) {
    let time = interval;

    // Burn the dwell first, then move with whatever time is left.
    if (dwellLeft > 0) {
      const used = Math.min(dwellLeft, time);
      dwellLeft -= used;
      time -= used;
    }

    let guard = 0;
    while (time > 1e-12 && guard++ < 1000) {
      const segLen = lengths[seg] ?? 0;
      const toEnd = dir > 0 ? segLen - progress : progress;
      const step2 = speed * time;

      if (step2 < toEnd) {
        progress += dir * step2;
        time = 0;
        break;
      }

      time -= toEnd / speed;

      // Which track vertex has the train just reached?
      const vertex = dir > 0 ? (seg + 1) % l.track.length : seg;

      let reversed = false;
      if (l.kind === "shuttle") {
        if (dir > 0 && seg === nSeg - 1) {
          dir = -1;
          progress = lengths[seg] ?? 0;
          reversed = true;
        } else if (dir < 0 && seg === 0) {
          dir = 1;
          progress = 0;
          reversed = true;
        }
      }
      if (!reversed) {
        if (dir > 0) {
          seg = (seg + 1) % nSeg;
          progress = 0;
        } else {
          seg = seg === 0 ? nSeg - 1 : seg - 1;
          progress = lengths[seg] ?? 0;
        }
      }

      // Stations dwell; waypoints do not.
      if (stopSet.has(vertex) && dwell > 0) {
        dwellLeft = dwell;
        const used = Math.min(dwellLeft, time);
        dwellLeft -= used;
        time -= used;
      }
    }

    const [a, b] = segmentEnds(l, seg);
    const segLen = lengths[seg] ?? 1;
    const f = segLen > 0 ? progress / segLen : 0;
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    const heading = headingOf((b.x - a.x) * dir, (b.y - a.y) * dir);

    const running = dwellLeft <= 0;
    const state: TrainState = hideState ? "unknown" : running ? "running" : "at_station";

    updates.push({
      seq: seq++,
      index: Number(trainId.slice(2)) || 0,
      id: trainId,
      x,
      y,
      heading,
      speed: running ? speed : 0,
      state,
    });
  }

  return updates;
}
