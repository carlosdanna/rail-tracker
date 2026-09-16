/**
 * World-relative tuning.
 *
 * Every threshold the client infers with is a distance in world units, and they
 * were tuned against the default 1000x1000 world: a trail records a point every
 * 4 units, two paths are the same line if they stay within 18, a stop clusters
 * within 20. On a 200,000-unit map those same numbers are meaningless — a train
 * crosses 18 units between two updates — so the client would record nothing but
 * noise and reconstruct nothing at all.
 *
 * The server tells the client how big the world is in the `hello` frame, so the
 * thresholds are derived from that instead of baked in. A world of
 * REFERENCE_SPAN across reproduces the tuned values exactly.
 */
import type { TrailOptions } from "./store/trails";
import type { LineInferenceOptions } from "./infer/lines";
import type { StationInferenceOptions } from "./infer/stations";

/** The world size the thresholds below were tuned against. */
export const REFERENCE_SPAN = 1000;

export interface Bounds {
  w: number;
  h: number;
}

/**
 * How much bigger this world is than the reference one. The shorter side sets
 * it, so a long thin world is tuned for the dimension that constrains it.
 */
export function worldScale(bounds: Bounds): number {
  const span = Math.min(bounds.w, bounds.h);
  if (!Number.isFinite(span) || span <= 0) return 1;
  return span / REFERENCE_SPAN;
}

/**
 * Trail thinning. `delta` is an angle and `cap` a count, so neither scales;
 * only the movement threshold does.
 */
export function trailOptionsFor(scale: number): TrailOptions {
  return { epsilon: 4 * scale };
}

/**
 * Line reconstruction. The angles (`reversalDegrees`, `closureDegrees`) and the
 * point budget (`maxPoints`) are scale-free; every length scales.
 */
export function lineOptionsFor(scale: number): LineInferenceOptions {
  return {
    step: 3 * scale,
    tolerance: 18 * scale,
    confirmDistance: 150 * scale,
    retraceTolerance: 5 * scale,
    minLoopLength: 120 * scale,
  };
}

/**
 * Station clustering. `speedEpsilon` scales too: the server scales train speed
 * with the world, so "stopped" has to be judged in the same units.
 */
export function stationOptionsFor(scale: number): StationInferenceOptions {
  return {
    radius: 20 * scale,
    speedEpsilon: 0.5 * scale,
  };
}
