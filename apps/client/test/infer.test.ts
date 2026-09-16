import { describe, expect, it } from "vitest";
import { LineInference, TrainPath, pathsMatch } from "../src/infer/lines";
import { StationInference } from "../src/infer/stations";
import { distToPath, pathLength } from "../src/infer/geometry";
import type { Point } from "../src/infer/geometry";
import { line, simulate } from "./synthsim";
import type { SynthLine } from "./synthsim";

const SQUARE: Point[] = [
  { x: 200, y: 200 },
  { x: 600, y: 200 },
  { x: 600, y: 600 },
  { x: 200, y: 600 },
];

const STRAIGHT: Point[] = [
  { x: 100, y: 500 },
  { x: 400, y: 500 },
  { x: 800, y: 500 },
];

/** Feeds a whole update stream through both inference passes. */
function run(
  updates: ReturnType<typeof simulate>,
  lines = new LineInference(),
  stations = new StationInference(),
): { lines: LineInference; stations: StationInference } {
  for (const u of updates) {
    lines.observe(u.id, u.x, u.y, u.heading, u.speed);
    stations.observe(u.id, u.x, u.y, u.speed, u.state);
  }
  return { lines, stations };
}

/** Largest distance from the reference stops to the reconstructed path. */
function worstStopError(path: readonly Point[], closed: boolean, stops: Point[]): number {
  let worst = 0;
  for (const s of stops) {
    const d = distToPath(s, path, closed);
    if (d > worst) worst = d;
  }
  return worst;
}

describe("loop lines", () => {
  const loop: SynthLine = line("loop", SQUARE);

  it("reconstructs the loop after one full cycle", () => {
    const updates = simulate({ line: loop, duration: 120, speed: 30, dwell: 2 });
    const { lines } = run(updates);

    expect(lines.lines).toHaveLength(1);
    const inferred = lines.lines[0];
    expect(inferred).toBeDefined();
    if (inferred === undefined) return;

    expect(inferred.kind).toBe("loop");
    expect(inferred.trainIds).toEqual(["T-0"]);
    expect(lines.lineOf("T-0")).toBe(inferred.id);

    // The reconstruction passes through every real station and is about the
    // right length: the square is 1600 units around.
    expect(worstStopError(inferred.points, true, SQUARE)).toBeLessThan(15);
    expect(pathLength(inferred.points, true)).toBeGreaterThan(1500);
    expect(pathLength(inferred.points, true)).toBeLessThan(1700);
  });

  it("does not report a line before the loop closes", () => {
    // A quarter of the way round is not enough.
    const updates = simulate({ line: loop, duration: 12, speed: 30, dwell: 2 });
    const { lines } = run(updates);
    expect(lines.lines).toHaveLength(0);
    expect(lines.lineOf("T-0")).toBeNull();
  });

  it("groups several trains on the same loop into one line", () => {
    const inference = new LineInference();
    for (let i = 0; i < 4; i++) {
      const updates = simulate({
        line: loop,
        duration: 140,
        speed: 30,
        dwell: 2,
        startFraction: i / 4,
        trainId: `T-${i}`,
      });
      for (const u of updates) inference.observe(u.id, u.x, u.y, u.heading, u.speed);
    }
    expect(inference.lines).toHaveLength(1);
    expect(inference.lines[0]?.trainIds.sort()).toEqual(["T-0", "T-1", "T-2", "T-3"]);
  });

  it("keeps two different loops apart", () => {
    const other = line("loop", [
      { x: 700, y: 100 },
      { x: 950, y: 100 },
      { x: 950, y: 350 },
      { x: 700, y: 350 },
    ]);
    const inference = new LineInference();
    for (const u of simulate({ line: loop, duration: 120, speed: 30, dwell: 2, trainId: "T-0" })) {
      inference.observe(u.id, u.x, u.y, u.heading, u.speed);
    }
    for (const u of simulate({ line: other, duration: 120, speed: 30, dwell: 2, trainId: "T-1" })) {
      inference.observe(u.id, u.x, u.y, u.heading, u.speed);
    }
    expect(inference.lines).toHaveLength(2);
  });
});

