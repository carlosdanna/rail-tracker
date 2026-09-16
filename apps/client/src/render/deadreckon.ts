/**
 * Dead reckoning between updates.
 *
 * Updates for any one train arrive at `rate / trains` per second, which at low
 * rates is well below the frame rate. Extrapolating along the reported heading
 * keeps motion smooth, but only for a short horizon: past that the guess is
 * worse than standing still, and a train that has actually stopped at a station
 * would otherwise sail straight through it.
 */

export interface Reckonable {
  x: number;
  y: number;
  /** Degrees, 0 = north, clockwise. */
  heading: number;
  speed: number;
  /** Client clock (ms) when the update was applied. */
  updatedAt: number;
}

export interface ReckonOptions {
  /** Never extrapolate further ahead than this, in ms. */
  horizonMs?: number;
}

const DEFAULT_HORIZON_MS = 250;

/**
 * Returns where a train probably is now. `now` is the client clock in ms.
 */
export function reckon(
  train: Reckonable,
  now: number,
  options: ReckonOptions = {},
): { x: number; y: number } {
  const horizon = options.horizonMs ?? DEFAULT_HORIZON_MS;
  if (train.speed <= 0) return { x: train.x, y: train.y };

  const age = now - train.updatedAt;
  if (age <= 0) return { x: train.x, y: train.y };

  const dt = Math.min(age, horizon) / 1000;
  const distance = train.speed * dt;
  // 0 = north = −Y, angles increase clockwise.
  const rad = (train.heading * Math.PI) / 180;
  return {
    x: train.x + Math.sin(rad) * distance,
    y: train.y - Math.cos(rad) * distance,
  };
}
