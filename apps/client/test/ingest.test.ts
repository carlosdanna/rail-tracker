import { describe, expect, it } from "vitest";
import { parseBinaryBatch, parseJsonBatch } from "../src/protocol";
import type { Batch, TrainUpdate } from "../src/protocol";
import { ArrayPool, allocArrays, capacityOf, transferables } from "../src/worker/arrays";
import { Ingest, stateCode, stateFromCode } from "../src/worker/ingest";
import { readBinary, readText } from "./fixtures";

/** Builds a batch from terse tuples, filling in the boring fields. */
function batch(t: number, updates: Partial<TrainUpdate>[]): Batch {
  return {
    t,
    updates: updates.map((u, i) => ({
      seq: u.seq ?? i,
      index: u.index ?? 0,
      id: u.id ?? `T-${u.index ?? 0}`,
      x: u.x ?? 0,
      y: u.y ?? 0,
      heading: u.heading ?? 0,
      speed: u.speed ?? 0,
      state: u.state ?? "running",
    })),
  };
}

describe("gap counting", () => {
  it("counts nothing when seq is contiguous", () => {
    const ing = new Ingest();
    ing.add(
      batch(1, [
        { seq: 10, index: 0 },
        { seq: 11, index: 1 },
      ]),
    );
    ing.add(
      batch(2, [
        { seq: 12, index: 0 },
        { seq: 13, index: 1 },
      ]),
    );
    expect(ing.stats.gaps).toBe(0);
    expect(ing.stats.dropped).toBe(0);
    expect(ing.stats.updates).toBe(4);
    expect(ing.stats.frames).toBe(2);
  });

  it("counts a gap and the updates it hides", () => {
    const ing = new Ingest();
    ing.add(batch(1, [{ seq: 1, index: 0 }]));
    // seq 2-5 never arrived: one gap, four updates missing.
    ing.add(batch(2, [{ seq: 6, index: 1 }]));
    expect(ing.stats.gaps).toBe(1);
    expect(ing.stats.dropped).toBe(4);
  });

  it("counts several gaps separately", () => {
    const ing = new Ingest();
    ing.add(
      batch(1, [
        { seq: 1, index: 0 },
        { seq: 4, index: 1 },
        { seq: 5, index: 2 },
      ]),
    );
    ing.add(batch(2, [{ seq: 9, index: 0 }]));
    expect(ing.stats.gaps).toBe(2);
    expect(ing.stats.dropped).toBe(2 + 3);
  });

  it("does not count the first update as a gap", () => {
    const ing = new Ingest();
    ing.add(batch(1, [{ seq: 99_999, index: 0 }]));
    expect(ing.stats.gaps).toBe(0);
  });

  it("ignores a backwards seq in the dropped total but still counts the gap", () => {
    const ing = new Ingest();
    ing.add(batch(1, [{ seq: 10, index: 0 }]));
    ing.add(batch(2, [{ seq: 4, index: 0 }]));
    expect(ing.stats.gaps).toBe(1);
    expect(ing.stats.dropped).toBe(0);
  });

  it("starts counting again after resetSequence", () => {
    const ing = new Ingest();
    ing.add(batch(1, [{ seq: 100, index: 0 }]));
    ing.resetSequence();
    ing.add(batch(2, [{ seq: 1, index: 0 }]));
    expect(ing.stats.gaps).toBe(0);
  });
});

