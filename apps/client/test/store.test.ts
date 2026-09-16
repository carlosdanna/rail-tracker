import { describe, expect, it } from "vitest";
import { Store } from "../src/store/store";
import { TrailStore, headingDelta } from "../src/store/trails";
import { RateMeter, Stats } from "../src/store/stats";
import { allocArrays } from "../src/worker/arrays";
import type { UpdateArrays } from "../src/worker/arrays";

/** Builds a one-entry flush for the store. */
function arraysFor(
  entries: {
    index: number;
    x: number;
    y: number;
    heading?: number;
    speed?: number;
    state?: number;
    seq?: number;
  }[],
): UpdateArrays {
  const a = allocArrays(Math.max(1, entries.length));
  entries.forEach((e, i) => {
    a.index[i] = e.index;
    a.x[i] = e.x;
    a.y[i] = e.y;
    a.heading[i] = e.heading ?? 0;
    a.speed[i] = e.speed ?? 0;
    a.state[i] = e.state ?? 0;
    a.seq[i] = e.seq ?? i;
  });
  return a;
}

describe("trail thinning", () => {
  it("always records the first point", () => {
    const trails = new TrailStore();
    expect(trails.append("T-0", 10, 10, 0)).toBe(true);
    expect(trails.points("T-0")).toEqual([{ x: 10, y: 10 }]);
  });

  it("ignores movement below epsilon with an unchanged heading", () => {
    const trails = new TrailStore({ epsilon: 5, delta: 10 });
    trails.append("T-0", 0, 0, 90);
    expect(trails.append("T-0", 2, 0, 90)).toBe(false);
    expect(trails.append("T-0", 4.9, 0, 90)).toBe(false);
    expect(trails.points("T-0")).toHaveLength(1);
  });

  it("records once the train has moved more than epsilon", () => {
    const trails = new TrailStore({ epsilon: 5, delta: 10 });
    trails.append("T-0", 0, 0, 90);
    expect(trails.append("T-0", 6, 0, 90)).toBe(true);
    expect(trails.points("T-0")).toHaveLength(2);
  });

  it("records a turn even when the train has barely moved", () => {
    const trails = new TrailStore({ epsilon: 5, delta: 10 });
    trails.append("T-0", 0, 0, 90);
    expect(trails.append("T-0", 1, 0, 130)).toBe(true);
    expect(trails.points("T-0")).toHaveLength(2);
  });

  it("measures turns across the 0/360 wrap", () => {
    const trails = new TrailStore({ epsilon: 100, delta: 10 });
    trails.append("T-0", 0, 0, 355);
    // 5 degrees clockwise, below delta despite the numeric jump.
    expect(trails.append("T-0", 1, 0, 0)).toBe(false);
    // 20 degrees, above delta.
    expect(trails.append("T-0", 2, 0, 15)).toBe(true);
  });

  it("enforces the hard cap by dropping the oldest points", () => {
    const trails = new TrailStore({ epsilon: 0, delta: 0, cap: 10 });
    for (let i = 0; i < 100; i++) trails.append("T-0", i, 0, 0);
    const points = trails.points("T-0");
    expect(points).toHaveLength(10);
    expect(points[points.length - 1]).toEqual({ x: 99, y: 0 });
    expect(trails.evicted("T-0")).toBe(90);
  });

  it("stops appending once the trail is frozen", () => {
    const trails = new TrailStore({ epsilon: 0, delta: 0 });
    trails.append("T-0", 0, 0, 0);
    trails.append("T-0", 50, 0, 0);
    trails.freeze("T-0");

    expect(trails.append("T-0", 100, 0, 0)).toBe(false);
    expect(trails.points("T-0")).toHaveLength(2);
    expect(trails.isFrozen("T-0")).toBe(true);

    trails.unfreeze("T-0");
    expect(trails.append("T-0", 150, 0, 0)).toBe(true);
  });

  it("tracks totals and clears", () => {
    const trails = new TrailStore({ epsilon: 0, delta: 0 });
    trails.append("T-0", 0, 0, 0);
    trails.append("T-0", 9, 0, 0);
    trails.append("T-1", 0, 0, 0);
    expect(trails.size).toBe(2);
    expect(trails.totalPoints()).toBe(3);

    trails.clear("T-0");
    expect(trails.size).toBe(1);
    trails.clearAll();
    expect(trails.size).toBe(0);
    expect(trails.points("T-0")).toEqual([]);
  });
});