describe("shuttle lines", () => {
  const shuttle: SynthLine = line("shuttle", STRAIGHT);

  it("reconstructs the shuttle once it has turned round at both ends", () => {
    const updates = simulate({ line: shuttle, duration: 160, speed: 30, dwell: 2 });
    const { lines } = run(updates);

    expect(lines.lines).toHaveLength(1);
    const inferred = lines.lines[0];
    expect(inferred).toBeDefined();
    if (inferred === undefined) return;

    expect(inferred.kind).toBe("shuttle");
    expect(worstStopError(inferred.points, false, STRAIGHT)).toBeLessThan(15);
    // The full run is 700 units end to end.
    expect(pathLength(inferred.points)).toBeGreaterThan(650);
    expect(pathLength(inferred.points)).toBeLessThan(760);
  });

  it("does not mistake a shuttle for a loop when it starts mid-track", () => {
    // Starting in the middle, the train passes back through its start point,
    // which would look like a closed loop to a naive detector.
    const updates = simulate({
      line: shuttle,
      duration: 200,
      speed: 30,
      dwell: 2,
      startFraction: 0.5,
    });
    const { lines } = run(updates);
    expect(lines.lines[0]?.kind).toBe("shuttle");
  });

  it("groups trains running the same shuttle from different offsets", () => {
    const inference = new LineInference();
    for (let i = 0; i < 3; i++) {
      const updates = simulate({
        line: shuttle,
        duration: 220,
        speed: 30,
        dwell: 2,
        startFraction: i / 3,
        trainId: `T-${i}`,
      });
      for (const u of updates) inference.observe(u.id, u.x, u.y, u.heading, u.speed);
    }
    expect(inference.lines).toHaveLength(1);
    expect(inference.lines[0]?.trainIds).toHaveLength(3);
  });

  it("never reports a loop for a train that has reversed", () => {
    const path = new TrainPath();
    // Out and back along a straight line.
    for (let x = 0; x <= 300; x += 10) path.add(x, 0, 90, 10);
    for (let x = 300; x >= 0; x -= 10) path.add(x, 0, 270, 10);
    expect(path.result).toBeNull(); // only one reversal so far
    expect(path.reversals).toBe(1);

    for (let x = 0; x <= 300; x += 10) path.add(x, 0, 90, 10);
    expect(path.result?.kind).toBe("shuttle");
  });
});

describe("waypoints", () => {
  // Two stations with three bowed waypoints between them: plenty of heading
  // changes, but the train never stops there.
  const withWaypoints: SynthLine = line("shuttle", STRAIGHT, [3, 3]);

  it("does not turn waypoints into stations", () => {
    const updates = simulate({ line: withWaypoints, duration: 200, speed: 30, dwell: 3 });
    const { stations } = run(updates);

    const found = stations.stations();
    expect(found).toHaveLength(STRAIGHT.length);
    for (const s of STRAIGHT) {
      const nearest = Math.min(...found.map((f) => Math.hypot(f.x - s.x, f.y - s.y)));
      expect(nearest).toBeLessThan(10);
    }

    // And none of the waypoint positions became a station.
    for (const p of withWaypoints.track) {
      const isStop = withWaypoints.stopIndices.some((i) => withWaypoints.track[i] === p);
      if (isStop) continue;
      const nearest = Math.min(...found.map((f) => Math.hypot(f.x - p.x, f.y - p.y)));
      expect(nearest).toBeGreaterThan(10);
    }
  });

  it("still reconstructs the line through the waypoints", () => {
    const updates = simulate({ line: withWaypoints, duration: 220, speed: 30, dwell: 3 });
    const { lines } = run(updates);
    expect(lines.lines).toHaveLength(1);
    expect(lines.lines[0]?.kind).toBe("shuttle");
    // The bowed track is longer than the straight 700 units between the ends.
    expect(pathLength(lines.lines[0]?.points ?? [])).toBeGreaterThan(700);
  });
});

