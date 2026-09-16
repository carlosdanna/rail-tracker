/**
 * The columnar form updates take when they cross from the worker to the main
 * thread. One array per field keeps the transfer to seven buffers regardless of
 * how many trains moved, and lets the main thread walk them without allocating.
 */
export interface UpdateArrays {
  /** The `n` in `T-<n>`. */
  index: Uint16Array;
  x: Float32Array;
  y: Float32Array;
  /** Degrees, 0 = north, clockwise. */
  heading: Float32Array;
  speed: Float32Array;
  /** 0 running, 1 at_station, 255 hidden — the binary protocol's codes. */
  state: Uint8Array;
  seq: Uint32Array;
}

/** Allocates a set of arrays with room for `capacity` updates. */
export function allocArrays(capacity: number): UpdateArrays {
  return {
    index: new Uint16Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    heading: new Float32Array(capacity),
    speed: new Float32Array(capacity),
    state: new Uint8Array(capacity),
    seq: new Uint32Array(capacity),
  };
}

/** The buffers to hand to `postMessage` as transferables. */
export function transferables(a: UpdateArrays): ArrayBuffer[] {
  return [
    a.index.buffer as ArrayBuffer,
    a.x.buffer as ArrayBuffer,
    a.y.buffer as ArrayBuffer,
    a.heading.buffer as ArrayBuffer,
    a.speed.buffer as ArrayBuffer,
    a.state.buffer as ArrayBuffer,
    a.seq.buffer as ArrayBuffer,
  ];
}

/** How many updates a set of arrays can hold. */
export function capacityOf(a: UpdateArrays): number {
  return a.index.length;
}

/**
 * A pool of array sets.
 *
 * Transferring a buffer detaches it, so the worker cannot simply keep reusing
 * one set: the main thread posts each set back once it has read it, and the
 * pool hands it out again. In steady state that makes the hot path
 * allocation-free in both directions.
 */
export class ArrayPool {
  readonly #free: UpdateArrays[] = [];
  readonly #maxIdle: number;

  constructor(maxIdle = 4) {
    this.#maxIdle = maxIdle;
  }

  /** Returns a set with room for at least `capacity` updates. */
  acquire(capacity: number): UpdateArrays {
    for (let i = 0; i < this.#free.length; i++) {
      const candidate = this.#free[i];
      if (candidate !== undefined && capacityOf(candidate) >= capacity) {
        this.#free.splice(i, 1);
        return candidate;
      }
    }
    // Round up so a slowly growing train count does not reallocate every flush.
    return allocArrays(Math.max(64, 1 << Math.ceil(Math.log2(capacity))));
  }

  /** Takes a set back. Detached sets (already transferred) are ignored. */
  release(arrays: UpdateArrays): void {
    if (capacityOf(arrays) === 0) return;
    if (this.#free.length >= this.#maxIdle) return;
    this.#free.push(arrays);
  }

  /** Number of sets currently idle, for tests. */
  get size(): number {
    return this.#free.length;
  }
}
