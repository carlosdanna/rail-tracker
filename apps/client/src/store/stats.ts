/**
 * Rolling counters for the HUD: ingest rate, render rate, drops and latency.
 * Rates are measured over a sliding window rather than since start, so the
 * readout tracks what is happening now.
 */

/** A rate measured over a sliding time window. */
export class RateMeter {
  readonly #windowMs: number;
  /** Alternating (timestamp, count) pairs, oldest first. */
  readonly #samples: { at: number; n: number }[] = [];
  #total = 0;

  constructor(windowMs = 1000) {
    this.#windowMs = windowMs;
  }

  /** Records `n` events at `now` (ms). */
  add(n: number, now: number = performance.now()): void {
    if (n > 0) {
      this.#samples.push({ at: now, n });
      this.#total += n;
    }
    this.#trim(now);
  }

  /** Events per second over the window. */
  rate(now: number = performance.now()): number {
    this.#trim(now);
    if (this.#samples.length === 0) return 0;
    let sum = 0;
    for (const s of this.#samples) sum += s.n;
    return (sum * 1000) / this.#windowMs;
  }

  /** Every event recorded since construction. */
  get total(): number {
    return this.#total;
  }

  #trim(now: number): void {
    const cutoff = now - this.#windowMs;
    let drop = 0;
    while (drop < this.#samples.length && (this.#samples[drop]?.at ?? 0) < cutoff) drop++;
    if (drop > 0) this.#samples.splice(0, drop);
  }
}

/** Everything the HUD shows. */
export interface StatsSnapshot {
  /** Updates per second arriving from the server. */
  msgsPerSec: number;
  /** Updates the server dropped for us, from `seq` gaps. */
  dropped: number;
  /** Number of `seq` discontinuities. */
  gaps: number;
  /** Rendered frames per second. */
  fps: number;
  /** Trains seen at least once. */
  trains: number;
  /** Round-trip latency in ms from the most recent ping. */
  latencyMs: number;
  /** Bytes per second arriving. */
  bytesPerSec: number;
  /** Updates received in total. */
  totalUpdates: number;
}

export class Stats {
  readonly #msgs = new RateMeter(1000);
  readonly #bytes = new RateMeter(1000);
  readonly #frames = new RateMeter(1000);

  #dropped = 0;
  #gaps = 0;
  #trains = 0;
  #latencyMs = 0;
  #totalUpdates = 0;

  /** Records a flush from the worker. Counters from the worker are absolute. */
  recordIngest(
    updatesDelta: number,
    bytesDelta: number,
    totals: { dropped: number; gaps: number; updates: number },
    now: number = performance.now(),
  ): void {
    this.#msgs.add(updatesDelta, now);
    this.#bytes.add(bytesDelta, now);
    this.#dropped = totals.dropped;
    this.#gaps = totals.gaps;
    this.#totalUpdates = totals.updates;
  }

  /** Records one rendered frame. */
  recordFrame(now: number = performance.now()): void {
    this.#frames.add(1, now);
  }

  /** Records the number of distinct trains the store knows about. */
  setTrains(n: number): void {
    this.#trains = n;
  }

  /** Records a completed ping round trip. */
  recordLatency(ms: number): void {
    this.#latencyMs = ms;
  }

  snapshot(now: number = performance.now()): StatsSnapshot {
    return {
      msgsPerSec: Math.round(this.#msgs.rate(now)),
      dropped: this.#dropped,
      gaps: this.#gaps,
      fps: Math.round(this.#frames.rate(now)),
      trains: this.#trains,
      latencyMs: Math.round(this.#latencyMs),
      bytesPerSec: Math.round(this.#bytes.rate(now)),
      totalUpdates: this.#totalUpdates,
    };
  }
}