describe("stations", () => {
  it("clusters the stops of several trains onto one station each", () => {
    const loop = line("loop", SQUARE);
    const stations = new StationInference();
    for (let i = 0; i < 4; i++) {
      const updates = simulate({
        line: loop,
        duration: 140,
        speed: 30,
        dwell: 2,
        startFraction: i / 4,
        trainId: `T-${i}`,
      });
      for (const u of updates) stations.observe(u.id, u.x, u.y, u.speed, u.state);
    }

    const found = stations.stations();
    expect(found).toHaveLength(SQUARE.length);
    for (const s of found) {
      expect(s.trains).toBeGreaterThan(0);
      expect(s.stops).toBeGreaterThan(0);
    }
  });

  it("ignores a single slow update in hide-state mode", () => {
    const stations = new StationInference({ minConsecutive: 3 });
    // Two slow updates then away again: not a stop.
    stations.observe("T-0", 10, 10, 0, "unknown");
    stations.observe("T-0", 10, 10, 0, "unknown");
    stations.observe("T-0", 20, 10, 30, "unknown");
    expect(stations.stations()).toHaveLength(0);

    stations.observe("T-0", 10, 10, 0, "unknown");
    stations.observe("T-0", 10, 10, 0, "unknown");
    stations.observe("T-0", 10, 10, 0, "unknown");
    expect(stations.stations()).toHaveLength(1);
  });

  it("records one stop per visit, not one per update", () => {
    const stations = new StationInference();
    for (let i = 0; i < 50; i++) stations.observe("T-0", 10, 10, 0, "at_station");
    expect(stations.stations()[0]?.stops).toBe(1);

    // Leave and come back.
    stations.observe("T-0", 100, 10, 30, "running");
    for (let i = 0; i < 50; i++) stations.observe("T-0", 10, 10, 0, "at_station");
    expect(stations.stations()[0]?.stops).toBe(2);
  });

  it("keeps stations that are further apart than the radius separate", () => {
    const stations = new StationInference({ radius: 20 });
    for (let i = 0; i < 3; i++) stations.observe("T-0", 0, 0, 0, "at_station");
    stations.observe("T-0", 500, 0, 30, "running");
    for (let i = 0; i < 3; i++) stations.observe("T-0", 100, 0, 0, "at_station");
    expect(stations.stations()).toHaveLength(2);
  });
});

describe("hide-state mode", () => {
  const loop = line("loop", SQUARE);

  it("infers the same stations from speed alone", () => {
    const visible = run(simulate({ line: loop, duration: 140, speed: 30, dwell: 3 }));
    const hidden = run(
      simulate({ line: loop, duration: 140, speed: 30, dwell: 3, hideState: true }),
    );

    const a = visible.stations.stations();
    const b = hidden.stations.stations();
    expect(b).toHaveLength(a.length);
    expect(b).toHaveLength(SQUARE.length);

    // Each hide-state station matches a visible one closely.
    for (const s of b) {
      const nearest = Math.min(...a.map((v) => Math.hypot(v.x - s.x, v.y - s.y)));
      expect(nearest).toBeLessThan(5);
    }
  });

  it("reconstructs the same line without the state field", () => {
    const hidden = run(
      simulate({ line: loop, duration: 140, speed: 30, dwell: 3, hideState: true }),
    );
    expect(hidden.lines.lines).toHaveLength(1);
    expect(hidden.lines.lines[0]?.kind).toBe("loop");
    expect(worstStopError(hidden.lines.lines[0]?.points ?? [], true, SQUARE)).toBeLessThan(15);
  });

  it("does not invent stations at waypoints in hide-state mode", () => {
    const bowed = line("shuttle", STRAIGHT, [3, 3]);
    const { stations } = run(
      simulate({ line: bowed, duration: 200, speed: 30, dwell: 3, hideState: true }),
    );
    expect(stations.stations()).toHaveLength(STRAIGHT.length);
  });
});

