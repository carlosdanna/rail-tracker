import { describe, expect, it } from "vitest";
import {
  REFERENCE_SPAN,
  lineOptionsFor,
  stationOptionsFor,
  trailOptionsFor,
  worldScale,
} from "../src/scale";
import { LineInference, TrainPath } from "../src/infer/lines";
import type { LineInferenceOptions } from "../src/infer/lines";
import { StationInference } from "../src/infer/stations";
import { TrailStore } from "../src/store/trails";
import type { TrailOptions } from "../src/store/trails";
import { line, simulate } from "./synthsim";
import type { Point } from "../src/infer/geometry";

describe("worldScale", () => {
  it("is 1 for the world the thresholds were tuned against", () => {
    expect(worldScale({ w: REFERENCE_SPAN, h: REFERENCE_SPAN })).toBe(1);
  });

  it("grows with the world", () => {
    expect(worldScale({ w: 100_000, h: 100_000 })).toBe(100);
    expect(worldScale({ w: 200_000, h: 200_000 })).toBe(200);
    expect(worldScale({ w: 500, h: 500 })).toBe(0.5);
  });

  it("takes the shorter side of a non-square world", () => {
    expect(worldScale({ w: 100_000, h: 2000 })).toBe(2);
  });

  it("falls back to 1 rather than producing nonsense thresholds", () => {
    expect(worldScale({ w: 0, h: 0 })).toBe(1);
    expect(worldScale({ w: Number.NaN, h: 1000 })).toBe(1);
    expect(worldScale({ w: -5, h: -5 })).toBe(1);
  });
});

describe("scaled options", () => {
  it("reproduce the tuned defaults at scale 1", () => {
    // These are the values the detectors were tuned to; a change here should be
    // a deliberate retune, not a side effect of the scaling work.
    expect(trailOptionsFor(1)).toEqual({ epsilon: 4 });
    expect(lineOptionsFor(1)).toEqual({
      step: 3,
      tolerance: 18,
      confirmDistance: 150,
      retraceTolerance: 5,
      minLoopLength: 120,
    });
    expect(stationOptionsFor(1)).toEqual({ radius: 20, speedEpsilon: 0.5 });
  });

  it("scale every length in proportion", () => {
    const opts = lineOptionsFor(200);
    expect(opts.step).toBe(600);
    expect(opts.tolerance).toBe(3600);
    expect(opts.confirmDistance).toBe(30_000);
    expect(opts.retraceTolerance).toBe(1000);
    expect(opts.minLoopLength).toBe(24_000);
    expect(stationOptionsFor(200)).toEqual({ radius: 4000, speedEpsilon: 100 });
    expect(trailOptionsFor(200)).toEqual({ epsilon: 800 });
  });

  it("leave angles and counts alone", () => {
    // A reversal is 150 degrees whatever the map measures, and the point budget
    // is about memory, not geometry.
    const trails = new TrailStore(trailOptionsFor(200));
    expect(trails.options.delta).toBe(8);
    expect(trails.options.cap).toBe(512);
    const stations = new StationInference(stationOptionsFor(200));
    expect(stations.options.minConsecutive).toBe(3);
  });
});

/**
 * The point of the scaling: the same network reconstructs identically whatever
 * units it is expressed in.
 */
describe("reconstruction is scale-invariant", () => {
  const SQUARE: Point[] = [
    { x: 200, y: 200 },
    { x: 600, y: 200 },
    { x: 600, y: 600 },
    { x: 200, y: 600 },
  ];

  /** Runs one loop line at `scale`, with speed scaled the way the server does. */
  function reconstruct(scale: number): { lines: number; stations: number; kind: string } {
    const stops = SQUARE.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    const shape = line("loop", stops);
    const updates = simulate({
      line: shape,
      duration: 200,
      speed: 30 * scale,
      dwell: 3,
      interval: 0.1,
    });

    const lines = new LineInference(lineOptionsFor(scale));
    const stations = new StationInference(stationOptionsFor(scale));
    for (const u of updates) {
      lines.observe(u.id, u.x, u.y, u.heading, u.speed);
      stations.observe(u.id, u.x, u.y, u.speed, u.state);
    }
    return {
      lines: lines.lines.length,
      stations: stations.stations().length,
      kind: lines.lines[0]?.kind ?? "none",
    };
  }

  for (const scale of [1, 10, 100, 200, 1000]) {
    it(`works on a ${String(1000 * scale)}-unit world`, () => {
      expect(reconstruct(scale)).toEqual({ lines: 1, stations: 4, kind: "loop" });
    });
  }

  it("thins the evidence it keeps, which unscaled thresholds do not", () => {
    // A threshold only discriminates at the size it was tuned for. On a
    // 200,000-unit world a train crosses the unscaled 4-unit trail epsilon
    // between every pair of updates, so nothing is thinned: the trail records
    // everything, overruns its cap, and the reconstruction path holds three
    // times the points it needs.
    const scale = 200;
    const stops = SQUARE.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    const updates = simulate({
      line: line("loop", stops),
      duration: 200,
      speed: 30 * scale,
      dwell: 3,
      interval: 0.1,
    });

    const measure = (
      trailOpts: TrailOptions,
      lineOpts: LineInferenceOptions,
    ): { appended: number; evicted: number; pathPoints: number } => {
      const trails = new TrailStore(trailOpts);
      const path = new TrainPath(lineOpts);
      let appended = 0;
      for (const u of updates) {
        if (trails.append("T-0", u.x, u.y, u.heading)) appended++;
        path.add(u.x, u.y, u.heading, u.speed);
      }
      return {
        appended,
        evicted: trails.evicted("T-0"),
        pathPoints: path.points.length,
      };
    };

    const unscaled = measure({}, {});
    const scaled = measure(trailOptionsFor(scale), lineOptionsFor(scale));

    expect(unscaled.appended).toBeGreaterThan(scaled.appended * 1.5);
    expect(unscaled.evicted).toBeGreaterThan(scaled.evicted * 3);
    expect(unscaled.pathPoints).toBeGreaterThan(scaled.pathPoints * 2.5);
  });
});
