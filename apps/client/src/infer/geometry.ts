/** Small 2D helpers shared by the line and station inference. */
import type { Point } from "../store/trails";

export type { Point };

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance from p to the segment ab. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);

  // Projection of ap onto ab, clamped to the segment.
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Distance from p to a polyline. When `closed` is true the segment from the
 * last point back to the first is included, which is what a loop line needs.
 */
export function distToPath(p: Point, path: readonly Point[], closed = false): number {
  if (path.length === 0) return Infinity;
  const first = path[0];
  if (first === undefined) return Infinity;
  if (path.length === 1) return dist(p, first);

  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a === undefined || b === undefined) continue;
    const d = distToSegment(p, a, b);
    if (d < best) best = d;
  }
  if (closed) {
    const last = path[path.length - 1];
    if (last !== undefined) {
      const d = distToSegment(p, last, first);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Total length of a polyline. */
export function pathLength(path: readonly Point[], closed = false): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a !== undefined && b !== undefined) total += dist(a, b);
  }
  if (closed && path.length > 1) {
    const first = path[0];
    const last = path[path.length - 1];
    if (first !== undefined && last !== undefined) total += dist(last, first);
  }
  return total;
}

/** Axis-aligned bounding box of a set of points. */
export function bbox(points: readonly Point[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}