describe("headingDelta", () => {
  it("returns the shortest signed turn", () => {
    expect(headingDelta(0, 10)).toBe(10);
    expect(headingDelta(10, 0)).toBe(-10);
    expect(headingDelta(350, 10)).toBe(20);
    expect(headingDelta(10, 350)).toBe(-20);
    expect(headingDelta(0, 180)).toBe(180);
    expect(Math.abs(headingDelta(0, 181))).toBe(179);
  });
});

describe("store", () => {
  it("records the latest state per train", () => {
    const store = new Store();
    store.applyArrays(arraysFor([{ index: 0, x: 1, y: 2, heading: 90, speed: 5, seq: 1 }]), 1, 100);
    store.applyArrays(
      arraysFor([{ index: 0, x: 3, y: 4, heading: 180, speed: 6, seq: 2 }]),
      1,
      200,
    );

    const train = store.get("T-0");
    expect(train).toBeDefined();
    expect(train?.x).toBe(3);
    expect(train?.y).toBe(4);
    expect(train?.heading).toBe(180);
    expect(train?.speed).toBe(6);
    expect(train?.seq).toBe(2);
    expect(train?.updatedAt).toBe(200);
    expect(store.size).toBe(1);
  });

  it("maps state codes onto the normalised state", () => {
    const store = new Store();
    store.applyArrays(
      arraysFor([
        { index: 0, x: 0, y: 0, state: 0 },
        { index: 1, x: 0, y: 0, state: 1 },
        { index: 2, x: 0, y: 0, state: 255 },
      ]),
      3,
      0,
    );
    expect(store.get("T-0")?.state).toBe("running");
    expect(store.get("T-1")?.state).toBe("at_station");
    expect(store.get("T-2")?.state).toBe("unknown");
  });

  it("builds trails as updates arrive and freezes them on line assignment", () => {
    const store = new Store({ trail: { epsilon: 1, delta: 5, cap: 100 } });
    for (let i = 0; i < 10; i++) {
      store.applyArrays(arraysFor([{ index: 0, x: i * 10, y: 0 }]), 1, i);
    }
    expect(store.trail("T-0")).toHaveLength(10);

    store.assignLine("T-0", "inferred-1");
    expect(store.get("T-0")?.lineId).toBe("inferred-1");

    store.applyArrays(arraysFor([{ index: 0, x: 500, y: 0 }]), 1, 100);
    expect(store.trail("T-0")).toHaveLength(10);
    // The position still updates; only the trail is frozen.
    expect(store.get("T-0")?.x).toBe(500);
  });

  it("resets everything", () => {
    const store = new Store();
    store.applyArrays(arraysFor([{ index: 0, x: 1, y: 1 }]), 1, 0);
    store.reset();
    expect(store.size).toBe(0);
    expect(store.trail("T-0")).toEqual([]);
  });

  it("only reads the first `count` entries of an oversized array", () => {
    const store = new Store();
    const arrays = arraysFor([
      { index: 0, x: 1, y: 1 },
      { index: 1, x: 2, y: 2 },
      { index: 2, x: 3, y: 3 },
    ]);
    store.applyArrays(arrays, 2, 0);
    expect(store.size).toBe(2);
    expect(store.get("T-2")).toBeUndefined();
  });
});

describe("stats", () => {
  it("measures a rate over a sliding window", () => {
    const meter = new RateMeter(1000);
    meter.add(100, 0);
    meter.add(100, 500);
    expect(meter.rate(999)).toBe(200);
    // The first sample falls out of the window.
    expect(meter.rate(1200)).toBe(100);
    expect(meter.rate(2000)).toBe(0);
    expect(meter.total).toBe(200);
  });

  it("summarises what the HUD shows", () => {
    const stats = new Stats();
    stats.recordIngest(500, 4096, { dropped: 12, gaps: 3, updates: 500 }, 0);
    stats.setTrains(42);
    stats.recordLatency(7.4);
    for (let i = 0; i < 60; i++) stats.recordFrame(i * 16);

    const snap = stats.snapshot(900);
    expect(snap.msgsPerSec).toBe(500);
    expect(snap.dropped).toBe(12);
    expect(snap.gaps).toBe(3);
    expect(snap.trains).toBe(42);
    expect(snap.latencyMs).toBe(7);
    expect(snap.fps).toBe(60);
    expect(snap.totalUpdates).toBe(500);
    expect(snap.bytesPerSec).toBe(4096);
  });
});