describe("pathsMatch", () => {
  const a = { kind: "loop" as const, points: SQUARE };

  it("matches a path against a slightly noisy copy of itself", () => {
    const noisy = {
      kind: "loop" as const,
      points: SQUARE.map((p, i) => ({ x: p.x + (i % 2 ? 3 : -3), y: p.y + 2 })),
    };
    expect(pathsMatch(a, noisy, 18)).toBe(true);
  });

  it("rejects paths of different kinds", () => {
    expect(pathsMatch(a, { kind: "shuttle", points: SQUARE }, 18)).toBe(false);
  });

  it("rejects a path that is somewhere else", () => {
    const far = { kind: "loop" as const, points: SQUARE.map((p) => ({ x: p.x + 300, y: p.y })) };
    expect(pathsMatch(a, far, 18)).toBe(false);
  });

  it("rejects a short path that merely sits on a longer one", () => {
    const shortRun = {
      kind: "shuttle" as const,
      points: [
        { x: 100, y: 500 },
        { x: 250, y: 500 },
      ],
    };
    const longRun = { kind: "shuttle" as const, points: STRAIGHT };
    expect(pathsMatch(shortRun, longRun, 18)).toBe(false);
  });
});

/**
 * Hairpins are the hard case, and the reason the detectors do more than look at
 * heading. A generated line tours its stations in nearest-neighbour order, which
 * routinely doubles a loop back on itself through more than 170 degrees. Locally
 * that is almost indistinguishable from a shuttle turning round, and the two
 * legs run within a few units of each other for a long way afterwards.
 */
describe("hairpins", () => {
  // A→B east, then B→C almost straight back west: a 176° turn at B.
  const HAIRPIN_LOOP: Point[] = [
    { x: 100, y: 500 },
    { x: 700, y: 500 },
    { x: 120, y: 460 },
  ];
  const loop = line("loop", HAIRPIN_LOOP);

  it("is not mistaken for a shuttle", () => {
    const { lines } = run(simulate({ line: loop, duration: 200, speed: 30, dwell: 2 }));
    expect(lines.lines).toHaveLength(1);
    expect(lines.lines[0]?.kind).toBe("loop");
  });

  it("closes the loop for a train that starts just past the hairpin", () => {
    // The train rounds the hairpin almost immediately, so on every lap it comes
    // back within tolerance of its starting point while the turn is still being
    // judged. That must not stop the loop from ever closing.
    const updates = simulate({
      line: loop,
      duration: 260,
      speed: 30,
      dwell: 2,
      startFraction: 0.506,
    });
    const { lines } = run(updates);
    expect(lines.lineOf("T-0")).not.toBeNull();
    expect(lines.lines[0]?.kind).toBe("loop");
  });

  it("groups hairpin-loop trains from every starting offset onto one line", () => {
    const inference = new LineInference();
    for (let i = 0; i < 6; i++) {
      const updates = simulate({
        line: loop,
        duration: 300,
        speed: 30,
        dwell: 2,
        startFraction: i / 6,
        trainId: `T-${i}`,
      });
      for (const u of updates) inference.observe(u.id, u.x, u.y, u.heading, u.speed);
    }
    expect(inference.lines).toHaveLength(1);
    expect(inference.lines[0]?.kind).toBe("loop");
    expect(inference.lines[0]?.trainIds).toHaveLength(6);
  });

  it("still finds both ends of a shuttle with a hairpin in the middle", () => {
    const bent = line("shuttle", [
      { x: 100, y: 100 },
      { x: 800, y: 120 },
      { x: 120, y: 160 },
    ]);
    const { lines } = run(simulate({ line: bent, duration: 300, speed: 30, dwell: 2 }));
    expect(lines.lines).toHaveLength(1);
    expect(lines.lines[0]?.kind).toBe("shuttle");
    // The full out-and-back run is about 700 + 690 units of track.
    expect(pathLength(lines.lines[0]?.points ?? [])).toBeGreaterThan(1300);
  });

  it("does not invent a station at a hairpin", () => {
    const { stations } = run(simulate({ line: loop, duration: 200, speed: 30, dwell: 2 }));
    expect(stations.stations()).toHaveLength(HAIRPIN_LOOP.length);
  });
});