describe("coalescing", () => {
  it("keeps only the latest update per train", () => {
    const ing = new Ingest();
    ing.add(
      batch(1, [
        { seq: 1, index: 0, x: 1 },
        { seq: 2, index: 1, x: 10 },
      ]),
    );
    ing.add(
      batch(2, [
        { seq: 3, index: 0, x: 2 },
        { seq: 4, index: 0, x: 3 },
      ]),
    );
    expect(ing.pending).toBe(2);

    const flush = ing.drain();
    expect(flush).not.toBeNull();
    if (flush === null) return;

    expect(flush.count).toBe(2);
    expect(flush.t).toBe(2);
    // Train 0 collapsed to its newest position; train 1 kept its only one.
    const byIndex = new Map<number, number>();
    for (let i = 0; i < flush.count; i++) {
      byIndex.set(flush.arrays.index[i] ?? -1, flush.arrays.x[i] ?? -1);
    }
    expect(byIndex.get(0)).toBe(3);
    expect(byIndex.get(1)).toBe(10);
    // All four updates still counted, even though only two were flushed.
    expect(flush.stats.updates).toBe(4);
  });

  it("returns null when nothing has arrived", () => {
    const ing = new Ingest();
    expect(ing.drain()).toBeNull();
    ing.add(batch(1, [{ seq: 1, index: 0 }]));
    expect(ing.drain()).not.toBeNull();
    expect(ing.drain()).toBeNull();
  });

  it("skips updates whose id is not T-<n>", () => {
    const ing = new Ingest();
    ing.add(batch(1, [{ seq: 1, index: -1, id: "weird" }]));
    expect(ing.stats.malformed).toBe(1);
    expect(ing.stats.updates).toBe(1);
    expect(ing.drain()).toBeNull();
  });

  it("round-trips every field through the columnar arrays", () => {
    const ing = new Ingest();
    ing.add(
      batch(7, [
        { seq: 5, index: 3, x: 1.5, y: 2.5, heading: 135, speed: 4.25, state: "at_station" },
      ]),
    );
    const flush = ing.drain();
    expect(flush).not.toBeNull();
    if (flush === null) return;

    expect(flush.arrays.index[0]).toBe(3);
    expect(flush.arrays.x[0]).toBe(1.5);
    expect(flush.arrays.y[0]).toBe(2.5);
    expect(flush.arrays.heading[0]).toBe(135);
    expect(flush.arrays.speed[0]).toBe(4.25);
    expect(stateFromCode(flush.arrays.state[0] ?? 0)).toBe("at_station");
    expect(flush.arrays.seq[0]).toBe(5);
  });

  it("accepts both fixture formats and coalesces them together", () => {
    const ing = new Ingest();
    ing.add(parseJsonBatch(readText("batch.json")));
    ing.add(parseBinaryBatch(readBinary("batch.bin")));

    // The same eight trains twice, so one entry each.
    expect(ing.pending).toBe(8);
    expect(ing.stats.updates).toBe(16);
    // Both fixtures start at seq 1000, so replaying them looks like a rewind.
    expect(ing.stats.gaps).toBe(1);
  });
});

describe("state codes", () => {
  it("round-trip through the binary codes", () => {
    for (const state of ["running", "at_station", "unknown"] as const) {
      expect(stateFromCode(stateCode(state))).toBe(state);
    }
    expect(stateCode("running")).toBe(0);
    expect(stateCode("at_station")).toBe(1);
    expect(stateCode("unknown")).toBe(255);
  });
});

describe("array pool", () => {
  it("reuses a released set that is large enough", () => {
    const pool = new ArrayPool();
    const first = pool.acquire(10);
    pool.release(first);
    expect(pool.size).toBe(1);
    expect(pool.acquire(10)).toBe(first);
    expect(pool.size).toBe(0);
  });

  it("allocates a bigger set when the pooled one is too small", () => {
    const pool = new ArrayPool();
    const small = pool.acquire(8);
    pool.release(small);
    const big = pool.acquire(5000);
    expect(big).not.toBe(small);
    expect(capacityOf(big)).toBeGreaterThanOrEqual(5000);
  });

  it("rounds capacity up so a growing fleet does not reallocate every flush", () => {
    const pool = new ArrayPool();
    expect(capacityOf(pool.acquire(1))).toBe(64);
    expect(capacityOf(pool.acquire(100))).toBe(128);
    expect(capacityOf(pool.acquire(500))).toBe(512);
  });

  it("caps how many idle sets it holds", () => {
    const pool = new ArrayPool(2);
    for (let i = 0; i < 5; i++) pool.release(allocArrays(16));
    expect(pool.size).toBe(2);
  });

  it("ignores a detached set", () => {
    const pool = new ArrayPool();
    const arrays = allocArrays(0);
    pool.release(arrays);
    expect(pool.size).toBe(0);
  });

  it("lists exactly the seven buffers to transfer", () => {
    const arrays = allocArrays(4);
    const list = transferables(arrays);
    expect(list).toHaveLength(7);
    expect(new Set(list).size).toBe(7);
  });

  it("recycles arrays back into the ingest pool", () => {
    const pool = new ArrayPool();
    const ing = new Ingest(pool);
    ing.add(batch(1, [{ seq: 1, index: 0 }]));
    const flush = ing.drain();
    expect(flush).not.toBeNull();
    if (flush === null) return;

    ing.recycle(flush.arrays);
    ing.add(batch(2, [{ seq: 2, index: 0 }]));
    const second = ing.drain();
    expect(second?.arrays).toBe(flush.arrays);
  });
});
